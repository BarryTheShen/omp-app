/**
 * The host's UI context (SDK plan H5.2d): omp's `ExtensionUIContext` for extensions and tools, over the protocol, as
 * omp's RPC mode builds it (18.12.6 `modes/rpc/rpc-mode.ts:1030-1276, 1425-1619`).
 * - A dialog is a request to the server, answered with omp's fields. omp's own abort and timeout close it with the
 *   dialog's default and tell the server (`ui_cancel`); an answer after that is dropped.
 * - A call that needs no answer is an event.
 * - What only omp's terminal can draw (components, header and footer, themes, raw input) is not offered.
 */
import {
  type ExtensionApprovalAnswer,
  type ExtensionApprovalPrompt,
  type ExtensionAskDialogQuestion,
  type ExtensionAskDialogResult,
  type ExtensionAskDialogSubmitResult,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  type ExtensionUISelectItem,
  type ExtensionWidgetOptions,
  getExtensionUISelectOptionLabel,
  timedOutAskDialogResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AutocompleteProviderFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import {
  type AskAnswer,
  type ChatHostHostMethod,
  type ChatHostHostMethodMap,
  type ChatHostResponse,
  HOST_METHOD_ANSWERS,
  type SelectDialog,
  type SignInLink,
  type UiEvent,
  type ValueAnswer,
} from "@omp-app/contracts/chat-host";

interface PendingRequest {
  readonly method: ChatHostHostMethod;
  /** What was asked, to ask a server that attaches later again. */
  readonly params: unknown;
  readonly resolve: (answer: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** The host's requests to the server that wait for an answer. */
export class HostRequests {
  readonly #write: (message: object) => boolean;
  readonly #pending = new Map<string, PendingRequest>();
  #next = 0;
  #closed: Error | undefined;

  constructor(write: (message: object) => boolean) {
    this.#write = write;
  }

  /** Sends a request; its answer is checked against the method's answer before omp sees it. */
  send<M extends ChatHostHostMethod>(
    method: M,
    params: ChatHostHostMethodMap[M]["params"],
  ): { readonly id: string; readonly answer: Promise<ChatHostHostMethodMap[M]["result"]> } {
    const id = `host-${++this.#next}`;
    const { promise, resolve, reject } =
      Promise.withResolvers<ChatHostHostMethodMap[M]["result"]>();
    if (this.#closed) {
      reject(this.#closed);
      return { id, answer: promise };
    }
    this.#pending.set(id, {
      method,
      params,
      resolve: resolve as (answer: unknown) => void,
      reject,
    });
    if (!this.#write({ kind: "request", id, method, params })) {
      this.#pending.delete(id);
      reject(new Error("The server's line is closed"));
    }
    return { id, answer: promise };
  }

  /** Forgets a request omp closed itself, so a late answer finds nothing. */
  forget(id: string): void {
    this.#pending.delete(id);
  }

  /**
   * For a server that attaches to the running chat (D2): each request still waiting for an answer goes to it again,
   * under its own id, so the question shows there and its answer reaches omp.
   */
  resend(): void {
    for (const [id, pending] of this.#pending) {
      this.#write({ kind: "request", id, method: pending.method, params: pending.params });
    }
  }

  /** Settles the request a response answers; false when none waits for it. */
  settle(response: ChatHostResponse): boolean {
    const pending = this.#pending.get(response.id);
    if (!pending) return false;
    this.#pending.delete(response.id);
    if (!response.ok) {
      pending.reject(new Error(`The app refused ${pending.method}: ${response.error.message}`));
      return true;
    }
    const answer = HOST_METHOD_ANSWERS[pending.method].safeParse(response.result);
    if (answer.success) pending.resolve(answer.data);
    else pending.reject(new Error(`The app's answer to ${pending.method} is not one omp takes`));
    return true;
  }

  /** Fails every waiting and later request: nobody is left to answer them. */
  closeAll(message: string): void {
    this.#closed ??= new Error(message);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.reject(this.#closed);
  }
}

type DialogOptions = Pick<ExtensionUIDialogOptions, "signal" | "timeout" | "onTimeout">;

/**
 * Opens a dialog on the server. omp's abort or timeout closes it with `fallback` and tells the server, as omp's
 * `requestRpcDialog` does; `read` turns the server's answer into omp's value.
 */
function openDialog<M extends ChatHostHostMethod, T>(
  requests: HostRequests,
  emit: (event: UiEvent) => void,
  method: M,
  params: ChatHostHostMethodMap[M]["params"],
  options: DialogOptions | undefined,
  fallback: T,
  read: (answer: ChatHostHostMethodMap[M]["result"]) => T,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.resolve(fallback);
  const { id, answer } = requests.send(method, params);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopWatching = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", close);
  };
  function close(): void {
    stopWatching();
    requests.forget(id);
    emit({ type: "ui_cancel", requestId: id });
    resolve(fallback);
  }
  signal?.addEventListener("abort", close, { once: true });
  if (options?.timeout !== undefined) {
    timer = setTimeout(() => {
      options.onTimeout?.();
      close();
    }, options.timeout);
  }
  answer.then(
    (value) => {
      stopWatching();
      try {
        resolve(read(value));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    (error: Error) => {
      stopWatching();
      reject(error);
    },
  );
  return promise;
}

/** A select's, input's or editor's text; a dialog the server's own countdown closed calls omp's `onTimeout`. */
const readValue =
  (options: DialogOptions | undefined) =>
  (answer: ValueAnswer): string | undefined => {
    if ("cancelled" in answer) {
      if (answer.timedOut) options?.onTimeout?.();
      return undefined;
    }
    return answer.value;
  };

const timeoutOf = (options: DialogOptions | undefined): { timeout?: number } =>
  options?.timeout !== undefined ? { timeout: options.timeout } : {};

/** The ask dialog's answers, checked against the questions as omp checks them (`rpc-mode.ts:1067-1126`). */
function readAskAnswer(
  answer: AskAnswer,
  questions: readonly ExtensionAskDialogQuestion[],
  options: DialogOptions,
): ExtensionAskDialogSubmitResult | undefined {
  if ("cancelled" in answer) {
    if (answer.timedOut) options.onTimeout?.();
    return undefined;
  }
  if (answer.answers.length !== questions.length) {
    throw new Error(`Ask dialog response must carry ${questions.length} answers in question order`);
  }
  return {
    kind: "submit",
    results: questions.map((question, index) => {
      const given = answer.answers[index];
      if (given?.id !== question.id) {
        throw new Error(`Ask dialog answer ${index} must have id ${JSON.stringify(question.id)}`);
      }
      const labels = question.options.map((option) => option.label);
      const multi = question.multi ?? false;
      const selected: string[] = [];
      for (const label of given.selectedOptions) {
        if (!labels.includes(label)) {
          throw new Error(
            `Ask dialog answer ${JSON.stringify(question.id)} selected unknown option ${JSON.stringify(label)}`,
          );
        }
        if (selected.includes(label)) {
          throw new Error(
            `Ask dialog answer ${JSON.stringify(question.id)} selected ${JSON.stringify(label)} twice`,
          );
        }
        selected.push(label);
      }
      const custom = given.customInput?.trim() || undefined;
      if (!multi && (selected.length > 1 || (selected.length > 0 && custom !== undefined))) {
        throw new Error(
          `Ask dialog answer ${JSON.stringify(question.id)} is single-select but carries more than one answer`,
        );
      }
      const note = given.note?.trim() || undefined;
      return {
        id: question.id,
        question: question.question,
        options: labels,
        multi,
        selectedOptions: selected,
        customInput: custom,
        ...(note === undefined ? {} : { note }),
      };
    }),
  };
}

export class HostUIContext implements ExtensionUIContext {
  readonly supportsEditor = true;
  /** Set by `set_ask_dialog`. Off, omp asks with selects and editors. */
  askDialogEnabled = false;
  readonly #requests: HostRequests;
  readonly #emit: (event: UiEvent) => void;
  /** The statuses, widgets and title on show, by key, for a server that attaches later (`shown`, D2). */
  readonly #shown = new Map<string, UiEvent>();

  constructor(requests: HostRequests, emit: (event: UiEvent) => void) {
    this.#requests = requests;
    this.#emit = emit;
  }

  /** What extensions put on show and did not clear: statuses, widgets, the title, as their last events said. */
  shown(): readonly UiEvent[] {
    return [...this.#shown.values()];
  }

  /** Emits a UI state event and keeps it on show under `key`, or forgets the key when the event clears it. */
  #show(key: string, event: UiEvent, cleared: boolean): void {
    if (cleared) this.#shown.delete(key);
    else this.#shown.set(key, event);
    this.#emit(event);
  }

  get askDialog(): ExtensionUIContext["askDialog"] {
    if (!this.askDialogEnabled) return undefined;
    return (questions, options) => this.#ask(questions, options);
  }

  select(
    title: string,
    options: ExtensionUISelectItem[],
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    const descriptions = options.map((option) =>
      typeof option === "string" ? undefined : option.description?.trim() || undefined,
    );
    const params: SelectDialog = {
      title,
      options: options.map(getExtensionUISelectOptionLabel),
      ...(descriptions.some((description) => description !== undefined)
        ? { optionDetails: descriptions.map((description) => (description ? { description } : {})) }
        : {}),
      ...(dialogOptions?.initialIndex !== undefined
        ? { initialIndex: dialogOptions.initialIndex }
        : {}),
      ...timeoutOf(dialogOptions),
    };
    return openDialog(
      this.#requests,
      this.#emit,
      "ui.select",
      params,
      dialogOptions,
      undefined,
      readValue(dialogOptions),
    );
  }

  confirm(
    title: string,
    message: string,
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    return openDialog(
      this.#requests,
      this.#emit,
      "ui.confirm",
      { title, message, ...timeoutOf(dialogOptions) },
      dialogOptions,
      false,
      (answer) => {
        if ("cancelled" in answer) {
          if (answer.timedOut) dialogOptions?.onTimeout?.();
          return false;
        }
        return answer.confirmed;
      },
    );
  }

  /** omp's text question; `extra.signIn` is the app's own: a sign-in's page, shown with the question (#2784). */
  input(
    title: string,
    placeholder?: string,
    dialogOptions?: ExtensionUIDialogOptions,
    extra?: { readonly signIn?: SignInLink },
  ): Promise<string | undefined> {
    return openDialog(
      this.#requests,
      this.#emit,
      "ui.input",
      {
        title,
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...timeoutOf(dialogOptions),
        ...(extra?.signIn !== undefined ? { signIn: extra.signIn } : {}),
      },
      dialogOptions,
      undefined,
      readValue(dialogOptions),
    );
  }

  /** As omp's RPC editor: only an abort closes it; it has no timeout. */
  editor(
    title: string,
    prefill?: string,
    dialogOptions?: ExtensionUIDialogOptions,
    editorOptions?: { promptStyle?: boolean },
  ): Promise<string | undefined> {
    return openDialog(
      this.#requests,
      this.#emit,
      "ui.editor",
      {
        title,
        ...(prefill !== undefined ? { prefill } : {}),
        ...(editorOptions?.promptStyle !== undefined
          ? { promptStyle: editorOptions.promptStyle }
          : {}),
      },
      dialogOptions?.signal ? { signal: dialogOptions.signal } : undefined,
      undefined,
      (answer) => ("cancelled" in answer ? undefined : answer.value),
    );
  }

  /** A tool approval with omp's own choices; anything but an answer is `deny`, and omp checks the answer again. */
  approve(
    prompt: ExtensionApprovalPrompt,
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<ExtensionApprovalAnswer> {
    return openDialog(
      this.#requests,
      this.#emit,
      "ui.approve",
      { prompt, ...timeoutOf(dialogOptions) },
      dialogOptions,
      "deny" as ExtensionApprovalAnswer,
      (answer) => answer,
    );
  }

  /** All questions in one dialog; a timeout answers each with its recommended option, as omp's does. */
  async #ask(
    questions: ExtensionAskDialogQuestion[],
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<ExtensionAskDialogResult | undefined> {
    let timedOut = false;
    const options: DialogOptions = {
      ...dialogOptions,
      onTimeout: () => {
        timedOut = true;
        dialogOptions?.onTimeout?.();
      },
    };
    const result = await openDialog(
      this.#requests,
      this.#emit,
      "ui.ask",
      { questions, ...timeoutOf(dialogOptions) },
      options,
      undefined,
      (answer) => readAskAnswer(answer, questions, options),
    );
    return timedOut ? timedOutAskDialogResult(questions) : result;
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.#emit({ type: "ui_notify", message, ...(type ? { notifyType: type } : {}) });
  }

  setStatus(key: string, text: string | undefined): void {
    this.#show(
      `status:${key}`,
      { type: "ui_status", statusKey: key, ...(text !== undefined ? { statusText: text } : {}) },
      !text,
    );
  }

  /** Lines only; a widget that is a component stays terminal-only, as in omp's RPC mode. */
  setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    if (content !== undefined && !Array.isArray(content)) return;
    const lines = content as string[] | undefined;
    this.#show(
      `widget:${key}`,
      {
        type: "ui_widget",
        widgetKey: key,
        ...(lines !== undefined ? { widgetLines: lines } : {}),
        ...(options?.placement !== undefined ? { widgetPlacement: options.placement } : {}),
      },
      !lines?.length,
    );
  }

  setTitle(title: string): void {
    this.#show("title", { type: "ui_title", title }, false);
  }

  setEditorText(text: string): void {
    this.#emit({ type: "ui_editor_text", text });
  }

  pasteToEditor(text: string): void {
    this.setEditorText(text);
  }

  /** The composer lives in the app; omp cannot read it synchronously, as in its RPC mode. */
  getEditorText(): string {
    return "";
  }

  onTerminalInput(): () => void {
    return () => {};
  }

  setWorkingMessage(): void {}

  setFooter(): void {}

  setHeader(): void {}

  async custom(): Promise<never> {
    return undefined as never;
  }

  /** Extensions' providers for the box's menus, in the order added; asked by `extension_completions` (`completions.ts`). */
  readonly completionProviders: AutocompleteProviderFactory[] = [];

  addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
    this.completionProviders.push(factory);
  }

  setEditorComponent(): void {}

  getEditorComponent(): undefined {
    return undefined;
  }

  get theme(): Theme {
    return theme;
  }

  getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
    return Promise.resolve([]);
  }

  getTheme(): Promise<Theme | undefined> {
    return Promise.resolve(undefined);
  }

  setTheme(): Promise<{ success: boolean; error?: string }> {
    return Promise.resolve({ success: false, error: "Themes are not switched from the app" });
  }

  getToolsExpanded(): boolean {
    return false;
  }

  setToolsExpanded(): void {}
}

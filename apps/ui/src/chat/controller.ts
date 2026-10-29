import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  AppFailure,
  type ChatSessionClient,
  type ChatSessionEvent,
  ChatSessionPort,
  type EntryId,
  type FileSearchCandidate,
  FileSearchPort,
  type FolderPath,
  type SessionFilePath,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import {
  type ChatHostCommand,
  type ChatHostImage,
  type ChatHostMethod,
  type ChatHostMethodMap,
  type HostDialogAnswer,
  isHostDialogRequest,
  type QueueName,
} from "@omp-app/contracts/chat-host";
import { ChatDraft } from "./drafts";
import { type ChatModel, ChatStore, toChatModel } from "./store";
import type { ShellRun } from "./triggers";
import { cachedWindow, keepWindow } from "./windowCache";

/** The first window read from a session file: enough for the newest screens, small enough to parse at once. */
export const FIRST_WINDOW_BYTES = 512 * 1024;
const OLDER_WINDOW_BYTES = 1024 * 1024;

export type ChatTarget =
  | {
      readonly kind: "existing";
      readonly threadId: ThreadId;
      readonly sessionFile: SessionFilePath;
    }
  | { readonly kind: "new"; readonly folder: FolderPath };

/**
 * One open chat: its store, its chat host and its event stream. Opening paints the newest entries of the session file
 * before omp is up, then starts or joins the chat's host and follows its events, asking for streaming deltas.
 */
export class ChatController {
  readonly store = new ChatStore();
  #threadId: ThreadId | null;
  #sessionFile: SessionFilePath | null;
  #subscription: AppClientSubscription<ChatSessionEvent> | null = null;
  #loadingOlder = false;
  #draft: ChatDraft | null;
  #disposed = false;
  /**
   * Where the transcript's branch ends after an edit rewound the chat: an entry, or null for the chat's very start.
   * Undefined while the branch ends at the file's last entry, as it does again once omp writes the next turn.
   */
  #leaf: string | null | undefined = undefined;
  /** Whether the file's window has been read: what this browser kept is shown only until then. */
  #windowRead = false;
  /**
   * Whether this pane's open took a view of the chat: the server counts it until it is closed, and stops omp once nobody
   * views the chat and its idle time has passed.
   */
  #viewTaken = false;
  /** Events before the subscription is acknowledged are the server's replay: history, not new requests. */
  #live = false;
  #commands: Promise<readonly ChatHostCommand[]> | null = null;
  readonly #stopResync: () => void;
  private readonly client: AppClient;
  private readonly target: ChatTarget;
  /** The folder the chat works in: `@` mentions search it, and a new chat's welcome names it. */
  readonly folder: FolderPath;

  constructor(client: AppClient, target: ChatTarget, folder: FolderPath) {
    this.client = client;
    this.target = target;
    this.folder = folder;
    this.#threadId = target.kind === "existing" ? target.threadId : null;
    this.#sessionFile = target.kind === "existing" ? target.sessionFile : null;
    this.#draft = target.kind === "existing" ? new ChatDraft(client, target.threadId) : null;
    // A gap in the event stream: the file holds what was missed.
    this.#stopResync = client.onResync((event) => {
      if (event.stream === this.#subscription?.stream) this.#refreshWindow();
    });
  }

  /** The chat's unsent text; null until a new chat has its id. */
  get draft(): ChatDraft | null {
    return this.#draft;
  }

  get threadId(): ThreadId | null {
    return this.#threadId;
  }

  /** The chat's session file once omp named it; a new chat's is named when it opens, and written with omp's first reply. */
  get sessionFile(): SessionFilePath | null {
    return this.#sessionFile;
  }

  /** A chat started here from nothing (New chat), as against a saved one opened again. */
  get isNew(): boolean {
    return this.target.kind === "new";
  }

  /** Opens the chat for this pane. A failure is said in the transcript; a pane that went away meanwhile says nothing. */
  async open(): Promise<void> {
    try {
      await this.#open();
    } catch (failure) {
      if (this.#disposed) return;
      this.store.addNotice(
        `Could not open this chat: ${failure instanceof Error ? failure.message : String(failure)}`,
        "error",
      );
      this.store.setPhase("ended");
    }
  }

  async #open(): Promise<void> {
    if (this.#sessionFile !== null) {
      // A chat opened before shows what this browser kept of it at once; the file's window replaces it when it comes.
      const fromFile = this.#reloadWindow();
      const threadId = this.#threadId;
      const kept = threadId === null ? undefined : await cachedWindow(threadId);
      if (kept !== undefined && !this.#windowRead && !this.#disposed)
        this.store.setWindow(kept.entries, kept.hasOlder);
      await fromFile;
    }
    const chat = this.client.port(ChatSessionPort);
    const opened = await chat.open(
      this.target.kind === "existing"
        ? { threadId: this.target.threadId }
        : { folderPath: this.target.folder, start: "new" },
    );
    this.#viewTaken = true;
    if (this.#disposed) {
      await this.#releaseView(opened.threadId);
      return;
    }
    this.#threadId = opened.threadId;
    this.#draft ??= new ChatDraft(this.client, opened.threadId);
    this.#sessionFile = opened.sessionFile;
    this.#subscription = await this.client.subscribe(ChatSessionPort, "event", {
      scope: opened.threadId,
      afterSeq: 0,
      onEvent: (payload) => this.#onEvent(payload),
    });
    if (this.#disposed) {
      await this.#subscription.unsubscribe();
      return;
    }
    this.#live = true;
    await chat.setEventOptions({ threadId: opened.threadId, messageUpdates: "delta" });
    // omp's ask tool then sends all its questions in one request, with their checkboxes and typed answers; without
    // it, omp asks each question as a plain choice, which still works.
    await this.#request("set_ask_dialog", { enabled: true }).catch(() => undefined);
    await this.#refreshState();
    const open = await chat.openRequests({ threadId: opened.threadId });
    if (this.#disposed) return;
    this.store.restoreRequests(open.map((item) => item.request).filter(isHostDialogRequest));
    this.store.setPhase("live");
  }

  /** Sends a message: a new prompt, or while omp works, a steer (`followUp` queues it behind the turn). */
  async send(
    text: string,
    mode: "auto" | "followUp" = "auto",
    images: readonly ChatHostImage[] = [],
  ): Promise<void> {
    const working = this.store.getSnapshot().working;
    await this.#request("prompt", {
      text,
      ...(images.length > 0 ? { images: [...images] } : {}),
      ...(working ? { streamingBehavior: mode === "followUp" ? "followUp" : "steer" } : {}),
    });
  }

  /**
   * Edit: rewinds the chat to just before one of your messages, as omp's tree does, and returns the message's text and
   * images for the box; the transcript shows the chat up to that point. Sending starts a new branch there; the old one
   * stays in the session.
   */
  async rewind(
    entryId: string,
  ): Promise<{ readonly text: string; readonly images: readonly ChatHostImage[] } | null> {
    const result = await this.#request("navigate_tree", { entryId });
    if (result.cancelled) return null;
    this.#leaf = result.leafId;
    await this.#reloadWindow();
    return { text: result.editorText ?? "", images: result.editorImages ?? [] };
  }

  /** Stops the reply as omp's Escape does: every queued message comes back, in order, for the message box. */
  async stop(): Promise<readonly string[]> {
    if (this.#threadId === null) return [];
    const restored = await this.#request("abort_and_restore_queue", {});
    return [...restored.steering, ...restored.followUp].map((message) => message.text);
  }

  /** Takes a queued message back out of its queue; null when omp already delivered it. */
  async takeQueued(message: string, queue: QueueName): Promise<string | null> {
    const result = await this.#request("remove_queued_message", { message, queue });
    return result.removed ? result.text : null;
  }

  async models(): Promise<readonly ChatModel[]> {
    const { models } = await this.#request("get_available_models", {});
    return models.map(toChatModel);
  }

  async setModel(model: ChatModel): Promise<void> {
    const chosen = await this.#request("set_model", {
      provider: model.provider,
      modelId: model.id,
    });
    this.store.setModel(toChatModel(chosen));
  }

  /** The next thinking level omp offers for the model. */
  async cycleThinking(): Promise<void> {
    const result = await this.#request("cycle_thinking_level", {});
    if (result !== null) this.store.setThinkingLevel(result.level);
  }

  /** Answers a dialog omp waits on (an approval, a question). */
  async answer(id: string, answer: HostDialogAnswer): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) throw new Error("The chat is not open yet.");
    await this.client.port(ChatSessionPort).answer({ threadId, id, answer });
    this.store.removeRequest(id);
  }

  /** omp's `/` commands for this chat, read once and then kept current by omp's `available_commands`. */
  commands(): Promise<readonly ChatHostCommand[]> {
    if (this.#commands === null) {
      const read = this.#request("get_available_commands", {}).then((result) => result.commands);
      // A failed read is tried again next time.
      read.catch(() => {
        if (this.#commands === read) this.#commands = null;
      });
      this.#commands = read;
    }
    return this.#commands;
  }

  /** Files and folders of the chat's folder that match an `@` mention. */
  async searchFiles(query: string): Promise<readonly FileSearchCandidate[]> {
    const found = await this.client
      .port(FileSearchPort)
      .search({ folder: this.folder, query, limit: 30 });
    return found.results;
  }

  /** A `!` or `$` run: omp runs it and records it in the chat; its start and end, with omp's result, come as events. */
  async runShell(run: ShellRun): Promise<void> {
    this.store.expectShell(run.input, run.excludeFromContext);
    const excluded = run.excludeFromContext ? { excludeFromContext: true } : {};
    if (run.method === "bash") await this.#request("bash", { command: run.input, ...excluded });
    else await this.#request("python", { code: run.input, ...excluded });
  }

  /** Stops the running `!` command; omp records it as cancelled. */
  async stopShell(): Promise<void> {
    await this.#request("abort_bash", {});
  }

  /** Reads the next older window of the session file into the transcript. */
  async loadOlder(): Promise<void> {
    const sessionFile = this.#sessionFile;
    const before = this.store.oldestId;
    if (
      sessionFile === null ||
      before === null ||
      this.#loadingOlder ||
      !this.store.getSnapshot().hasOlder
    )
      return;
    this.#loadingOlder = true;
    try {
      const window = await this.client.port(SessionFileStore).readEntryWindow({
        sessionFile,
        before: before as EntryId,
        byteBudget: OLDER_WINDOW_BYTES,
      });
      this.store.prependWindow(window.entries as unknown as SessionEntry[], window.hasOlder);
    } finally {
      this.#loadingOlder = false;
    }
  }

  #request<M extends ChatHostMethod>(
    method: M,
    params: ChatHostMethodMap[M]["params"],
  ): Promise<ChatHostMethodMap[M]["result"]> {
    const threadId = this.#threadId;
    if (threadId === null) return Promise.reject(new Error("The chat is not open yet."));
    // The port's generic client types `request` as unknown; `ChatSessionClient` types it by method.
    const chat = this.client.port(ChatSessionPort) as ChatSessionClient;
    return chat.request({ threadId, method, params });
  }

  async #refreshState(): Promise<void> {
    const state = await this.#request("get_state", {});
    if (!this.#disposed) this.store.setState(state);
  }

  #onEvent(payload: ChatSessionEvent): void {
    if (payload.kind === "moved") {
      this.#threadId = payload.threadId;
      this.#sessionFile = payload.sessionFile;
    }
    this.store.apply(payload);
    if (payload.kind === "host_request") {
      if (this.#live && isHostDialogRequest(payload.request))
        this.store.addRequest(payload.request);
      return;
    }
    if (payload.kind !== "event") return;
    // A new turn is written on from the branch's end, which makes it the file's last entry again.
    if (payload.event.type === "agent_start") this.#leaf = undefined;
    // A finished turn is read back from the file, so every entry shows with omp's own id.
    if (payload.event.type === "agent_end") this.#refreshWindow();
    if (payload.event.type === "model_changed") void this.#refreshState();
    if (payload.event.type === "available_commands")
      this.#commands = Promise.resolve(payload.event.commands);
  }

  /** Reads the newest window again after omp wrote to the file; a new chat's file waits for omp's first reply. */
  #refreshWindow(): void {
    this.#reloadWindow().catch((error: unknown) => {
      if (error instanceof AppFailure && error.appError.code === "not_found") return;
      throw error;
    });
  }

  async #reloadWindow(): Promise<void> {
    const sessionFile = this.#sessionFile;
    if (sessionFile === null) return;
    if (this.#leaf === null) {
      this.store.setWindow([], false);
      return;
    }
    const window = await this.client.port(SessionFileStore).readEntryWindow({
      sessionFile,
      ...(this.#leaf === undefined ? {} : { leafId: this.#leaf as EntryId }),
      byteBudget: FIRST_WINDOW_BYTES,
    });
    if (this.#disposed) return;
    const entries = window.entries as unknown as SessionEntry[];
    this.store.setWindow(entries, window.hasOlder);
    this.#windowRead = true;
    // The branch the file ends on is what opening the chat shows next time (not a branch an edit went back to).
    if (this.#leaf === undefined && this.#threadId !== null)
      keepWindow(this.#threadId, { entries, hasOlder: window.hasOlder });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopResync();
    this.#draft?.dispose();
    this.store.dispose();
    // A stream that ended with its chat (a deleted chat) has nothing left to unsubscribe.
    await this.#subscription?.unsubscribe().catch(() => undefined);
    if (this.#threadId !== null) await this.#releaseView(this.#threadId);
  }

  /** Lets go of the view this pane's open took, once. */
  async #releaseView(threadId: ThreadId): Promise<void> {
    if (!this.#viewTaken) return;
    this.#viewTaken = false;
    // The server answers a chat it no longer has (deleted meanwhile) with nothing to do, and a lost connection has let
    // go of every view already, so a failure here leaves nothing held.
    await this.client
      .port(ChatSessionPort)
      .close({ threadId })
      .catch(() => undefined);
  }
}

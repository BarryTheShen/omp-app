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
  type ChatHostMethod,
  type ChatHostMethodMap,
  type HostDialogAnswer,
  isHostDialogRequest,
  type QueueName,
} from "@omp-app/contracts/chat-host";
import { ChatDraft } from "./drafts";
import { type ChatModel, ChatStore, toChatModel } from "./store";
import type { ShellRun } from "./triggers";

/** The first window read from a session file: enough for the newest screens, small enough to parse at once. */
const FIRST_WINDOW_BYTES = 512 * 1024;
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
  /** Events before the subscription is acknowledged are the server's replay: history, not new requests. */
  #live = false;
  #commands: Promise<readonly ChatHostCommand[]> | null = null;
  readonly #stopResync: () => void;
  private readonly client: AppClient;
  private readonly target: ChatTarget;
  /** The folder the chat works in: `@` mentions search it. */
  private readonly folder: FolderPath;

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

  async open(): Promise<void> {
    if (this.#sessionFile !== null) await this.#reloadWindow();
    const chat = this.client.port(ChatSessionPort);
    const opened = await chat.open(
      this.target.kind === "existing"
        ? { threadId: this.target.threadId }
        : { folderPath: this.target.folder, start: "new" },
    );
    if (this.#disposed) return;
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
  async send(text: string, mode: "auto" | "followUp" = "auto"): Promise<void> {
    const working = this.store.getSnapshot().working;
    await this.#request("prompt", {
      text,
      ...(working ? { streamingBehavior: mode === "followUp" ? "followUp" : "steer" } : {}),
    });
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
    const window = await this.client.port(SessionFileStore).readEntryWindow({
      sessionFile,
      byteBudget: FIRST_WINDOW_BYTES,
    });
    if (this.#disposed) return;
    this.store.setWindow(window.entries as unknown as SessionEntry[], window.hasOlder);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopResync();
    this.#draft?.dispose();
    this.store.dispose();
    await this.#subscription?.unsubscribe();
  }
}

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  type ChatSessionEvent,
  ChatSessionPort,
  type EntryId,
  type FolderPath,
  type SessionFilePath,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import { ChatStore } from "./store";

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
  #disposed = false;
  readonly #stopResync: () => void;
  private readonly client: AppClient;
  private readonly target: ChatTarget;

  constructor(client: AppClient, target: ChatTarget) {
    this.client = client;
    this.target = target;
    this.#threadId = target.kind === "existing" ? target.threadId : null;
    this.#sessionFile = target.kind === "existing" ? target.sessionFile : null;
    // A gap in the event stream: the file holds what was missed.
    this.#stopResync = client.onResync((event) => {
      if (event.stream === this.#subscription?.stream) void this.#reloadWindow();
    });
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
    await chat.setEventOptions({ threadId: opened.threadId, messageUpdates: "delta" });
    this.store.setPhase("live");
  }

  /** Sends a message: a new prompt, or while omp works, a steer (`followUp` queues it behind the turn). */
  async send(text: string, mode: "auto" | "followUp" = "auto"): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) throw new Error("The chat is not open yet.");
    const working = this.store.getSnapshot().working;
    await this.client.port(ChatSessionPort).request({
      threadId,
      method: "prompt",
      params: {
        text,
        ...(working ? { streamingBehavior: mode === "followUp" ? "followUp" : "steer" } : {}),
      },
    });
  }

  async stop(): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) return;
    await this.client.port(ChatSessionPort).request({ threadId, method: "abort", params: {} });
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

  #onEvent(payload: ChatSessionEvent): void {
    if (payload.kind === "moved") {
      this.#threadId = payload.threadId;
      this.#sessionFile = payload.sessionFile;
    }
    this.store.apply(payload);
    // A finished turn is read back from the file, so every entry shows with omp's own id.
    if (payload.kind === "event" && payload.event.type === "agent_end") void this.#reloadWindow();
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
    this.store.dispose();
    await this.#subscription?.unsubscribe();
  }
}

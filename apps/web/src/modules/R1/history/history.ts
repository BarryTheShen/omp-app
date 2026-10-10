import type { AppClient } from "@omp-app/client";
import type {
  AppError,
  CapabilityMap,
  FolderPath,
  OpenThreadArgs,
  PortClient,
  RpcSessionClient,
  RpcSessionEvent,
  ThreadId,
} from "@omp-app/contracts";
import {
  AppFailure,
  RpcSessionPort as RpcSessionPortSchema,
  SessionFileStore,
} from "@omp-app/contracts";
import {
  SessionHistoryLoader,
  type SessionOutputReader,
  type SessionWindowReader,
} from "@/modules/R0/history/history";
import { OmpRuntimeStore } from "@/modules/R0/store/store";
import { releaseThread } from "../release";

interface EventSubscription {
  readonly stream: string;
  readonly lastSeq: number;
  onEvent(listener: (payload: RpcSessionEvent, seq: number) => void): () => void;
  unsubscribe(): Promise<void>;
}

export interface SelectedThreadHistoryState {
  readonly threadId: ThreadId | undefined;
  readonly store: OmpRuntimeStore | undefined;
  readonly capabilities: CapabilityMap | undefined;
  readonly isLoading: boolean;
  readonly error: AppError | null;
}

export interface SelectedThreadHistoryOptions {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly onThreadIdChange?: (threadId: ThreadId | undefined) => void;
  readonly createStore?: (threadId: ThreadId, session: RpcSessionClient) => OmpRuntimeStore;
  readonly createLoader?: (
    threadId: ThreadId,
    session: RpcSessionClient,
    store: OmpRuntimeStore,
  ) => SessionHistoryLoader;
}

function asFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function unavailable(message: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message,
    retryable: false,
    capability: "host.session-files",
  });
}

/**
 * Owns only selected-thread lifecycle. A0 owns the socket and event resume; R0 owns event/store
 * reduction and history loading. Switching always disposes the old subscription before publishing
 * the new store, and an in-process session_info_update re-keys through the same path without an
 * extra prompt or a second transcript store.
 */
export class SelectedThreadHistoryController {
  private readonly options: SelectedThreadHistoryOptions;
  private readonly client: AppClient;
  private readonly rpc: RpcSessionClient;
  private readonly sessionFiles: PortClient<typeof SessionFileStore>;
  private state: SelectedThreadHistoryState = Object.freeze({
    threadId: undefined,
    store: undefined,
    capabilities: undefined,
    isLoading: false,
    error: null,
  });
  private subscription: EventSubscription | undefined;
  private offEvents: (() => void) | undefined;
  private loader: SessionHistoryLoader | undefined;
  private stopRefetchWatch: (() => void) | undefined;
  private listeners = new Set<(state: SelectedThreadHistoryState) => void>();
  private transitions: Promise<void> = Promise.resolve();

  public constructor(options: SelectedThreadHistoryOptions) {
    this.options = options;
    this.client = options.client;
    this.rpc = this.client.port(RpcSessionPortSchema);
    this.sessionFiles = this.client.port(SessionFileStore);
  }

  public getSnapshot(): SelectedThreadHistoryState {
    return this.state;
  }

  public subscribe(listener: (state: SelectedThreadHistoryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async openExisting(threadId: ThreadId): Promise<OmpRuntimeStore> {
    return this.open({ threadId });
  }

  public async openNew(): Promise<OmpRuntimeStore> {
    return this.open({ folderPath: this.options.folder, start: "new" });
  }

  public async openLatest(): Promise<OmpRuntimeStore> {
    return this.open({ folderPath: this.options.folder, start: "latest" });
  }

  /**
   * Reopens a chat the browser had open, for a reload or a restart. A chat nobody has sent to has no session file until
   * its first turn, so a restarted server no longer has it: the folder's new chat opens instead. The text typed in an
   * unsent chat is kept for the folder's new chat, so it comes back in that chat's composer. Any other failure is
   * reported as it is.
   */
  public async reopenSaved(threadId: ThreadId): Promise<OmpRuntimeStore> {
    try {
      return await this.openExisting(threadId);
    } catch (error) {
      if (asFailure(error, "").appError.code !== "not_found") throw error;
      return this.openNew();
    }
  }

  /** Re-subscribes without replay duplication; A0's afterSeq is the authoritative resume cursor. */
  public async resume(afterSeq?: number): Promise<void> {
    const threadId = this.state.threadId;
    const store = this.state.store;
    if (!threadId || !store) throw unavailable("No selected thread is open");
    store.resetSequence(afterSeq ?? this.subscription?.lastSeq ?? store.getSnapshot().lastSeq);
    await this.attachSubscription(threadId, store, afterSeq);
  }

  /** Loads the full text of a tool output the thread shows shortened; the loader reads the entry from the session file. */
  public async loadFullOutput(toolCallId: string): Promise<void> {
    const loader = this.loader;
    if (!this.state.threadId || !this.state.store || !loader) {
      throw unavailable("No selected thread is open");
    }
    try {
      await loader.loadFullOutput(toolCallId);
    } catch (error) {
      throw asFailure(error, "Loading the full output failed");
    }
  }

  /** Loads the page of history older than the one shown; the loader reads it from the session file. */
  public async loadOlder(): Promise<void> {
    const loader = this.loader;
    if (!this.state.threadId || !this.state.store || !loader) {
      throw unavailable("No selected thread is open");
    }
    try {
      await loader.loadOlder();
    } catch (error) {
      throw asFailure(error, "Loading older session history failed");
    }
  }

  /**
   * Brings the open thread up to date after a `!` command. omp saves a command's result to the
   * session without a turn, so no `session_settled` arrives to refresh the transcript.
   */
  public async refreshAfterCommand(): Promise<void> {
    const loader = this.loader;
    if (!this.state.threadId || !this.state.store || !loader) return;
    try {
      await loader.refreshAfterTurn();
    } catch (error) {
      const failure = asFailure(error, "Refreshing the session after the command failed");
      if (failure.appError.code !== "cancelled") this.commit({ error: failure.appError });
    }
  }

  public close(): Promise<void> {
    return this.serialize(() => this.closeNow());
  }

  private async closeNow(): Promise<void> {
    this.loader?.dispose();
    this.stopRefetchWatch?.();
    this.loader = undefined;
    this.stopRefetchWatch = undefined;
    this.offEvents?.();
    this.offEvents = undefined;
    const subscription = this.subscription;
    this.subscription = undefined;
    const releasedThreadId = this.state.threadId;
    if (subscription) await subscription.unsubscribe();
    this.commit({
      threadId: undefined,
      store: undefined,
      capabilities: undefined,
      isLoading: false,
      error: null,
    });
    // Tell the server this view is gone. Without it every chat the tab ever opened kept its omp
    // process (about 380 MB while idle) until the app quit. Not awaited: switching chats must not
    // wait on the server, and `release` handles every failure itself.
    if (releasedThreadId !== undefined) void this.release(releasedThreadId);
  }

  /** Best effort: see `releaseThread`. */
  private release(threadId: ThreadId): Promise<void> {
    return releaseThread(this.rpc.close, threadId);
  }

  private open(args: OpenThreadArgs): Promise<OmpRuntimeStore> {
    return this.serialize(() => this.openNow(args));
  }

  private async openNow(args: OpenThreadArgs): Promise<OmpRuntimeStore> {
    await this.closeNow();
    this.commit({ isLoading: true, error: null });
    try {
      const result = await this.rpc.open(args);
      const threadId = result.threadId;
      const store = this.options.createStore?.(threadId, this.rpc) ?? this.defaultStore(threadId);
      const loader =
        this.options.createLoader?.(threadId, this.rpc, store) ??
        this.defaultLoader(threadId, store);
      this.loader = loader;
      this.commit({
        threadId,
        store,
        capabilities: result.capabilities,
        isLoading: true,
        error: null,
      });
      // From here the composer takes text, so a reload or a restart must already find this chat: its id is saved now,
      // not after the history has loaded. Otherwise text typed in a new chat is lost when the app restarts in that window.
      this.options.onThreadIdChange?.(threadId);
      // A live-only subscription: with afterSeq 0 the client sends no cursor (`packages/client/src/client.ts`), so
      // the server replays nothing and the first event is the store's baseline; the history load below covers
      // everything written before it. Without the subscription the store never sees the process become ready and
      // can miss the start of the first prompt.
      await this.attachSubscription(threadId, store, 0);
      await loader.loadInitial();
      this.stopRefetchWatch = loader.watchNeedsRefetch();
      this.commit({
        threadId,
        store,
        capabilities: result.capabilities,
        isLoading: false,
        error: null,
      });
      return store;
    } catch (error) {
      const failure = asFailure(error, "Opening the selected thread failed");
      await this.closeNow();
      this.commit({ isLoading: false, error: failure.appError });
      throw failure;
    }
  }

  private defaultStore(threadId: ThreadId): OmpRuntimeStore {
    const transport = {
      send: this.rpc.send,
      answerExtensionUi: this.rpc.answerExtensionUi,
      answerHostTool: this.rpc.answerHostTool,
      answerHostUri: this.rpc.answerHostUri,
    };
    return new OmpRuntimeStore({ threadId, transport });
  }

  private defaultLoader(threadId: ThreadId, store: OmpRuntimeStore): SessionHistoryLoader {
    const readWindow: SessionWindowReader = (args, options) =>
      this.sessionFiles.readEntryWindow(args, options);
    const readOutput: SessionOutputReader = (args, options) =>
      this.sessionFiles.readEntryOutput(args, options);
    return new SessionHistoryLoader({
      threadId,
      send: this.rpc.send,
      store,
      readWindow,
      readOutput,
    });
  }

  private async attachSubscription(
    threadId: ThreadId,
    store: OmpRuntimeStore,
    afterSeq?: number,
  ): Promise<void> {
    this.offEvents?.();
    this.offEvents = undefined;
    const previous = this.subscription;
    this.subscription = undefined;
    if (previous) await previous.unsubscribe();
    const subscribe = (from: number | undefined) =>
      this.client.subscribe(RpcSessionPortSchema, "event", {
        scope: threadId,
        ...(from === undefined ? {} : { afterSeq: from }),
      }) as Promise<EventSubscription>;
    let subscription: EventSubscription;
    try {
      subscription = await subscribe(afterSeq);
    } catch (error) {
      // The server keeps the last few hundred events per thread. When the requested ones are gone,
      // follow live events only; the history loader supplies everything older.
      if (afterSeq === undefined || asFailure(error, "").appError.code !== "conflict") throw error;
      subscription = await subscribe(undefined);
    }
    this.subscription = subscription;
    // With afterSeq 0 the client sends no cursor, so the server replays nothing: the subscription is live only and
    // its first event is where the stream is now, not a gap. The history load that follows reads everything written
    // before that event, so the store starts its sequence there. Treating it as a gap dropped every live event
    // until the refetch ended.
    let baselined = afterSeq !== 0;
    this.offEvents = subscription.onEvent((payload, seq) => {
      if (!baselined) {
        baselined = true;
        if (store.getSnapshot().lastSeq === 0) store.resetSequence(seq - 1);
      }
      store.ingest(payload, seq);
      // After each settled turn, omp has persisted the turn: refetch so its messages pair with their
      // entries (edit and branch need entry ids) and get_state brings the model, context and usage.
      // While the thread is still loading (replayed settles), the initial load covers it.
      if (payload.kind === "session_settled" && this.loader && !this.state.isLoading) {
        void this.loader.refreshAfterTurn().catch((error: unknown) => {
          const failure = asFailure(error, "Refreshing the session after the turn failed");
          if (failure.appError.code !== "cancelled") this.commit({ error: failure.appError });
        });
      }
      const nextThreadId = this.sessionIdFromEvent(payload);
      if (nextThreadId && nextThreadId !== this.state.threadId) {
        void this.rekeyInProcess(nextThreadId);
      }
    });
  }

  private sessionIdFromEvent(event: RpcSessionEvent): ThreadId | undefined {
    if (event.kind !== "notification") return undefined;
    const frame = event.frame;
    if (frame.type !== "session_info_update") return undefined;
    return frame.sessionId as ThreadId;
  }

  private rekeyInProcess(threadId: ThreadId): Promise<void> {
    return this.serialize(() => this.rekey(threadId));
  }

  /** Runs thread transitions one at a time, so an open, a close and a re-key never interleave. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.transitions.then(task);
    this.transitions = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async rekey(threadId: ThreadId): Promise<void> {
    const store = this.state.store;
    if (!store) return;
    // The chat already moved here (an earlier re-key or an open of this id): nothing to re-key.
    if (this.state.threadId === threadId) return;
    this.loader?.dispose();
    this.stopRefetchWatch?.();
    this.loader = undefined;
    this.stopRefetchWatch = undefined;
    const loader =
      this.options.createLoader?.(threadId, this.rpc, store) ?? this.defaultLoader(threadId, store);
    this.loader = loader;
    // omp may move the same session to a persisted file while a prompt is streaming. Keep the
    // existing store/runtime and only move the event subscription and future history requests.
    this.commit({ threadId, store, isLoading: false, error: null });
    // While a prompt streams, its settle refetches; otherwise refetch now.
    const streaming = store.getSnapshot().prompt.streaming;
    await this.attachSubscription(threadId, store);
    if (!streaming) await loader.refetch();
    this.stopRefetchWatch = loader.watchNeedsRefetch();
    this.options.onThreadIdChange?.(threadId);
  }

  private commit(patch: Partial<SelectedThreadHistoryState>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener(this.state);
  }
}

export function createSelectedThreadHistoryController(
  options: SelectedThreadHistoryOptions,
): SelectedThreadHistoryController {
  return new SelectedThreadHistoryController(options);
}

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
  /** The open chat was started as new (`openNew`): it has no messages yet, so its text is the folder's new-chat draft. */
  readonly openedNew: boolean;
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
  /** Called when a chat whose turn was still running after it was left has ended that turn: its row may be new now. */
  readonly onTurnSettled?: (threadId: ThreadId) => void;
  /**
   * Called when a chat is left while its turn still runs: the list is read so the chat's row shows the turn. Omp writes
   * a new chat's file after its turn starts, so no change event announces that start.
   */
  readonly onLeftRunning?: (threadId: ThreadId) => void;
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

/** Whether an event ends the turn a chat was running: the turn settled, or omp stopped under it. */
function turnEnded(payload: RpcSessionEvent): boolean {
  if (payload.kind === "session_settled") return true;
  return (
    payload.kind === "process" &&
    (payload.status === "stopped" || payload.status === "exited" || payload.status === "error")
  );
}

/** An event a subscription replayed, with its sequence. */
interface ReplayedEvent {
  readonly payload: RpcSessionEvent;
  readonly seq: number;
}

/**
 * The replayed events after the last turn's end: the running turn, or the events of a process that started after the last
 * one ended. The turns before are history the session file holds, so they are not applied again. Applying their messages
 * again duplicated them after a branch, whose stream carries the run it came from.
 */
function eventsAfterLastTurnEnd(events: readonly ReplayedEvent[]): readonly ReplayedEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && turnEnded(event.payload)) return events.slice(index + 1);
  }
  return events;
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
    openedNew: false,
  });
  private subscription: EventSubscription | undefined;
  private offEvents: (() => void) | undefined;
  private loader: SessionHistoryLoader | undefined;
  private stopRefetchWatch: (() => void) | undefined;
  private listeners = new Set<(state: SelectedThreadHistoryState) => void>();
  private transitions: Promise<void> = Promise.resolve();
  /** Chats left while their turn ran: each is held and watched until the turn ends (see `watchTurnEnd`). */
  private readonly turnWatches = new Map<
    ThreadId,
    { readonly subscription: EventSubscription; readonly off: () => void }
  >();
  /** The chat opened again while its turn still ran: its turn's end is reported when it comes. */
  private reopenedWhileRunning: ThreadId | undefined;
  /** The chat open most recently asked for, while that open is still pending (see `openExisting`). */
  private pendingOpen:
    | { readonly threadId: ThreadId; readonly open: Promise<OmpRuntimeStore> }
    | undefined;

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

  /**
   * Opens an existing chat. Several requests for the chat while its open is pending share that open: a button clicked
   * ten times used to close and reopen the chat ten times (issue 922). A request for another chat in between starts its own
   * open, so the last pick is the one shown.
   */
  public openExisting(threadId: ThreadId): Promise<OmpRuntimeStore> {
    const pending = this.pendingOpen;
    if (pending !== undefined && pending.threadId === threadId) return pending.open;
    const open = this.open({ threadId });
    const entry = { threadId, open };
    this.pendingOpen = entry;
    const settle = (): void => {
      if (this.pendingOpen === entry) this.pendingOpen = undefined;
    };
    void open.then(settle, settle);
    return open;
  }

  public async openNew(): Promise<OmpRuntimeStore> {
    this.pendingOpen = undefined;
    return this.open({ folderPath: this.options.folder, start: "new" });
  }

  public async openLatest(): Promise<OmpRuntimeStore> {
    this.pendingOpen = undefined;
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
    // A chat whose turn is still running is kept and watched until the turn ends (issue 935): the list must learn of the
    // row it writes even though the chat is no longer open.
    const running = this.state.store?.getSnapshot().prompt.streaming === true;
    this.loader?.dispose();
    this.stopRefetchWatch?.();
    this.loader = undefined;
    this.stopRefetchWatch = undefined;
    this.offEvents?.();
    this.offEvents = undefined;
    const subscription = this.subscription;
    this.subscription = undefined;
    const releasedThreadId = this.state.threadId;
    this.reopenedWhileRunning = undefined;
    const watched =
      running && subscription !== undefined && releasedThreadId !== undefined
        ? { threadId: releasedThreadId, subscription }
        : undefined;
    if (watched) this.watchTurnEnd(watched.threadId, watched.subscription);
    else if (subscription) await subscription.unsubscribe();
    this.commit({
      threadId: undefined,
      store: undefined,
      capabilities: undefined,
      isLoading: false,
      error: null,
      openedNew: false,
    });
    // Tell the server this view is gone. Without it every chat the tab ever opened kept its omp
    // process (about 380 MB while idle) until the app quit. Not awaited: switching chats must not
    // wait on the server, and `release` handles every failure itself. A watched chat is let go when its turn ends.
    if (releasedThreadId !== undefined && watched === undefined)
      void this.release(releasedThreadId);
    // A chat left mid-turn is reported, so its row shows the turn (see `onLeftRunning`).
    if (running && releasedThreadId !== undefined) this.options.onLeftRunning?.(releasedThreadId);
  }

  /** Watches a chat whose turn runs after it was left: when the turn ends, the chat is let go and the app is told. */
  private watchTurnEnd(threadId: ThreadId, subscription: EventSubscription): void {
    const off = subscription.onEvent((payload) => {
      if (!turnEnded(payload)) return;
      this.endTurnWatch(threadId);
      this.options.onTurnSettled?.(threadId);
    });
    this.turnWatches.set(threadId, { subscription, off });
  }

  /** Ends a watch whose turn ended: its subscription is closed and the server hold let go. */
  private endTurnWatch(threadId: ThreadId): void {
    const watch = this.turnWatches.get(threadId);
    if (watch === undefined) return;
    this.turnWatches.delete(threadId);
    watch.off();
    watch.subscription.unsubscribe().catch((error: unknown) => {
      console.error("[omp-app] could not stop watching a chat's turn", error);
    });
    void this.release(threadId);
  }

  /**
   * A watched chat is opened again: the open takes its subscription over, and only the watch's hold is let go, since
   * the open holds the chat now. Returns whether the chat was watched.
   */
  private takeOverTurnWatch(threadId: ThreadId): boolean {
    const watch = this.turnWatches.get(threadId);
    if (watch === undefined) return false;
    this.turnWatches.delete(threadId);
    watch.off();
    void this.release(threadId);
    return true;
  }

  /** Best effort: see `releaseThread`. */
  private release(threadId: ThreadId): Promise<void> {
    return releaseThread(this.rpc.close, threadId);
  }

  private open(args: OpenThreadArgs): Promise<OmpRuntimeStore> {
    return this.serialize(() => this.openNow(args));
  }

  private async openNow(args: OpenThreadArgs): Promise<OmpRuntimeStore> {
    const openedNew = "start" in args && args.start === "new";
    await this.closeNow();
    this.commit({ isLoading: true, error: null });
    try {
      const result = await this.rpc.open(args);
      const threadId = result.threadId;
      // A chat left while its turn ran, and opened again now: this open takes over that chat's watch.
      if (this.takeOverTurnWatch(threadId)) this.reopenedWhileRunning = threadId;
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
        openedNew,
      });
      // From here the composer takes text, so a reload or a restart must already find this chat: its id is saved now,
      // not after the history has loaded. Otherwise text typed in a new chat is lost when the app restarts in that window.
      this.options.onThreadIdChange?.(threadId);
      // The chat's stream starts at its first event the server still holds (afterSeq 0): the events omp sent before this
      // browser subscribed, such as a startup notice or the process becoming ready, reach the store in order. The history
      // load below reads what omp wrote to the session file.
      await this.attachSubscription(threadId, store, 0);
      await loader.loadInitial();
      this.stopRefetchWatch = loader.watchNeedsRefetch();
      this.commit({
        threadId,
        store,
        capabilities: result.capabilities,
        isLoading: false,
        error: null,
        openedNew,
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
    // With afterSeq 0 the server replays what it still holds. Only the events after the last turn's end are applied (see
    // `eventsAfterLastTurnEnd`), in order, so the store takes the running turn from its first event. When the server no
    // longer holds the events, the subscription follows live events only, and the first event it delivers is where the
    // stream is now, not a gap.
    let baselined = afterSeq !== 0;
    // The events a subscription from the stream's start replays arrive before it is acknowledged. They are collected, and
    // applied after the acknowledgement.
    let replay: ReplayedEvent[] | undefined;
    // A replayed event is applied as history: a question, host call or sign-in prompt in it is not asked again (see `ingest`).
    const apply = (payload: RpcSessionEvent, seq: number, replayed: boolean) => {
      if (!baselined) {
        baselined = true;
        if (store.getSnapshot().lastSeq === 0) store.resetSequence(seq - 1);
      }
      store.ingest(payload, seq, replayed);
      // A turn that was still running when this chat was opened again: the app is told when it ends.
      if (turnEnded(payload) && this.reopenedWhileRunning === threadId) {
        this.reopenedWhileRunning = undefined;
        this.options.onTurnSettled?.(threadId);
      }
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
    };
    const onEvent = (payload: RpcSessionEvent, seq: number) => {
      if (replay !== undefined) replay.push({ payload, seq });
      else apply(payload, seq, false);
    };
    // The handler is attached before the request: the server sends the events a stream replays before it acknowledges
    // the subscription, and an event with no listener is lost. A cursor the server no longer holds is followed live by
    // the client itself (see `subscribeRecord`); the history loader supplies everything older.
    const collected: ReplayedEvent[] | undefined = afterSeq === 0 ? [] : undefined;
    replay = collected;
    let subscription: EventSubscription;
    try {
      subscription = await (this.client.subscribe(RpcSessionPortSchema, "event", {
        scope: threadId,
        ...(afterSeq === undefined ? {} : { afterSeq }),
        onEvent,
      }) as Promise<EventSubscription>);
    } finally {
      replay = undefined;
    }
    this.subscription = subscription;
    if (collected !== undefined) {
      for (const event of eventsAfterLastTurnEnd(collected)) apply(event.payload, event.seq, true);
    }
    // The same function as the handler above, so the client holds one listener. Its detach removes the handler when the
    // chat is left.
    this.offEvents = subscription.onEvent(onEvent);
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

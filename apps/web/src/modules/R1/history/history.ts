import type { AppClient } from "@omp-app/client";
import type {
  AppError,
  CapabilityMap,
  ChatSessionEvent,
  FolderPath,
  ModelChoice,
  OpenThreadArgs,
  PortClient,
  RpcSessionClient,
  ThreadId,
} from "@omp-app/contracts";
import {
  AppFailure,
  ChatSessionPort,
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
import { pickedModelFor, rememberPickedModel } from "./picked-model";

interface EventSubscription {
  readonly stream: string;
  readonly lastSeq: number;
  onEvent(listener: (payload: ChatSessionEvent, seq: number) => void): () => void;
  unsubscribe(): Promise<void>;
}

export interface SelectedThreadHistoryState {
  readonly threadId: ThreadId | undefined;
  readonly store: OmpRuntimeStore | undefined;
  readonly capabilities: CapabilityMap | undefined;
  readonly isLoading: boolean;
  readonly isSwitching: boolean;
  readonly error: AppError | null;
  /** The open chat was started as new (`openNew`, or `openStarted` for the sidebar's New chat): no messages yet, so its text is the folder's draft. */
  readonly openedNew: boolean;
}

export type HistoryPerfMark =
  | "first_feedback"
  | "window_applied"
  | "newest_20_painted"
  | "rpc_open_returned"
  | "composer_typable"
  | "leaf_swap";

export interface SelectedThreadHistoryOptions {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly onThreadIdChange?: (threadId: ThreadId | undefined) => void;
  readonly onPerfMark?: (name: HistoryPerfMark) => void;
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

/** The opens a newer pick superseded: their failures say so, so the chat the person picked last is the one shown. */
const supersededOpens = new WeakSet<AppFailure>();

function supersededOpen(): AppFailure {
  const failure = new AppFailure({
    code: "cancelled",
    message: "Opening the chat was superseded by a newer pick.",
    retryable: false,
  });
  supersededOpens.add(failure);
  return failure;
}

/** Whether an open failed because a newer pick superseded it (see `openExisting`). */
export function isSupersededOpen(error: unknown): boolean {
  return error instanceof AppFailure && supersededOpens.has(error);
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
function turnEnded(payload: ChatSessionEvent): boolean {
  if (payload.kind === "event") return payload.event.type === "session_settled";
  return (
    payload.kind === "process" &&
    (payload.status === "stopped" || payload.status === "exited" || payload.status === "error")
  );
}

/** An event a subscription replayed, with its sequence. */
interface ReplayedEvent {
  readonly payload: ChatSessionEvent;
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
    isSwitching: false,
    error: null,
    openedNew: false,
  });
  private subscription: EventSubscription | undefined;
  private offEvents: (() => void) | undefined;
  /** The server refused the chat's resubscribe after a reconnect, so no event reaches it until it is opened again (issue 1081). */
  private watchRefused = false;
  private offResync: (() => void) | undefined;
  private loader: SessionHistoryLoader | undefined;
  private stopRefetchWatch: (() => void) | undefined;
  /** The kept chat whose initial history must be retried after omp restarts. */
  private historyRetryThread: ThreadId | undefined;
  /** The chat whose open lost the connection, opened again once the connection is back (see `reopenFailedOpen`). */
  private failedOpen: ThreadId | undefined;
  // Counts the requests that change the chat on screen (an open or a close): see `open`.
  private requests = 0;
  private listeners = new Set<(state: SelectedThreadHistoryState) => void>();
  private transitions: Promise<void> = Promise.resolve();
  /** Switches the page started and not yet open. Each one is let go by its owner (see `holdSwitch`). */
  private readonly holds = new Set<symbol>();
  /** Opens asked for whose chat is not yet on screen: counted from the request until the commit, or the failure. */
  private pendingOpens = 0;
  private settleWaiters: Array<() => void> = [];
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
  /** The pick most recently asked for, and its controller: a pick for another chat that is still pending is cancelled (see `openExisting`). */
  private pickAbort:
    | { readonly threadId: ThreadId; readonly controller: AbortController }
    | undefined;
  /** Closes asked for so far. An open that began before a close must not save its chat as the open one (see `openNow`). */
  private closes = 0;

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
   * ten times used to close and reopen the chat ten times (issue 922). A request for another chat in between cancels the
   * open before it, so the last pick is the one shown: a chat omp was not yet asked for is never asked (issue 2212). A
   * model picked for a chat omp could not restore opens it as a fresh open, and is remembered: when omp refuses the
   * chat's saved model again, the chat opens with the model remembered for it.
   */
  public openExisting(threadId: ThreadId, model?: ModelChoice): Promise<OmpRuntimeStore> {
    if (model !== undefined) return this.openWithModel(threadId, model);
    const pending = this.pendingOpen;
    if (pending !== undefined && pending.threadId === threadId) return pending.open;
    // A pick supersedes the pick before it for another chat: that pick is cancelled, and if omp was not yet asked for it,
    // it never reaches omp. A pick for the same chat is not cancelled (issue 2212).
    const superseded = this.pickAbort;
    if (superseded !== undefined && superseded.threadId !== threadId) superseded.controller.abort();
    const pickAbort = { threadId, controller: new AbortController() };
    this.pickAbort = pickAbort;
    // Keep the current transcript mounted while a sidebar selection opens another chat: the sessions list lives in the
    // same shell and must not remount its rows for the duration of the switch.
    const keepShown = this.state.store !== undefined && this.state.threadId !== undefined;
    const open = this.open({ threadId }, keepShown, false, pickAbort.controller.signal).catch(
      (error: unknown) => {
        // omp refuses a chat whose saved model is gone. The model remembered for the chat, if any, opens it.
        const picked =
          asFailure(error, "").appError.code === "model_unavailable"
            ? pickedModelFor(threadId)
            : undefined;
        if (picked === undefined) throw error;
        return this.openWithModel(threadId, picked);
      },
    );
    const entry = { threadId, open };
    this.pendingOpen = entry;
    const settle = (): void => {
      if (this.pendingOpen === entry) this.pendingOpen = undefined;
      if (this.pickAbort === pickAbort) this.pickAbort = undefined;
    };
    void open.then(settle, settle);
    return open;
  }

  /**
   * Opens a chat the person picked from a list (the sidebar, the chat list, the palette). The chat on screen stays as it is
   * when it is open, loaded and watched, and no other open or switch is pending: its store, its scroll position, its open
   * folds and a running turn stay, and omp is not asked to open it again (issue 1359). A chat whose watch the server refused
   * after a reconnect is opened again, so it receives its events (issue 1081). With another open pending (a New chat, say)
   * the pick queues behind it, so the last pick is the one shown. A pick with a model opens the chat with it (see `openExisting`).
   */
  public pickExisting(threadId: ThreadId, model?: ModelChoice): Promise<OmpRuntimeStore> {
    const current = this.state.store;
    if (
      current !== undefined &&
      model === undefined &&
      this.state.threadId === threadId &&
      this.pendingOpens === 0 &&
      this.holds.size === 0 &&
      !this.watchRefused
    )
      return Promise.resolve(current);
    return this.openExisting(threadId, model);
  }

  private async openWithModel(threadId: ThreadId, model: ModelChoice): Promise<OmpRuntimeStore> {
    const store = await this.open({ threadId, model });
    rememberPickedModel(threadId, model);
    return store;
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
   * Opens a chat the server has just started for a New chat (the sidebar's New chat). It has no messages yet, so it is
   * marked `openedNew` from the moment it is on screen, as `openNew` marks its chat: its text is the folder's new-chat
   * draft from the first keystroke. Any other open or close clears the mark.
   */
  public openStarted(threadId: ThreadId): Promise<OmpRuntimeStore> {
    const keepShown = this.state.store !== undefined && this.state.threadId !== undefined;
    return this.open({ threadId }, keepShown, true);
  }

  /**
   * Holds a chat switch the page started before its chat is open (the sidebar's New chat, from its click until the chat
   * opens or fails). The hold ends only when its release is called, so another chat's open in between does not drop it.
   * Returns the release.
   */
  public holdSwitch(): () => void {
    const token = Symbol("switch");
    this.holds.add(token);
    return () => {
      if (this.holds.delete(token)) this.notifySettled();
    };
  }

  /**
   * Resolves once the chat on screen is the one asked for: no open is pending before its chat is committed (a failed
   * open ends its wait too), and no switch is held. It does not wait for the chat's history to load: a new chat's
   * history loads only once its first prompt arrives, and a send made meanwhile belongs to that chat.
   */
  public async whenSettled(): Promise<void> {
    while (this.pendingOpens > 0 || this.holds.size > 0) {
      await new Promise<void>((resolve) => {
        this.settleWaiters.push(resolve);
      });
    }
  }

  private notifySettled(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
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

  /**
   * Opens again the chat whose open lost the connection (issue 1617), once the connection is back. Nothing is opened
   * when no open was lost, or when the person has since picked, opened or closed a chat: each of those forgets it.
   */
  public async reopenFailedOpen(): Promise<void> {
    const threadId = this.failedOpen;
    if (threadId === undefined) return;
    await this.openExisting(threadId);
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

  /** Retries the selected thread's initial history after a failed restart-triggered load. */
  public retryHistory(): Promise<void> {
    const threadId = this.state.threadId;
    const loader = this.loader;
    if (threadId === undefined || this.state.store === undefined || loader === undefined) {
      return Promise.resolve();
    }
    return this.retryInitialHistory(threadId, loader);
  }

  /**
   * Brings the open thread up to date after a command omp saved without a turn: a `!` command, or a
   * compaction. No `session_settled` arrives for those to refresh the transcript. The refresh
   * waits for a chat that is still loading its history: a refresh started during that load
   * superseded the load, and the open then closed the chat with a "superseded" error.
   */
  public async refreshAfterCommand(): Promise<void> {
    await this.serialize(async () => {
      const loader = this.loader;
      if (!this.state.threadId || !this.state.store || !loader) return;
      try {
        await loader.refreshAfterTurn();
      } catch (error) {
        const failure = asFailure(error, "Refreshing the session after the command failed");
        if (failure.appError.code === "cancelled") return;
        // omp's exit is the chat's banner (see the settled-turn refresh): the rows stay, and the read is redone on omp's ready
        // event, as after a failed first load.
        if (failure.appError.code === "omp_exited") {
          this.historyRetryThread = this.state.threadId;
          return;
        }
        this.commit({ error: failure.appError });
      }
    });
  }

  public close(): Promise<void> {
    // Counted when asked, not when it runs: an open still pending now must not save its chat as the one open.
    this.closes += 1;
    this.requests += 1;
    this.failedOpen = undefined;
    return this.serialize(() => this.closeNow());
  }

  private async closeNow(
    keepShown = false,
    shown: Pick<SelectedThreadHistoryState, "threadId" | "store"> = this.state,
  ): Promise<void> {
    this.historyRetryThread = undefined;
    // A chat whose turn is still running is kept and watched until the turn ends (issue 935): the list must learn of the
    // row it writes even though the chat is no longer open.
    const running = shown.store?.getSnapshot().prompt.streaming === true;
    this.loader?.dispose();
    this.stopRefetchWatch?.();
    this.loader = undefined;
    this.stopRefetchWatch = undefined;
    this.offEvents?.();
    this.offEvents = undefined;
    this.offResync?.();
    this.offResync = undefined;
    this.watchRefused = false;
    const subscription = this.subscription;
    this.subscription = undefined;
    const releasedThreadId = shown.threadId;
    this.reopenedWhileRunning = undefined;
    const watched =
      running && subscription !== undefined && releasedThreadId !== undefined
        ? { threadId: releasedThreadId, subscription }
        : undefined;
    if (watched) this.watchTurnEnd(watched.threadId, watched.subscription);
    else if (subscription && keepShown)
      subscription.unsubscribe().catch((error: unknown) => {
        console.error("[omp-app] could not stop watching a chat", error);
      });
    else if (subscription) await subscription.unsubscribe();
    // A pick that opens another chat in place commits that chat next (see `openNow`), so the chat on screen is not cleared here.
    if (!keepShown)
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
   * A watched chat is opened again: the watch's listener goes and its server hold is let go. Returns the subscription the
   * watch held, which `openNow` lets go once the open holds the chat itself; undefined when the chat was not watched.
   */
  private takeOverTurnWatch(threadId: ThreadId): EventSubscription | undefined {
    const watch = this.turnWatches.get(threadId);
    if (watch === undefined) return undefined;
    this.turnWatches.delete(threadId);
    watch.off();
    void this.release(threadId);
    return watch.subscription;
  }

  /** Best effort: see `releaseThread`. */
  private release(threadId: ThreadId): Promise<void> {
    return releaseThread(this.rpc.close, threadId);
  }

  private open(
    args: OpenThreadArgs,
    keepShown = false,
    startedNew = false,
    signal?: AbortSignal,
  ): Promise<OmpRuntimeStore> {
    // Asking for a chat gives up the chat a dropped connection left. Every request takes a ticket, and an open that
    // fails is recorded for a reopen only while its ticket is the latest: a later pick or close came after it.
    this.requests += 1;
    const ticket = this.requests;
    this.pendingOpens += 1;
    const settle = this.openSettler();
    return this.serialize(() =>
      this.openNow(args, settle, ticket, keepShown, startedNew, signal),
    ).finally(settle);
  }

  /** Ends one open's pending state, once: at its commit, or when it fails. A later call does nothing. */
  private openSettler(): () => void {
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.pendingOpens -= 1;
      this.notifySettled();
    };
  }

  private async openNow(
    args: OpenThreadArgs,
    settle: () => void,
    ticket: number,
    keepShown = false,
    startedNew = false,
    signal?: AbortSignal,
  ): Promise<OmpRuntimeStore> {
    // A pick a newer pick superseded before its turn came never reaches omp, and nothing of it is shown (issue 2212).
    if (signal?.aborted) throw supersededOpen();
    const openedNew = startedNew || ("start" in args && args.start === "new");
    const closesAtStart = this.closes;
    const requested = "threadId" in args ? args.threadId : undefined;
    // The chat on screen when this open begins. It stays subscribed until omp opens the chat asked for, and it is shown
    // again if the open fails or a newer pick supersedes this one (issue 2212).
    const previous = this.state;
    // A chat picked from a list is shown at the click, before omp answers: its header and its opening state appear at
    // once, and its store replaces the old one in place, so the rows stay mounted. A chat reopened in place keeps its
    // transcript until the reopen loads.
    let clickStore: OmpRuntimeStore | undefined;
    // The chat last announced to the app (`onThreadIdChange`): one open never announces the same chat twice.
    let announced: ThreadId | undefined;
    if (!keepShown) {
      await this.closeNow();
      this.commit({ isLoading: true, isSwitching: false, error: null });
    } else if (requested !== undefined && requested !== previous.threadId) {
      clickStore = this.options.createStore?.(requested, this.rpc) ?? this.defaultStore(requested);
      this.commit({
        threadId: requested,
        store: clickStore,
        capabilities: undefined,
        isLoading: true,
        isSwitching: true,
        error: null,
        openedNew,
      });
      if (this.closes === closesAtStart) this.options.onThreadIdChange?.(requested);
      announced = requested;
      this.options.onPerfMark?.("first_feedback");
    } else {
      this.commit({ isLoading: true, isSwitching: true, error: null });
    }
    // The subscription a watch held on this chat, if the open took the chat over. Let go only after the open subscribes.
    let watchHold: EventSubscription | undefined;
    let shownStore: OmpRuntimeStore | undefined;
    let openedCapabilities: CapabilityMap | undefined;
    let openedStore: OmpRuntimeStore | undefined;
    // Set once the chat on screen has been let go: from then on a failure ends both views, as before.
    let oldReleased = false;
    // Set once omp answered: an abort after that leaves the open to finish, and a newer pick waits behind it.
    let answered = false;
    // Set once omp opened the chat: from then on a failure ends both views.
    let openedId: ThreadId | undefined;
    try {
      const result = await this.rpc.open(args, signal === undefined ? undefined : { signal });
      answered = true;
      openedCapabilities = result.capabilities;
      this.options.onPerfMark?.("rpc_open_returned");
      if (keepShown) {
        await this.closeNow(true, previous);
        oldReleased = true;
      }
      const threadId = result.threadId;
      openedId = threadId;
      // A chat left while its turn ran, and opened again now: this open takes over that chat's watch.
      watchHold = this.takeOverTurnWatch(threadId);
      if (watchHold) this.reopenedWhileRunning = threadId;
      // The store shown at the click serves the chat asked for; another chat omp opened gets its own store.
      const store =
        clickStore !== undefined && threadId === requested
          ? clickStore
          : (this.options.createStore?.(threadId, this.rpc) ?? this.defaultStore(threadId));
      const shownNow = store === clickStore;
      const loader =
        this.options.createLoader?.(threadId, this.rpc, store) ??
        this.defaultLoader(threadId, store);
      this.loader = loader;
      openedStore = store;
      // Shown now unless it was shown at the click, or it reopens in place (its transcript stays until it loads).
      if (!shownNow && (clickStore !== undefined || !keepShown)) {
        this.commit({
          threadId,
          store,
          capabilities: result.capabilities,
          isLoading: true,
          error: null,
          openedNew,
        });
        shownStore = store;
        this.options.onPerfMark?.("first_feedback");
        requestAnimationFrame(() => {
          if (
            document.querySelector('textarea[aria-label="Message input"]:not([disabled])') !== null
          )
            this.options.onPerfMark?.("composer_typable");
        });
        // The chat is on screen: a send that waited for it may go now, though its history still loads below.
        if (!keepShown) settle();
        if (this.closes === closesAtStart) this.options.onThreadIdChange?.(threadId);
        announced = threadId;
      }
      // The chat's stream starts at its first event the server still holds (afterSeq 0): the events omp sent before this
      // browser subscribed, such as a startup notice or the process becoming ready, reach the store in order. The history
      // load below reads what omp wrote to the session file.
      await this.attachSubscription(threadId, store, 0);
      await this.recordOpenQuestions(threadId, store);
      await this.recordStateFrames(threadId, store);
      await loader.loadInitial();
      this.historyRetryThread = undefined;
      this.options.onPerfMark?.("window_applied");
      requestAnimationFrame(() => this.options.onPerfMark?.("newest_20_painted"));
      this.stopRefetchWatch = loader.watchNeedsRefetch();
      this.commit({
        threadId,
        store,
        capabilities: result.capabilities,
        isLoading: false,
        isSwitching: false,
        error: null,
        openedNew,
      });
      if (keepShown && clickStore === undefined && this.closes === closesAtStart)
        this.options.onThreadIdChange?.(threadId);
      this.failedOpen = undefined;
      return store;
    } catch (error) {
      // A newer pick superseded this open before omp answered: the chat on screen is shown again, and nothing is
      // announced, since the newer pick owns the state (issue 2212).
      if (!answered && signal?.aborted) {
        if (clickStore !== undefined) this.restoreShown(previous, false);
        throw supersededOpen();
      }
      const failure = asFailure(error, "Opening the selected thread failed");
      // A failed switch: the chat on screen is shown again, subscribed and usable, and the failure goes to the caller.
      if (
        keepShown &&
        !oldReleased &&
        previous.store !== undefined &&
        previous.threadId !== undefined
      ) {
        if (failure.appError.code === "unavailable" && ticket === this.requests)
          this.failedOpen = requested;
        this.restoreShown(previous, this.closes === closesAtStart);
        throw failure;
      }
      // omp stopped while the chat was on screen, its history still loading: the chat stays, and its subscription carries
      // omp's exit to the chat's banner. Closing it here dropped that exit and the chat with it (issue 1707).
      if (
        shownStore !== undefined &&
        failure.appError.code === "omp_exited" &&
        this.state.store === shownStore &&
        this.subscription !== undefined
      ) {
        if (this.state.threadId !== undefined) this.historyRetryThread = this.state.threadId;
        this.commit({ isLoading: false, error: failure.appError });
        return shownStore;
      }
      if (
        oldReleased &&
        failure.appError.code === "omp_exited" &&
        this.subscription !== undefined &&
        openedId !== undefined &&
        openedStore !== undefined
      ) {
        this.historyRetryThread = openedId;
        this.commit({
          threadId: openedId,
          store: openedStore,
          capabilities: openedCapabilities,
          isLoading: false,
          isSwitching: false,
          error: failure.appError,
          openedNew,
        });
        if (this.closes === closesAtStart && announced !== openedId)
          this.options.onThreadIdChange?.(openedId);
        return openedStore;
      }
      // A dropped connection leaves the chat closed: the chat is opened again once the connection is back (issue 1617).
      if (failure.appError.code === "unavailable" && ticket === this.requests)
        this.failedOpen = requested;
      // The chat on screen was let go when the new chat opened, so the failure ends both views, as a failed open does. The
      // cleanup reads the chat it lets go from the state, so the state names the new chat first.
      if (oldReleased) this.commit({ threadId: openedId, store: undefined });
      await this.closeNow();
      // A refusal because another omp holds the chat is the chat's row line in the sidebar (see `openSession`), so the
      // empty screen does not repeat it.
      const shown = failure.appError.conflictReason === "held_elsewhere" ? null : failure.appError;
      this.commit({ isLoading: false, isSwitching: false, error: shown });
      throw failure;
    } finally {
      // The watch's hold goes once the open holds the chat, so the stream never drops in between.
      if (watchHold) {
        watchHold.unsubscribe().catch((error: unknown) => {
          console.error("[omp-app] could not let go a watched chat's hold", error);
        });
      }
    }
  }

  /** Shows the chat that was on screen before an open, as it was, subscribed (see `openNow`). */
  private restoreShown(previous: SelectedThreadHistoryState, announce: boolean): void {
    this.commit({
      threadId: previous.threadId,
      store: previous.store,
      capabilities: previous.capabilities,
      openedNew: previous.openedNew,
      isLoading: false,
      isSwitching: false,
      error: null,
    });
    if (announce) this.options.onThreadIdChange?.(previous.threadId);
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
      onLeafSwap: () => this.options.onPerfMark?.("leaf_swap"),
    });
  }

  private retryHistoryAfterRestart(
    threadId: ThreadId,
    loader: SessionHistoryLoader,
  ): Promise<void> {
    if (this.historyRetryThread !== threadId) return Promise.resolve();
    return this.retryInitialHistory(threadId, loader);
  }

  private async retryInitialHistory(
    threadId: ThreadId,
    loader: SessionHistoryLoader,
  ): Promise<void> {
    if (
      this.state.threadId !== threadId ||
      this.state.store === undefined ||
      this.loader !== loader
    ) {
      return;
    }
    this.historyRetryThread = undefined;
    this.commit({ isLoading: true, error: null });
    try {
      await loader.loadInitial();
      if (
        this.state.threadId !== threadId ||
        this.state.store === undefined ||
        this.loader !== loader
      ) {
        return;
      }
      this.historyRetryThread = undefined;
      this.stopRefetchWatch = loader.watchNeedsRefetch();
      this.commit({ isLoading: false, error: null });
    } catch (error) {
      const failure = asFailure(error, "Reloading the chat history failed");
      if (failure.appError.code === "cancelled") return;
      if (
        this.state.threadId !== threadId ||
        this.state.store === undefined ||
        this.loader !== loader
      ) {
        return;
      }
      if (failure.appError.code === "omp_exited") this.historyRetryThread = threadId;
      this.commit({ isLoading: false, error: failure.appError });
    }
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
    // A replayed event is applied as history: a question, host call or sign-in prompt in it is not asked again (see
    // `ingest`). The questions still open are recorded by `recordOpenQuestions`.
    const apply = (payload: ChatSessionEvent, seq: number, replayed: boolean) => {
      if (!baselined) {
        baselined = true;
        if (store.getSnapshot().lastSeq === 0) store.resetSequence(seq - 1);
      }
      store.ingest(payload, seq, replayed);
      if (
        payload.kind === "process" &&
        payload.status === "ready" &&
        this.historyRetryThread === threadId &&
        this.loader !== undefined
      ) {
        void this.retryHistoryAfterRestart(threadId, this.loader);
      }
      // A turn that was still running when this chat was opened again: the app is told when it ends.
      if (turnEnded(payload) && this.reopenedWhileRunning === threadId) {
        this.reopenedWhileRunning = undefined;
        this.options.onTurnSettled?.(threadId);
      }
      // After each settled turn, omp has persisted the turn: refetch so its messages pair with their entries (edit and
      // branch need entry ids) and get_state brings the model, context and usage. While the thread is still loading
      // (replayed settles), the initial load covers it.
      if (
        payload.kind === "event" &&
        payload.event.type === "session_settled" &&
        this.loader &&
        !this.state.isLoading
      ) {
        void this.loader.refreshAfterTurn().catch((error: unknown) => {
          const failure = asFailure(error, "Refreshing the session after the turn failed");
          if (failure.appError.code === "cancelled") return;
          // omp's exit is the chat's banner, so the refresh does not repeat it under "Earlier messages could not be
          // loaded." (issue 981). The rows stay. The refresh is redone when omp is back: the restart path reloads the chat
          // on omp's ready event, as it does after a failed first load.
          if (failure.appError.code === "omp_exited") {
            this.historyRetryThread = threadId;
            return;
          }
          this.commit({ error: failure.appError });
        });
      }
      // A `!` command that ended has no turn to settle, so its entry is read again. The read is queued behind the chat's load
      // when one is running: a settled turn's read is skipped during a load, and a `!` command's must not be, since nothing
      // else reads the entry. A replayed `!` command needs no read: the history the chat loads holds its entry.
      if (
        payload.kind === "shell" &&
        payload.method === "bash" &&
        payload.status === "ended" &&
        !replayed
      ) {
        void this.refreshAfterCommand();
      }
      const nextThreadId = this.sessionIdFromEvent(payload);
      if (nextThreadId && nextThreadId !== this.state.threadId) {
        void this.rekeyInProcess(nextThreadId);
      }
    };
    const onEvent = (payload: ChatSessionEvent, seq: number) => {
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
      subscription = await (this.client.subscribe(ChatSessionPort, "event", {
        scope: threadId,
        ...(afterSeq === undefined ? {} : { afterSeq }),
        onEvent,
      }) as Promise<EventSubscription>);
    } finally {
      replay = undefined;
    }
    this.subscription = subscription;
    this.watchRefused = false;
    this.offResync?.();
    this.offResync = this.client.onResync((event) => {
      if (event.reason !== "subscription-failed" || event.stream !== subscription.stream) return;
      this.watchRefused = true;
    });
    if (collected !== undefined) {
      for (const event of eventsAfterLastTurnEnd(collected)) apply(event.payload, event.seq, true);
    }
    // The same function as the handler above, so the client holds one listener. Its detach removes the handler when the
    // chat is left.
    this.offEvents = subscription.onEvent(onEvent);
  }

  /**
   * Records the questions omp is still waiting on, so their dialogs show again. The replay applies a question as history
   * and does not ask it again, because it cannot tell an answered question from an open one. The server keeps the open
   * ones (`openQuestions`), and only those are shown again.
   */
  private async recordOpenQuestions(threadId: ThreadId, store: OmpRuntimeStore): Promise<void> {
    const open = await this.rpc.openQuestions({ threadId });
    for (const question of open) store.recordOpenQuestion(question.request, question.seq);
  }

  /**
   * Shows the status, widgets and title omp holds for a chat when it is opened again. The replay covers only the events
   * after the last turn's end, so a status set earlier is not in it; the server keeps the latest of each (`stateFrames`).
   */
  private async recordStateFrames(threadId: ThreadId, store: OmpRuntimeStore): Promise<void> {
    const state = await this.rpc.stateFrames({ threadId });
    for (const frame of state) store.recordState(frame.request, frame.seq);
  }

  /** The chat's new id after a session switch (`moved`), or the id omp's own session update names. */
  private sessionIdFromEvent(payload: ChatSessionEvent): ThreadId | undefined {
    if (payload.kind === "moved") return payload.threadId;
    if (payload.kind !== "event" || payload.event.type !== "session_info_update") return undefined;
    return payload.event.sessionId as ThreadId;
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
    const streaming = store.getSnapshot().prompt.streaming;
    try {
      await this.attachSubscription(threadId, store);
      if (!streaming) await loader.refetch();
    } catch (error) {
      const failure = asFailure(error, "Refreshing the session after its id changed failed");
      if (failure.appError.code !== "cancelled") this.commit({ error: failure.appError });
    } finally {
      this.stopRefetchWatch = loader.watchNeedsRefetch();
      this.options.onThreadIdChange?.(threadId);
    }
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

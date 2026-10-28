import type {
  AppError,
  ChatSessionRequest,
  EntryId,
  Omp,
  PortCallOptions,
  SessionEntryOutputArgs,
  SessionEntryOutputResult,
  SessionEntryWindow,
  SessionEntryWindowArgs,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, SessionFilePath } from "@omp-app/contracts";
import type { OmpRuntimeStore } from "../store/store";

type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;
type SessionEntriesResult = Omp.SessionEntries;
type OperationKind = "refetch" | "sync";
interface InFlight {
  readonly controller: AbortController;
  readonly kind: OperationKind;
}

const SUPERSEDED_MESSAGE = "A newer history request superseded this one";
const CANCELLED_MESSAGE = "The history request was cancelled";

const INITIAL_WINDOW_BYTE_BUDGET = 256 * 1024;
const INITIAL_WINDOW_ENTRY_LIMIT = 50;

/** Lets the bounded first page paint before the larger default-window read begins. */
function afterPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
}

/** Reads one window of a session file's branch: the A1 `readEntryWindow` method. */
export type SessionWindowReader = (
  args: SessionEntryWindowArgs,
  options: { readonly signal: AbortSignalLike },
) => Promise<SessionEntryWindow>;

/** Reads one entry of a session file in full: the A1 `readEntryOutput` method. */
export type SessionOutputReader = (
  args: SessionEntryOutputArgs,
  options: { readonly signal: AbortSignalLike },
) => Promise<SessionEntryOutputResult>;

export interface SessionHistoryLoaderOptions {
  /** The chat session port's requests. */
  readonly send: ChatSessionRequest;
  readonly readWindow: SessionWindowReader;
  /** Reads one entry in full; a loader without it cannot load full tool outputs. */
  readonly readOutput?: SessionOutputReader;
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly onLeafSwap?: () => void;
  /** Called when an automatic (`watchNeedsRefetch`) refetch fails; cancellations are never reported. */
  readonly onRefetchError?: (error: AppFailure) => void;
}

function toAppFailure(error: unknown, fallbackMessage: string): AppFailure {
  if (error instanceof AppFailure) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new AppFailure({ code: "internal", message, retryable: true } satisfies AppError, {
    cause: error,
  });
}

function cancelledFailure(message: string): AppFailure {
  return new AppFailure({ code: "cancelled", message, retryable: false } satisfies AppError);
}

function asEntryIdOrNull(value: string | null): EntryId | null {
  return value === null ? null : (value as EntryId);
}

function limitInitialWindow(window: SessionEntryWindow): SessionEntryWindow {
  if (window.entries.length <= INITIAL_WINDOW_ENTRY_LIMIT) return window;
  const entries = window.entries.slice(-INITIAL_WINDOW_ENTRY_LIMIT);
  const oldest = entries[0]?.id;
  return {
    ...window,
    entries,
    oldestId: typeof oldest === "string" ? asEntryIdOrNull(oldest) : null,
    hasOlder: true,
  };
}

/** omp v18.9.1 records `/clear` as a `reset_boundary` entry with no payload; its context starts after the latest one (`packages/coding-agent/src/session/session-entries.ts:158-168`, `packages/coding-agent/src/session/session-context.ts:461-480`). */
function entriesAfterResetBoundary(entries: readonly unknown[]): readonly unknown[] {
  let boundary = -1;
  for (const [index, value] of entries.entries()) {
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "reset_boundary"
    ) {
      boundary = index;
    }
  }
  return boundary < 0 ? entries : entries.slice(boundary + 1);
}

/** True when `get_entries` rejected a stale `since` watermark; the caller should reload from the start. */
export function isUnknownSinceError(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.omp?.code === "unknown_since";
}

/**
 * Loads one open thread's history and feeds it to R0.1's `OmpRuntimeStore`. A thread's history is
 * not read whole: an initial page of the branch omp is on comes from its session file (A1's
 * `readEntryWindow`, bounded in bytes); omp confirms the leaf with `get_entries since` on that
 * page's last entry; then the rest of A1's default window fills after the first paint. Pages older
 * than that are read on demand (`loadOlder`). Without a session file (an in-memory session), omp's
 * `get_entries` supplies the entries. `get_tree` is not called: it returns the same entries nested.
 * `refetch` drives the store's own `needsRefetch` → refetch → `resetSequence` cycle;
 * `watchNeedsRefetch` arms that cycle automatically. Exactly one load or refetch is in flight at a
 * time: starting a new one cancels whichever is already running, and every rejection is a typed
 * `AppFailure`. Older pages run beside them, one at a time.
 */
export class SessionHistoryLoader {
  private readonly send: ChatSessionRequest;
  private readonly windows: SessionWindowReader;
  private readonly outputs: SessionOutputReader | undefined;
  private readonly threadId: ThreadId;
  private readonly store: OmpRuntimeStore;
  private readonly onLeafSwap: (() => void) | undefined;
  private readonly onRefetchError: ((error: AppFailure) => void) | undefined;
  private inFlight: InFlight | undefined;
  /** The open thread's session file, from `get_state`: where windows are read. */
  private sessionFile: SessionFilePath | undefined;
  private olderLoad: Promise<void> | undefined;
  private olderController: AbortController | undefined;
  private backgroundFillPromise: Promise<void> | undefined;
  private backgroundFillController: AbortController | undefined;
  private backgroundFillFailure: AppFailure | undefined;

  public constructor(options: SessionHistoryLoaderOptions) {
    this.send = options.send;
    this.windows = options.readWindow;
    this.outputs = options.readOutput;
    this.threadId = options.threadId;
    this.store = options.store;
    this.onLeafSwap = options.onLeafSwap;
    this.onRefetchError = options.onRefetchError;
  }

  /** The newest part of the thread's history, for a freshly opened store. */
  public async loadInitial(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    let initialWindow: SessionEntryWindow | undefined;
    await this.run("refetch", options?.signal, async (signal) => {
      await this.applyState(signal);
      // Entries last, right before the cursor moves: anything persisted after this read arrives as a
      // live event once the gap is cleared.
      initialWindow = await this.applyWindow(signal, true);
      this.store.resetSequence();
    });
    if (initialWindow !== undefined) this.scheduleDefaultWindowFill(initialWindow);
  }

  /** Reloads history after the store reports `needsRefetch`, then clears the gap. */
  public async refetch(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    await this.run("refetch", options?.signal, async (signal) => {
      await this.applyState(signal);
      await this.applyEntries(this.latestKnownEntryId(), signal);
      this.store.resetSequence();
    });
  }

  /**
   * After a settled turn: omp's state (model, context, usage) and the entries the turn appended, so
   * its messages pair with their entries. No cursor move: the stream had no gap.
   */
  public async refreshAfterTurn(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    await this.run("sync", options?.signal, async (signal) => {
      await this.applyState(signal);
      await this.applyEntries(this.latestKnownEntryId(), signal);
    });
  }

  /**
   * Finishes the initial default-window fill before asking for an even older page. Concurrent callers
   * share either operation; `dispose()` cancels it.
   */
  public loadOlder(): Promise<void> {
    const backgroundFill = this.backgroundFillPromise;
    if (backgroundFill !== undefined) {
      return backgroundFill.then(
        () => this.loadOlder(),
        (error: unknown) => {
          const failure =
            this.backgroundFillFailure ??
            toAppFailure(error, "Loading older session history failed");
          this.backgroundFillFailure = undefined;
          throw failure;
        },
      );
    }
    if (this.backgroundFillFailure !== undefined) {
      const failure = this.backgroundFillFailure;
      this.backgroundFillFailure = undefined;
      return Promise.reject(failure);
    }
    this.olderLoad ??= this.fetchOlder().finally(() => {
      this.olderLoad = undefined;
    });
    return this.olderLoad;
  }

  /**
   * Loads the full text of one tool output the store shows shortened: omp's entry is read from the
   * session file and replaces the shortened one. A thread without a session file has no entry to read.
   */
  public async loadFullOutput(toolCallId: string): Promise<void> {
    const sessionFile = this.sessionFile;
    const entryId = this.toolResultEntryId(toolCallId);
    const outputs = this.outputs;
    if (outputs === undefined) {
      throw new AppFailure({
        code: "unavailable",
        message: "Full tool outputs are unavailable for this thread",
        retryable: false,
        capability: "host.session-files",
      });
    }
    if (sessionFile === undefined || entryId === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: "This tool output is not in the loaded history",
        retryable: false,
      });
    }
    try {
      const full = await outputs(
        { sessionFile, entryId },
        { signal: new AbortController().signal },
      );
      this.store.replaceHistoryEntry(full.entry);
    } catch (error) {
      throw toAppFailure(error, "Loading the full output failed");
    }
  }

  /** The entry of the tool result the store shows for one tool call. */
  private toolResultEntryId(toolCallId: string): EntryId | undefined {
    const snapshot = this.store.getSnapshot();
    for (const key of snapshot.messageOrder) {
      const record = snapshot.messages[key];
      if (record?.message.role === "toolResult" && record.message.toolCallId === toolCallId) {
        return record.entryId;
      }
    }
    return undefined;
  }

  /**
   * Starts watching the store for `needsRefetch`; each transition to `true` triggers exactly one
   * `refetch()`. Returns a function that stops watching; an already-running operation keeps going.
   */
  public watchNeedsRefetch(): () => void {
    const trigger = (): void => {
      // A sync request keeps the gap open, so a gap during one starts a refetch that supersedes it.
      if (!this.store.getSnapshot().needsRefetch || this.inFlight?.kind === "refetch") return;
      this.refetch().catch((error: unknown) => {
        const failure = toAppFailure(error, "The automatic history refetch failed");
        if (failure.appError.code === "cancelled") return;
        this.onRefetchError?.(failure);
      });
    };
    const unsubscribe = this.store.subscribe(trigger);
    trigger();
    return unsubscribe;
  }

  /** Cancels any in-flight request, older page, or default-window fill; safe to call repeatedly. */
  public dispose(): void {
    this.inFlight?.controller.abort(SUPERSEDED_MESSAGE);
    this.inFlight = undefined;
    this.olderController?.abort(CANCELLED_MESSAGE);
    this.olderController = undefined;
    this.backgroundFillController?.abort(CANCELLED_MESSAGE);
    this.backgroundFillController = undefined;
    this.backgroundFillPromise = undefined;
    this.backgroundFillFailure = undefined;
  }

  private async applyState(signal: AbortSignalLike): Promise<void> {
    // The answer describes omp as of this request: the store keeps any run event that arrives after it.
    const asOfSeq = this.store.getSnapshot().lastSeq;
    const state = await this.send(
      { threadId: this.threadId, method: "get_state", params: {} },
      { signal },
    );
    this.store.applySessionState(state, { asOfSeq });
    const file = SessionFilePath.safeParse(state.sessionFile);
    this.sessionFile = file.success ? file.data : undefined;
  }

  /**
   * The newest window of the branch omp is on. The session file supplies the window; omp confirms
   * its leaf and adds whatever was written after the window's last entry, so the store starts from
   * what omp holds. When omp is on another leaf than the window walked, the window is read again
   * from that leaf.
   */
  private async applyWindow(
    signal: AbortSignalLike,
    forInitialLoad = false,
  ): Promise<SessionEntryWindow | undefined> {
    const sessionFile = this.sessionFile;
    if (sessionFile === undefined) {
      await this.applyEntries(undefined, signal);
      this.store.setHasOlder(false);
      return undefined;
    }
    const windowArgs: SessionEntryWindowArgs = forInitialLoad
      ? { sessionFile, byteBudget: INITIAL_WINDOW_BYTE_BUDGET }
      : { sessionFile };
    let newest: SessionEntryWindow;
    try {
      newest = await this.windows(windowArgs, { signal });
    } catch (error) {
      // omp writes a new chat's session file with its first entry: until then the session store does
      // not list it, and omp's own entries are the whole history.
      if (!(error instanceof AppFailure) || error.appError.code !== "not_found") throw error;
      await this.applyEntries(undefined, signal);
      this.store.setHasOlder(false);
      return undefined;
    }
    const live = await this.getEntries(newest.fileLastId ?? undefined, signal);
    const leafId = asEntryIdOrNull(live.leafId);
    if (leafId === null) {
      const visible = entriesAfterResetBoundary(live.entries);
      this.store.pairEndedMessages(visible, null);
      this.store.setHasOlder(false);
      return undefined;
    }
    if (leafId !== newest.leafId) this.onLeafSwap?.();
    const branchWindow =
      leafId === newest.leafId ? newest : await this.windows({ ...windowArgs, leafId }, { signal });
    const window = forInitialLoad ? limitInitialWindow(branchWindow) : branchWindow;
    const entries = [...window.entries, ...live.entries];
    const visible = entriesAfterResetBoundary(entries);
    this.store.pairEndedMessages(visible, leafId);
    const hasOlder = window.hasOlder && visible.length === entries.length;
    this.store.setHasOlder(hasOlder);
    return hasOlder ? branchWindow : undefined;
  }

  /**
   * Applies the entries after `since`, the latest one the store knows. When omp no longer knows that
   * entry (the session was rewritten under it), the newest window is read again instead: never the
   * whole history.
   */
  private async applyEntries(since: EntryId | undefined, signal: AbortSignalLike): Promise<void> {
    try {
      const result = await this.getEntries(since, signal);
      this.store.pairEndedMessages(
        entriesAfterResetBoundary(result.entries),
        asEntryIdOrNull(result.leafId),
      );
    } catch (error) {
      if (since === undefined || !isUnknownSinceError(error)) throw error;
      await this.applyWindow(signal);
    }
  }

  private async fetchOlder(): Promise<void> {
    const sessionFile = this.sessionFile;
    const { transcript } = this.store.getSnapshot();
    const before = this.oldestLoadedBranchEntry();
    if (sessionFile === undefined || transcript.head === null || before === undefined) return;
    if (!transcript.hasOlder) return;
    const controller = new AbortController();
    this.olderController = controller;
    try {
      const page = await this.windows(
        { sessionFile, leafId: transcript.head, before },
        { signal: controller.signal },
      );
      const visible = entriesAfterResetBoundary(page.entries);
      this.store.prependHistoryEntries(
        visible,
        page.hasOlder && visible.length === page.entries.length,
      );
    } catch (error) {
      if (controller.signal.aborted) throw cancelledFailure(CANCELLED_MESSAGE);
      throw toAppFailure(error, "Loading older session history failed");
    } finally {
      if (this.olderController === controller) this.olderController = undefined;
    }
  }

  /** Reads the ordinary default window after the bounded initial page has had a paint opportunity. */
  private scheduleDefaultWindowFill(window: SessionEntryWindow): void {
    this.backgroundFillController?.abort(SUPERSEDED_MESSAGE);
    const controller = new AbortController();
    this.backgroundFillController = controller;
    this.backgroundFillFailure = undefined;
    let backgroundFill: Promise<void>;
    backgroundFill = afterPaint()
      .then(() => this.fillDefaultWindow(window, controller.signal))
      .finally(() => {
        if (this.backgroundFillController === controller) this.backgroundFillController = undefined;
        if (this.backgroundFillPromise === backgroundFill) this.backgroundFillPromise = undefined;
      });
    this.backgroundFillPromise = backgroundFill;
    void backgroundFill.catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.backgroundFillFailure = toAppFailure(error, "Loading older session history failed");
    });
  }

  /** Prepends the default window through the store's deduplicating older-history path. */
  private async fillDefaultWindow(
    window: SessionEntryWindow,
    signal: AbortSignalLike,
  ): Promise<void> {
    const { sessionFile, leafId } = window;
    if (signal.aborted) throw cancelledFailure(CANCELLED_MESSAGE);
    if (leafId === null || this.sessionFile !== sessionFile || !this.isOnCurrentBranch(leafId))
      return;
    const defaultWindow = await this.windows({ sessionFile, leafId }, { signal });
    if (signal.aborted) throw cancelledFailure(CANCELLED_MESSAGE);
    if (
      this.sessionFile !== sessionFile ||
      defaultWindow.leafId !== leafId ||
      !this.isOnCurrentBranch(leafId)
    ) {
      return;
    }
    const visible = entriesAfterResetBoundary(defaultWindow.entries);
    this.store.prependHistoryEntries(
      visible,
      defaultWindow.hasOlder && visible.length === defaultWindow.entries.length,
    );
  }

  /** The oldest loaded entry on the branch from the transcript's head: the paging cursor. */
  private oldestLoadedBranchEntry(): EntryId | undefined {
    const { transcript } = this.store.getSnapshot();
    const seen = new Set<EntryId>();
    let oldest: EntryId | undefined;
    let current = transcript.head;
    while (current !== null && !seen.has(current)) {
      const entry = transcript.entries[current];
      if (entry === undefined) break;
      seen.add(current);
      oldest = current;
      current = entry.parentId;
    }
    return oldest;
  }
  private isOnCurrentBranch(entryId: EntryId): boolean {
    const { transcript } = this.store.getSnapshot();
    const seen = new Set<EntryId>();
    let current = transcript.head;
    while (current !== null && !seen.has(current)) {
      if (current === entryId) return true;
      seen.add(current);
      const entry = transcript.entries[current];
      if (entry === undefined) break;
      current = entry.parentId;
    }
    return false;
  }

  private async getEntries(
    since: EntryId | undefined,
    signal: AbortSignalLike,
  ): Promise<SessionEntriesResult> {
    return this.send(
      {
        threadId: this.threadId,
        method: "get_entries",
        params: since === undefined ? {} : { since },
      },
      { signal },
    );
  }

  private latestKnownEntryId(): EntryId | undefined {
    return this.store.getSnapshot().transcript.order.at(-1);
  }

  private cancelledError(controller: AbortController): AppFailure {
    const reason = controller.signal.reason;
    return cancelledFailure(typeof reason === "string" ? reason : CANCELLED_MESSAGE);
  }

  private async run(
    kind: OperationKind,
    externalSignal: AbortSignalLike | undefined,
    task: (signal: AbortSignalLike) => Promise<void>,
  ): Promise<void> {
    if (kind === "refetch") this.backgroundFillFailure = undefined;
    this.inFlight?.controller.abort(SUPERSEDED_MESSAGE);
    const controller = new AbortController();
    const operation: InFlight = { controller, kind };
    this.inFlight = operation;
    const forwardAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      if (controller.signal.aborted) throw this.cancelledError(controller);
      await task(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw this.cancelledError(controller);
      throw toAppFailure(error, "The history request failed");
    } finally {
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (this.inFlight === operation) this.inFlight = undefined;
    }
  }
}

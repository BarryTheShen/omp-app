import type {
  AppError,
  EntryId,
  OmpWire,
  PortCallOptions,
  RpcSessionSend,
  SessionEntryOutputArgs,
  SessionEntryOutputResult,
  SessionEntryWindow,
  SessionEntryWindowArgs,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, SessionFilePath } from "@omp-app/contracts";
import type { OmpRuntimeStore } from "../store/store";

type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;
type SessionState = OmpWire.SessionState;
type SessionEntriesResult = OmpWire.SessionEntries;
type OperationKind = "refetch" | "sync";
interface InFlight {
  readonly controller: AbortController;
  readonly kind: OperationKind;
}

const SUPERSEDED_MESSAGE = "A newer history request superseded this one";
const CANCELLED_MESSAGE = "The history request was cancelled";

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
  readonly send: RpcSessionSend;
  readonly readWindow: SessionWindowReader;
  /** Reads one entry in full; a loader without it cannot load full tool outputs. */
  readonly readOutput?: SessionOutputReader;
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
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
 * not read whole: the newest window of the branch omp is on comes from its session file (A1's
 * `readEntryWindow`, bounded in bytes), omp confirms the leaf with a `get_entries since` on the
 * window's last entry, and older windows are read on demand (`loadOlder`). Without a session file
 * (an in-memory session) omp's `get_entries` supplies the entries. `get_tree` is not called: it
 * returns the same entries nested.
 * `refetch` drives the store's own `needsRefetch` → refetch → `resetSequence` cycle;
 * `watchNeedsRefetch` arms that cycle automatically. Exactly one load or refetch is in flight at a
 * time: starting a new one cancels whichever is already running, and every rejection is a typed
 * `AppFailure`. Older pages run beside them, one at a time.
 */
export class SessionHistoryLoader {
  private readonly send: RpcSessionSend;
  private readonly windows: SessionWindowReader;
  private readonly outputs: SessionOutputReader | undefined;
  private readonly threadId: ThreadId;
  private readonly store: OmpRuntimeStore;
  private readonly onRefetchError: ((error: AppFailure) => void) | undefined;
  private inFlight: InFlight | undefined;
  /** The open thread's session file, from `get_state`: where windows are read. */
  private sessionFile: SessionFilePath | undefined;
  private olderLoad: Promise<void> | undefined;
  private olderController: AbortController | undefined;

  public constructor(options: SessionHistoryLoaderOptions) {
    this.send = options.send;
    this.windows = options.readWindow;
    this.outputs = options.readOutput;
    this.threadId = options.threadId;
    this.store = options.store;
    this.onRefetchError = options.onRefetchError;
  }

  /** The newest part of the thread's history, for a freshly opened store. */
  public async loadInitial(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    await this.run("refetch", options?.signal, async (signal) => {
      await this.applyState(signal);
      // Entries last, right before the cursor moves: anything persisted after this read arrives as a
      // live event once the gap is cleared.
      await this.applyWindow(signal);
      this.store.resetSequence();
    });
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
   * Loads the page of entries older than the oldest one loaded on the branch the transcript shows.
   * A page already loading is shared by every caller; `dispose()` cancels it.
   */
  public loadOlder(): Promise<void> {
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

  /** Cancels any in-flight request or older page; safe to call repeatedly. */
  public dispose(): void {
    this.inFlight?.controller.abort(SUPERSEDED_MESSAGE);
    this.inFlight = undefined;
    this.olderController?.abort(CANCELLED_MESSAGE);
    this.olderController = undefined;
  }

  private async applyState(signal: AbortSignalLike): Promise<void> {
    // The answer describes omp as of this request: the store keeps any run event that arrives after it.
    const asOfSeq = this.store.getSnapshot().lastSeq;
    const state = (await this.send(
      { threadId: this.threadId, command: { type: "get_state" } },
      { signal },
    )) as SessionState;
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
  private async applyWindow(signal: AbortSignalLike): Promise<void> {
    const sessionFile = this.sessionFile;
    if (sessionFile === undefined) {
      await this.applyEntries(undefined, signal);
      this.store.setHasOlder(false);
      return;
    }
    let newest: SessionEntryWindow;
    try {
      newest = await this.windows({ sessionFile }, { signal });
    } catch (error) {
      // omp writes a new chat's session file with its first entry: until then the session store does
      // not list it, and omp's own entries are the whole history.
      if (!(error instanceof AppFailure) || error.appError.code !== "not_found") throw error;
      await this.applyEntries(undefined, signal);
      this.store.setHasOlder(false);
      return;
    }
    const live = await this.getEntries(newest.fileLastId ?? undefined, signal);
    const leafId = asEntryIdOrNull(live.leafId);
    if (leafId === null) {
      const visible = entriesAfterResetBoundary(live.entries);
      this.store.pairEndedMessages(visible, null);
      this.store.setHasOlder(false);
      return;
    }
    const window =
      leafId === newest.leafId ? newest : await this.windows({ sessionFile, leafId }, { signal });
    const entries = [...window.entries, ...live.entries];
    const visible = entriesAfterResetBoundary(entries);
    this.store.pairEndedMessages(visible, leafId);
    this.store.setHasOlder(window.hasOlder && visible.length === entries.length);
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

  private async getEntries(
    since: EntryId | undefined,
    signal: AbortSignalLike,
  ): Promise<SessionEntriesResult> {
    const result = await this.send(
      { threadId: this.threadId, command: { type: "get_entries", since } },
      { signal },
    );
    return result as SessionEntriesResult;
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

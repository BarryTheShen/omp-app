import type {
  AppError,
  EntryId,
  OmpWire,
  PortCallOptions,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { OmpRuntimeStore } from "../store/store";

type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;
type SessionState = OmpWire.SessionState;
type SessionEntriesResult = OmpWire.SessionEntries;
type SessionTreeResult = OmpWire.SessionTree;

const SUPERSEDED_MESSAGE = "A newer history request superseded this one";
const CANCELLED_MESSAGE = "The history request was cancelled";

export interface SessionHistoryLoaderOptions {
  readonly send: RpcSessionSend;
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  /** Called when an automatic (`watchNeedsRefetch`) refetch fails; cancellations are never reported. */
  readonly onRefetchError?: (error: AppFailure) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/** True when `get_entries` rejected a stale `since` watermark; the caller should reload from the start. */
export function isUnknownSinceError(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.omp?.code === "unknown_since";
}

/**
 * Flattens `get_tree`'s nested `{ entry, children }[]` into the same flat entry shape `get_entries`
 * returns, parent before children. Walked iteratively: one linear conversation nests one entry per
 * turn, so a recursive walk would risk the call stack on a long session.
 */
export function flattenSessionTree(tree: readonly unknown[]): unknown[] {
  const flat: unknown[] = [];
  const stack: unknown[] = [...tree].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    if (node.entry !== undefined) flat.push(node.entry);
    const children = node.children;
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
  }
  return flat;
}

/**
 * Loads one open thread's history from omp (Plan item 1: `get_state`, `get_entries`, `get_tree`)
 * and feeds it to R0.1's `OmpRuntimeStore`. `refetch` drives the store's own
 * `needsRefetch` → refetch → `resetSequence` cycle; `watchNeedsRefetch` arms that cycle
 * automatically. Exactly one load or refetch is in flight at a time: starting a new one cancels
 * whichever is already running, and every rejection is a typed `AppFailure`.
 */
export class SessionHistoryLoader {
  private readonly send: RpcSessionSend;
  private readonly threadId: ThreadId;
  private readonly store: OmpRuntimeStore;
  private readonly onRefetchError: ((error: AppFailure) => void) | undefined;
  private controller: AbortController | undefined;

  public constructor(options: SessionHistoryLoaderOptions) {
    this.send = options.send;
    this.threadId = options.threadId;
    this.store = options.store;
    this.onRefetchError = options.onRefetchError;
  }

  /** The thread's full history, for a freshly opened store. */
  public async loadInitial(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    await this.run(options?.signal, async (signal) => {
      await this.applyState(signal);
      await this.applyTree(signal);
      // Entries last, right before the cursor moves: anything persisted after this read arrives as a
      // live event once the gap is cleared.
      await this.applyEntries(undefined, signal);
      this.store.resetSequence();
    });
  }

  /** Reloads history after the store reports `needsRefetch`, then clears the gap. */
  public async refetch(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    await this.run(options?.signal, async (signal) => {
      await this.applyState(signal);
      await this.applyTree(signal);
      await this.applyEntries(this.latestKnownEntryId(), signal);
      this.store.resetSequence();
    });
  }

  /**
   * Starts watching the store for `needsRefetch`; each transition to `true` triggers exactly one
   * `refetch()`. Returns a function that stops watching; an already-running operation keeps going.
   */
  public watchNeedsRefetch(): () => void {
    const trigger = (): void => {
      if (!this.store.getSnapshot().needsRefetch || this.controller !== undefined) return;
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

  /** Cancels any in-flight load or refetch; safe to call repeatedly. */
  public dispose(): void {
    this.controller?.abort(SUPERSEDED_MESSAGE);
    this.controller = undefined;
  }

  private async applyState(signal: AbortSignalLike): Promise<void> {
    const state = await this.send(
      { threadId: this.threadId, command: { type: "get_state" } },
      { signal },
    );
    this.store.applySessionState(state as SessionState);
  }

  private async applyEntries(since: EntryId | undefined, signal: AbortSignalLike): Promise<void> {
    const result = await this.getEntriesWithFallback(since, signal);
    this.store.pairEndedMessages(result.entries, asEntryIdOrNull(result.leafId));
  }

  private async getEntriesWithFallback(
    since: EntryId | undefined,
    signal: AbortSignalLike,
  ): Promise<SessionEntriesResult> {
    if (since === undefined) return this.getEntries(undefined, signal);
    try {
      return await this.getEntries(since, signal);
    } catch (error) {
      if (!isUnknownSinceError(error)) throw error;
      return this.getEntries(undefined, signal);
    }
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

  private async applyTree(signal: AbortSignalLike): Promise<void> {
    const result = await this.send(
      { threadId: this.threadId, command: { type: "get_tree" } },
      { signal },
    );
    const tree = result as SessionTreeResult;
    this.store.setTree(flattenSessionTree(tree.tree), asEntryIdOrNull(tree.leafId));
  }

  private latestKnownEntryId(): EntryId | undefined {
    return this.store.getSnapshot().transcript.order.at(-1);
  }

  private cancelledError(controller: AbortController): AppFailure {
    const reason = controller.signal.reason;
    return cancelledFailure(typeof reason === "string" ? reason : CANCELLED_MESSAGE);
  }

  private async run(
    externalSignal: AbortSignalLike | undefined,
    task: (signal: AbortSignalLike) => Promise<void>,
  ): Promise<void> {
    this.controller?.abort(SUPERSEDED_MESSAGE);
    const controller = new AbortController();
    this.controller = controller;
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
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

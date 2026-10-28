import type {
  CapabilityMap,
  ChatSessionRequest,
  EntryId,
  Omp,
  PortCallOptions,
  SessionFilePath,
  ThreadId,
} from "@omp-app/contracts";
import {
  AppFailure,
  SessionFilePath as SessionFilePathSchema,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import type { OmpBranchingController } from "@/modules/R0/branching";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store/store";
import type {
  BranchRequest,
  ConversationBranchResult,
  ForkPort,
  ForkRequest,
  ForkResult,
} from "../contract";

/** The source store is read-only to a transition; R0 remains the one runtime state owner. */
type SourceStore = Pick<OmpRuntimeStore, "getSnapshot">;
type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;
type BranchingController = Pick<OmpBranchingController, "switchTo">;

/** The R0.4 seam used after omp reports the new session identity. */
export interface ConversationTransitionOptions {
  readonly store: SourceStore;
  /** The chat session port's requests, as the app guards them. */
  readonly send: ChatSessionRequest;
  /** R0.4 owns thread switching and history reload; P4 never creates a second reload path. */
  readonly branchingController: BranchingController;
  readonly capabilities?: CapabilityMap;
  /** Optional host busy signal for queued/background work that is not represented by streaming. */
  readonly isBusy?: () => boolean;
  /** The chat picks made so far. A rewind or fork that finishes after a pick does not switch the view. */
  readonly pickCount: () => number;
}
/** Immutable source state retained for retry/rollback UI when a transition cannot publish. */
export interface ConversationSourceSnapshot {
  readonly threadId: ThreadId;
  readonly snapshot: RuntimeSnapshot;
}

/** Typed P4 transition port over omp's branch/fork commands. */
export interface ConversationTransitionPort extends ForkPort {
  getCapabilities(): CapabilityMap;
  updateCapabilities(capabilities: CapabilityMap): void;
  getRetainedSource(): ConversationSourceSnapshot | null;
  clearRetainedSource(): void;
}

const EMPTY_CAPABILITIES: CapabilityMap = Object.freeze({});
const BRANCH_CAPABILITY = "omp.cmd.branch" as const;
const FORK_CAPABILITY = "omp.cmd.fork" as const;

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

function unavailable(
  capability: typeof BRANCH_CAPABILITY | typeof FORK_CAPABILITY,
  action: string,
): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: `${action} isn't available with this version of omp.`,
    retryable: false,
    capability,
  });
}

function conflict(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: true });
}

function cancelled(message: string): AppFailure {
  return new AppFailure({ code: "cancelled", message, retryable: false });
}

function invalidIdentity(message: string, cause?: unknown): AppFailure {
  return new AppFailure(
    { code: "internal", message, retryable: true },
    cause === undefined ? undefined : { cause },
  );
}

function throwIfAborted(signal: AbortSignalLike | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw cancelled(
    typeof reason === "string" ? reason : "The conversation transition was cancelled",
  );
}

function sessionFileFromState(state: { readonly sessionFile?: string }): SessionFilePath | null {
  if (state.sessionFile === undefined) return null;
  try {
    return SessionFilePathSchema.parse(state.sessionFile);
  } catch (error) {
    throw invalidIdentity("omp returned an invalid session file identity", error);
  }
}

function sessionIdFromState(state: { readonly sessionId: string }): ThreadId {
  try {
    return ThreadIdSchema.parse(state.sessionId);
  } catch (error) {
    throw invalidIdentity("omp returned an invalid session identity", error);
  }
}

function branchResult(value: unknown): Omp.BranchResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIdentity("omp returned an invalid branch result");
  }
  const result = value as { readonly text?: unknown; readonly cancelled?: unknown };
  if (typeof result.text !== "string" || typeof result.cancelled !== "boolean") {
    throw invalidIdentity("omp returned an invalid branch result");
  }
  return { text: result.text, cancelled: result.cancelled };
}

function forkResult(value: unknown): Omp.CancellationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIdentity("omp returned an invalid fork result");
  }
  const result = value as { readonly cancelled?: unknown };
  if (typeof result.cancelled !== "boolean") {
    throw invalidIdentity("omp returned an invalid fork result");
  }
  return { cancelled: result.cancelled };
}

function cancelledResult(
  sourceThreadId: ThreadId,
  entryId: EntryId | null,
  wording: "conversation rewind",
): ConversationBranchResult;
function cancelledResult(
  sourceThreadId: ThreadId,
  entryId: EntryId | null,
  wording?: undefined,
): ForkResult;
function cancelledResult(
  sourceThreadId: ThreadId,
  entryId: EntryId | null,
  wording?: "conversation rewind",
): ForkResult | ConversationBranchResult {
  const result = {
    sourceThreadId,
    threadId: sourceThreadId,
    entryId,
    sessionFile: null,
    cancelled: true,
    reloaded: false,
    sourceRetained: true as const,
  };
  return wording === undefined ? result : { ...result, wording };
}

/**
 * P4's conversation-only branch/fork adapter.
 *
 * omp v18.12.6 exposes `branch { entryId }` and `fork { entryId? }` as session RPCs
 * (`docs/rpc.md:229-238`; the RPC dispatcher calls
 * `session.branch(entryId)` and `session.fork(entryId, { requireIdle: true })` at
 * `packages/coding-agent/src/modes/rpc/rpc-mode.ts:885-898`; wire
 * params/results are copied in
 * `packages/contracts/src/omp-wire/rpc-wire.generated.ts:553-555,1570-1576,1681-1682`).
 * `branch` returns text plus cancellation, while `fork` returns cancellation only; both require a
 * follow-up `get_state` to learn the new `sessionId`/`sessionFile`. R0.4's `switchTo` seam
 * (`apps/web/src/modules/R0/branching/branching.ts:142-149`) performs the selected-thread switch
 * and history reload. No prompt, session-file write, or workspace action is used here.
 */
export class OmpConversationTransitionPort implements ConversationTransitionPort {
  private readonly store: SourceStore;
  private readonly send: ChatSessionRequest;
  private readonly branchingController: BranchingController;
  private readonly isBusy: (() => boolean) | undefined;
  private readonly pickCount: () => number;
  private capabilities: CapabilityMap;
  private transitioning = false;
  private retainedSource: ConversationSourceSnapshot | null = null;

  public constructor(options: ConversationTransitionOptions) {
    this.store = options.store;
    this.send = options.send;
    this.branchingController = options.branchingController;
    this.isBusy = options.isBusy;
    this.capabilities = options.capabilities ?? EMPTY_CAPABILITIES;
    this.pickCount = options.pickCount;
  }

  public getCapabilities(): CapabilityMap {
    return this.capabilities;
  }

  public updateCapabilities(capabilities: CapabilityMap): void {
    this.capabilities = capabilities;
  }

  public getRetainedSource(): ConversationSourceSnapshot | null {
    return this.retainedSource;
  }

  public clearRetainedSource(): void {
    this.retainedSource = null;
  }
  public async branch(request: BranchRequest): Promise<ConversationBranchResult> {
    throwIfAborted(request.signal);
    const sourceThreadId = this.prepare(request.threadId, BRANCH_CAPABILITY, "Conversation rewind");
    const picks = this.pickCount();
    try {
      let result: Omp.BranchResult;
      try {
        result = branchResult(
          await this.send(
            { threadId: sourceThreadId, method: "branch", params: { entryId: request.entryId } },
            request.signal === undefined ? undefined : { signal: request.signal },
          ),
        );
      } catch (error) {
        const failure = asFailure(error, "The conversation rewind failed");
        if (failure.appError.code === "cancelled") {
          await this.reconcileIdentityAfterCancellation(sourceThreadId);
        }
        throw failure;
      }
      if (result.cancelled) {
        return cancelledResult(sourceThreadId, request.entryId, "conversation rewind");
      }

      const identity = await this.reloadIdentity(
        sourceThreadId,
        "The branched session did not become available",
        picks,
      );
      return {
        sourceThreadId,
        threadId: identity.threadId,
        entryId: request.entryId,
        sessionFile: identity.sessionFile,
        cancelled: false,
        reloaded: identity.switched,
        sourceRetained: true,
        wording: "conversation rewind",
      };
    } finally {
      this.transitioning = false;
    }
  }

  public async fork(request: ForkRequest): Promise<ForkResult> {
    throwIfAborted(request.signal);
    const sourceThreadId = this.prepare(request.threadId, FORK_CAPABILITY, "Conversation fork");
    const picks = this.pickCount();
    try {
      let result: Omp.CancellationResult;
      try {
        result = forkResult(
          await this.send(
            {
              threadId: sourceThreadId,
              method: "fork",
              params: request.entryId === undefined ? {} : { entryId: request.entryId },
            },
            request.signal === undefined ? undefined : { signal: request.signal },
          ),
        );
      } catch (error) {
        const failure = asFailure(error, "The conversation fork failed");
        if (failure.appError.code === "cancelled") {
          await this.reconcileIdentityAfterCancellation(sourceThreadId);
        }
        throw failure;
      }
      if (result.cancelled) {
        return cancelledResult(sourceThreadId, request.entryId ?? null);
      }

      const identity = await this.reloadIdentity(
        sourceThreadId,
        "The forked session did not become available",
        picks,
      );
      return {
        sourceThreadId,
        threadId: identity.threadId,
        entryId: request.entryId ?? null,
        sessionFile: identity.sessionFile,
        cancelled: false,
        reloaded: identity.switched,
        sourceRetained: true,
      };
    } finally {
      this.transitioning = false;
    }
  }

  private prepare(
    requestThreadId: ThreadId,
    capability: typeof BRANCH_CAPABILITY | typeof FORK_CAPABILITY,
    action: string,
  ): ThreadId {
    if (this.capabilities[capability]?.state !== "available") {
      throw unavailable(capability, action);
    }
    if (this.transitioning) {
      throw conflict("Another conversation transition is already in progress");
    }
    const source = this.store.getSnapshot();
    if (source.threadId !== requestThreadId) {
      throw conflict("The selected conversation changed before the transition started");
    }
    if (
      source.prompt.streaming ||
      (source.prompt.admitted && !source.prompt.sessionSettled) ||
      this.isBusy?.() === true
    ) {
      throw conflict(`${action} is unavailable while the conversation is busy`);
    }
    this.retainedSource = { threadId: source.threadId, snapshot: source };
    this.transitioning = true;
    return source.threadId;
  }

  private async reconcileIdentityAfterCancellation(sourceThreadId: ThreadId): Promise<void> {
    try {
      // The command may already have changed omp's session before A0 observes the cancellation.
      // Reconcile without the aborted signal so R0 can hydrate that new identity if needed.
      const state = await this.send({
        threadId: sourceThreadId,
        method: "get_state",
        params: {},
      });
      const threadId = sessionIdFromState(state);
      if (threadId !== sourceThreadId) await this.branchingController.switchTo(threadId);
    } catch (error) {
      throw asFailure(
        error,
        "The conversation identity could not be reconciled after cancellation",
      );
    }
  }

  private async reloadIdentity(
    sourceThreadId: ThreadId,
    fallback: string,
    picks: number,
  ): Promise<{
    readonly threadId: ThreadId;
    readonly sessionFile: SessionFilePath | null;
    readonly switched: boolean;
  }> {
    let state: { readonly sessionId: string; readonly sessionFile?: string };
    try {
      // A successful branch/fork has already changed omp's process identity. Do not pass the
      // caller's cancellation signal here: cancellation cannot undo that server-side change, and
      // leaving the new identity unreloaded would lose the active branch from the UI.
      state = await this.send({
        threadId: sourceThreadId,
        method: "get_state",
        params: {},
      });
      const threadId = sessionIdFromState(state);
      if (threadId === sourceThreadId) {
        throw conflict(
          "omp did not report a new session identity after the conversation transition",
        );
      }
      const sessionFile = sessionFileFromState(state);
      // A pick made since this transition began is the chat the person wants on screen. Then this
      // branch or fork finishes in the background, and it is in the session list. Otherwise R0.4's
      // switchTo calls its selected-thread seam and then SessionHistoryLoader, which hydrates the
      // active branch through OmpRuntimeStore.setTree/pairEndedMessages before this method publishes
      // a successful result, so the source snapshot is never used as the target.
      const switched = this.pickCount() === picks;
      if (switched) await this.branchingController.switchTo(threadId);
      return { threadId, sessionFile, switched };
    } catch (error) {
      throw asFailure(error, fallback);
    }
  }
}

export function createOmpConversationTransitionPort(
  options: ConversationTransitionOptions,
): OmpConversationTransitionPort {
  return new OmpConversationTransitionPort(options);
}

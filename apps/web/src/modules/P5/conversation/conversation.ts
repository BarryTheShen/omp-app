import type { ConversationHead, RestoreOperation } from "@omp-app/contracts";
import { AppFailure, ConversationHead as ConversationHeadSchema } from "@omp-app/contracts";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";

export type ConversationRestoreOperation = Extract<RestoreOperation, "conversation-only" | "both">;

export interface ConversationRestoreRequest {
  readonly operation: ConversationRestoreOperation;
  readonly current: ConversationHead;
  readonly target: ConversationHead;
  readonly signal?: AbortSignal;
}

export interface ConversationRestoreResult {
  readonly operation: ConversationRestoreOperation;
  readonly previous: ConversationHead;
  readonly current: ConversationHead;
  readonly restored: boolean;
  readonly reloaded: boolean;
  readonly sourceRetained: true;
  readonly wording: "conversation rewind";
}

export interface ConversationRestorePort {
  restore(request: ConversationRestoreRequest): Promise<ConversationRestoreResult>;
}

/**
 * Chooses which conversation a workspace restore leaves selected. File-only restores deliberately
 * stay on the active conversation; both and conversation-only restore to the checkpoint's head.
 */
export function conversationForRestore(
  operation: RestoreOperation,
  current: ConversationHead,
  target: ConversationHead | null,
): ConversationHead {
  const parsedCurrent = ConversationHeadSchema.parse(current);
  if (operation === "files-only") return parsedCurrent;
  if (target === null) {
    throw new AppFailure({
      code: "invalid_args",
      message: `${operation} restore requires a checkpoint conversation head`,
      retryable: false,
    });
  }
  return ConversationHeadSchema.parse(target);
}

function conflict(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: true });
}

/**
 * P5's conversation-axis decorator. P4 owns the branch command and R0.4 owns switching and
 * history hydration; this adapter only maps a checkpoint head to that typed transition seam.
 */
class ConversationRestoreCoordinator implements ConversationRestorePort {
  private readonly transition: Pick<ConversationTransitionPort, "branch">;

  public constructor(transition: Pick<ConversationTransitionPort, "branch">) {
    this.transition = transition;
  }

  public async restore(request: ConversationRestoreRequest): Promise<ConversationRestoreResult> {
    const previous = ConversationHeadSchema.parse(request.current);
    const target = ConversationHeadSchema.parse(request.target);
    if (target.entryId === null) {
      throw new AppFailure({
        code: "invalid_args",
        message: "A conversation restore checkpoint must identify an entry",
        retryable: false,
      });
    }
    if (previous.threadId !== target.threadId) {
      throw conflict(
        "The checkpoint belongs to another conversation; select that conversation before rewinding",
      );
    }

    const transitioned = await this.transition.branch({
      threadId: previous.threadId,
      entryId: target.entryId,
      signal: request.signal,
    });
    const restored = !transitioned.cancelled;
    const current: ConversationHead = restored
      ? {
          threadId: transitioned.threadId,
          sessionFile: transitioned.sessionFile,
          entryId: transitioned.entryId,
        }
      : previous;
    return {
      operation: request.operation,
      previous,
      current,
      restored,
      reloaded: transitioned.reloaded,
      sourceRetained: true,
      wording: "conversation rewind",
    };
  }
}

export function createConversationRestoreCoordinator(
  transition: Pick<ConversationTransitionPort, "branch">,
): ConversationRestorePort {
  return new ConversationRestoreCoordinator(transition);
}

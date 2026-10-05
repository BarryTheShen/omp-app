/**
 * The approval/human-input bridge into assistant-ui's two separate answer seams:
 * `onRespondToToolApproval` for an approval decision, `onAddToolResult`/`onResumeToolCall` for an
 * arbitrary human-input answer, never both for one click (`research/modules/U4.md` §4.2
 * VERIFIED/INFERENCE). `answerToolCall` is implemented in U4.4 against R0's actions; here it is
 * only the typed capability-adapter contract (`modules/U4/README.md`, "Interface").
 */
import type { ToolCallId } from "@omp-app/contracts";
import type { ApprovalDecision } from "./approval";

export type ToolCallAnswer =
  | {
      readonly kind: "approval";
      readonly toolCallId: ToolCallId;
      readonly decision: ApprovalDecision;
    }
  | { readonly kind: "human-input"; readonly toolCallId: ToolCallId; readonly payload: unknown };

/**
 * Routes one answer to its correct assistant-ui seam and preserves `toolCallId`; the
 * implementation rejects a duplicate answer to an already-settled call with
 * `AppFailure(conflict)` and surfaces an upstream `omp_error`/`timeout` without discarding the
 * visible pending card (`research/modules/U4.md` §4.2 INFERENCE).
 */
export type AnswerToolCall = (
  answer: ToolCallAnswer,
  options?: { readonly signal?: AbortSignal },
) => Promise<void>;

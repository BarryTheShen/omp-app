/**
 * Tool-approval and generic extension-confirmation pauses (`modules/U4/README.md`, "Approval
 * safety"; `research/modules/U4.md` §4). The released RPC wire has no structured
 * `tool_approval_requested` event (§4.1 VERIFIED): omp's own wrapper pauses with the correlated
 * `select("Approve", "Deny")` extension-UI request, and a generic extension confirmation instead
 * uses `confirm`. `ApprovalRequest` wraps whichever of those two dialog forms is in play; the
 * decision always fails closed.
 */
import { ToolCallId, UiRequestId } from "@omp-app/contracts";
import { z } from "zod";
import type { DialogHostOpenOptions } from "./dialog-host";
import type { DialogResult } from "./responses";

const ApprovalDetailsSchema = z.record(z.string(), z.unknown());

const SelectApprovalRequestSchema = z.strictObject({
  kind: z.literal("select"),
  id: UiRequestId,
  toolCallId: ToolCallId.optional(),
  toolName: z.string().min(1).optional(),
  title: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  /** The exact option label that means "approved"; the verified wrapper always offers
   *  `select("Approve", "Deny")`, so this is `options[0]` today. */
  approveOption: z.string().min(1),
  timeoutMs: z.int().positive().optional(),
  details: ApprovalDetailsSchema.optional(),
});

const ConfirmApprovalRequestSchema = z.strictObject({
  kind: z.literal("confirm"),
  id: UiRequestId,
  toolCallId: ToolCallId.optional(),
  toolName: z.string().min(1).optional(),
  title: z.string().min(1),
  message: z.string().min(1),
  timeoutMs: z.int().positive().optional(),
  details: ApprovalDetailsSchema.optional(),
});

export const ApprovalRequestSchema = z
  .discriminatedUnion("kind", [SelectApprovalRequestSchema, ConfirmApprovalRequestSchema])
  .refine(
    (request) => request.kind !== "select" || request.options.includes(request.approveOption),
    "approveOption must be one of options",
  );
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("approved"), reason: z.string().min(1).optional() }),
  z.strictObject({ outcome: z.literal("denied"), reason: z.string().min(1).optional() }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Presents one approval pause and always resolves to a fail-closed decision; it rejects only for
 * a programming error or `AppFailure(unavailable)` when no interactive capability exists
 * (`modules/U4/README.md`, "Approval safety").
 */
export interface ApprovalPort {
  resolve(request: ApprovalRequest, options: DialogHostOpenOptions): Promise<ApprovalDecision>;
}

/**
 * Derives the fail-closed decision from one `DialogHost` result: approved only on an explicit
 * matching answer; cancellation, timeout or an unexpected shape all deny, never approve
 * (`modules/U4/README.md`, "Approval safety"; `research/modules/U4.md` §4.1 VERIFIED).
 */
export function resolveApprovalDecision(
  request: ApprovalRequest,
  result: DialogResult,
): ApprovalDecision {
  if (result.outcome === "cancelled") {
    return {
      outcome: "denied",
      reason: result.timedOut
        ? "Timed out waiting for a decision."
        : "Cancelled before a decision was made.",
    };
  }
  const { response } = result;
  if (request.kind === "confirm" && response.kind === "confirm") {
    return response.confirmed ? { outcome: "approved" } : { outcome: "denied" };
  }
  if (request.kind === "select" && response.kind === "select") {
    return response.value === request.approveOption
      ? { outcome: "approved" }
      : { outcome: "denied", reason: `The response selected "${response.value}".` };
  }
  return { outcome: "denied", reason: "The dialog answered with an unexpected shape." };
}

import type { MessageState } from "@assistant-ui/react";
import type { Omp } from "@omp-app/contracts";
import { BranchSummaryDivider } from "./branch-summary-divider";

/**
 * The branch summary a transcript row carries. R0 keeps omp's `branchSummary` message in the row's
 * metadata (`ompRole` and `ompBranchSummary`); any other row, or one without its text, gives undefined.
 */
export function branchSummaryOfRow(message: MessageState): Omp.BranchSummaryMessage | undefined {
  const { ompRole, ompBranchSummary } = message.metadata.custom;
  if (ompRole !== "branchSummary" || typeof ompBranchSummary !== "object") return undefined;
  if (ompBranchSummary === null) return undefined;
  const { summary, fromId, timestamp } = ompBranchSummary as Record<string, unknown>;
  if (typeof summary !== "string" || typeof fromId !== "string") return undefined;
  if (typeof timestamp !== "number") return undefined;
  return { role: "branchSummary", summary, fromId, timestamp };
}

/**
 * A branch summary row in the transcript: the divider, under the row's id so the scroll and anchor code
 * find it like any other row.
 */
export function BranchSummaryRow({
  message,
  summary,
}: {
  readonly message: MessageState;
  readonly summary: Omp.BranchSummaryMessage;
}) {
  return (
    <div
      className="w-full min-w-0"
      data-message-id={message.id}
      data-role="system"
      data-slot="p3-branch-summary-row"
    >
      <BranchSummaryDivider message={summary} />
    </div>
  );
}

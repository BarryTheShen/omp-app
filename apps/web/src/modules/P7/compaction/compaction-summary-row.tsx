import type { MessageState } from "@assistant-ui/react";
import type { Omp } from "@omp-app/contracts";
import { CompactionSummaryDivider } from "./compaction-summary-divider";

/**
 * The compaction summary a transcript row carries. R0 keeps omp's `compactionSummary` message in the
 * row's metadata (`ompRole` and `ompCompactionSummary`); any other row, or one without its text
 * and counts, gives undefined.
 */
export function compactionSummaryOfRow(
  message: MessageState,
): Omp.CompactionSummaryMessage | undefined {
  const { ompRole, ompCompactionSummary } = message.metadata.custom;
  if (ompRole !== "compactionSummary" || typeof ompCompactionSummary !== "object") return undefined;
  if (ompCompactionSummary === null) return undefined;
  const { summary, tokensBefore, timestamp, shortSummary, tokensAfter, method } =
    ompCompactionSummary as Record<string, unknown>;
  if (typeof summary !== "string" || typeof tokensBefore !== "number") return undefined;
  if (typeof timestamp !== "number") return undefined;
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp,
    ...(typeof shortSummary === "string" ? { shortSummary } : {}),
    ...(typeof tokensAfter === "number" ? { tokensAfter } : {}),
    ...(typeof method === "string" ? { method } : {}),
  };
}

function compactionWarningOfRow(message: MessageState): string | undefined {
  const { ompRole, ompCompactionSummary } = message.metadata.custom;
  if (ompRole !== "compactionSummary" || typeof ompCompactionSummary !== "object") return undefined;
  if (ompCompactionSummary === null) return undefined;
  const warning = (ompCompactionSummary as Record<string, unknown>).warning;
  return typeof warning === "string" ? warning : undefined;
}

/**
 * A compaction row in the transcript: the divider, under the row's id so the scroll and anchor code
 * find it like any other row.
 */
export function CompactionSummaryRow({
  message,
  summary,
}: {
  readonly message: MessageState;
  readonly summary: Omp.CompactionSummaryMessage;
}) {
  const warning = compactionWarningOfRow(message);
  return (
    <div
      className="w-full min-w-0"
      data-message-id={message.id}
      data-role="system"
      data-slot="p7-compaction-summary-row"
    >
      <CompactionSummaryDivider message={summary} warning={warning} />
    </div>
  );
}

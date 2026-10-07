import type { OmpWire } from "@omp-app/contracts";
import { MarkdownContent } from "@/modules/U1/markdown";
import { SessionEntryRow } from "@/modules/U1/rows";
import { compactionMethodLabel, formatTokenCount } from "./models";

export interface CompactionSummaryDividerProps {
  readonly message: OmpWire.CompactionSummaryMessage;
  readonly warning?: string;
  readonly error?: string;
}

function tokenDetail(message: OmpWire.CompactionSummaryMessage): string {
  const before = `Before compaction: ${formatTokenCount(message.tokensBefore)} tokens.`;
  return message.tokensAfter === undefined
    ? `${before} The summary below shows what the conversation kept.`
    : `${before} After compaction: ${formatTokenCount(message.tokensAfter)} tokens.`;
}

export function CompactionSummaryDivider({
  message,
  warning,
  error,
}: CompactionSummaryDividerProps) {
  const shortSummary = message.shortSummary?.trim();
  const summary = message.summary.trim();

  return (
    <div className="w-full" data-p7-compaction-divider>
      <SessionEntryRow
        detail={tokenDetail(message)}
        kind="compaction-summary"
        title={compactionMethodLabel(message.method)}
      />
      <p
        aria-label="What the conversation kept"
        className="mx-auto w-full max-w-(--layout-thread-width) break-words px-6 text-sm"
        role="note"
      >
        {shortSummary || "The summary below explains what the conversation kept."}
      </p>
      {warning ? (
        <p
          aria-live="polite"
          className="mx-auto w-full max-w-(--layout-thread-width) px-6 text-sm text-warning"
          role="status"
        >
          Compaction note: {warning}
        </p>
      ) : null}
      {error ? (
        <p
          aria-live="polite"
          className="mx-auto w-full max-w-(--layout-thread-width) px-6 text-sm text-destructive"
          role="alert"
        >
          Compaction could not finish: {error}
        </p>
      ) : null}
      <details className="mx-auto w-full max-w-(--layout-thread-width) px-6 py-1.5">
        <summary className="cursor-pointer rounded-sm text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Read what was kept
        </summary>
        <div className="border-border bg-muted/20 mt-2 max-h-80 overflow-auto rounded-lg border p-3 text-sm">
          {summary.length > 0 ? (
            <MarkdownContent text={summary} variant="compact" />
          ) : (
            <p className="text-muted-foreground">No compaction summary was provided.</p>
          )}
        </div>
      </details>
    </div>
  );
}

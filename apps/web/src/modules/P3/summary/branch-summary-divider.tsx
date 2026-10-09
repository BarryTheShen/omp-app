import type { OmpWire } from "@omp-app/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { MarkdownContent, summaryWithFileLists } from "@/modules/U1/markdown";

export interface BranchSummaryDividerProps {
  readonly message: OmpWire.BranchSummaryMessage;
}

/**
 * Renders omp's branch-summary marker using U1's compact Markdown grammar. The row carries omp's label
 * ("Branch summary", as U1 names it), its chevron turns while the summary is open, and the summary is
 * read in the foreground colour rather than the muted row colour. `fromId` stays on the element so
 * reconciliation can keep the marker stable across reloads.
 */
export function BranchSummaryDivider({ message }: BranchSummaryDividerProps) {
  const summary = summaryWithFileLists(message.summary).trim();
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full" data-from-id={message.fromId} data-p3-branch-summary-divider>
      <div className="mx-auto w-full max-w-(--layout-thread-width) px-6 py-1.5">
        <details
          className="border-border border-b py-1.5 text-xs text-muted-foreground"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span>Branch summary</span>
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-3 transition-transform", open && "rotate-180")}
            />
          </summary>
          <div className="border-border bg-muted/20 text-foreground mt-2 max-h-80 overflow-auto rounded-lg border p-3 text-sm">
            {summary.length > 0 ? (
              <MarkdownContent text={summary} variant="compact" />
            ) : (
              <p className="text-muted-foreground">No branch summary was provided.</p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

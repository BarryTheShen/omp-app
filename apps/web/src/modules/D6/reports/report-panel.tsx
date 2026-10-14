import type { AppError } from "@omp-app/contracts";
import { type ReactNode, useState } from "react";
import { EmptyState } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type {
  PanelFocusToken,
  PanelLifecycle,
  PanelOpenReason,
  PanelState,
} from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import type { RedactedReportLine } from "../contract";
import type { ReportSnapshot, ReportStatus } from "./runner";

const LIFECYCLE_OF: Record<ReportStatus, PanelLifecycle> = {
  idle: "empty",
  loading: "loading",
  ready: "populated",
  empty: "empty",
  error: "error",
  unavailable: "unavailable",
};

/**
 * The reason the panel shows for an error or unavailable report: omp's words when the report has
 * them, otherwise a plain sentence. U5's own fallback reads "This capability is unavailable.", which
 * a person should never see, so the reason is always set here.
 */
function errorOf(snapshot: ReportSnapshot): AppError | null {
  if (snapshot.status === "error") {
    return (
      snapshot.error ?? {
        code: "internal",
        message: snapshot.message ?? "omp could not finish this report.",
        retryable: true,
      }
    );
  }
  if (snapshot.status === "unavailable") {
    return (
      snapshot.error ?? {
        code: "unavailable",
        message: snapshot.message ?? "This report is not available in this omp session.",
        retryable: false,
      }
    );
  }
  return null;
}

/** The U5 panel state for a report: a read-only panel whose lifecycle follows the report. */
export function reportPanelState(
  snapshot: ReportSnapshot,
  open: boolean,
  fallbackTitle: string,
): PanelState {
  return {
    open,
    lifecycle: LIFECYCLE_OF[snapshot.status],
    position: "right",
    title: snapshot.title === "" ? fallbackTitle : snapshot.title,
    error: errorOf(snapshot),
    readOnly: true,
    pendingUpdates: 0,
  };
}

const COPY_NOTE = {
  idle: "",
  copied: "Report copied.",
  failed: "Could not copy the report. Select the text and copy it by hand.",
} as const;

/** The result of the last copy, kept with the lines it copied so a different report shows no note. */
interface CopyResult {
  readonly lines: readonly RedactedReportLine[];
  readonly note: "copied" | "failed";
}

function reportText(lines: readonly RedactedReportLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/** omp's words for one report, with the notes that say what was cut or hidden. */
export function ReportBody({
  snapshot,
  onRetry,
}: {
  readonly snapshot: ReportSnapshot;
  readonly onRetry?: () => void;
}) {
  const [copied, setCopied] = useState<CopyResult | undefined>(undefined);
  if (snapshot.status === "idle") {
    return <EmptyState title="No report open" hint="Choose a report to see omp's words here." />;
  }
  if (snapshot.status === "loading") {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Running the report…
      </p>
    );
  }
  const hasLines = snapshot.lines.length > 0;
  const lines = snapshot.lines;
  const copyNote =
    copied !== undefined && copied.lines === lines ? COPY_NOTE[copied.note] : COPY_NOTE.idle;
  const copy = () => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setCopied({ lines, note: "failed" });
      return;
    }
    navigator.clipboard.writeText(reportText(lines)).then(
      () => setCopied({ lines, note: "copied" }),
      () => setCopied({ lines, note: "failed" }),
    );
  };
  const hasRedaction = snapshot.lines.some((line) => line.redacted);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {snapshot.status === "error" && onRetry !== undefined && (
        <div>
          <Button onClick={onRetry} type="button" variant="outline">
            Try again
          </Button>
        </div>
      )}
      {snapshot.status === "empty" && (
        <EmptyState
          title={snapshot.note ?? "omp sent no text for this report."}
          variant="compact"
        />
      )}
      {snapshot.aborted && snapshot.status === "ready" && (
        <p className="text-muted-foreground text-sm" role="status">
          {snapshot.message}
        </p>
      )}
      {!snapshot.promptSettled && (
        <p className="text-muted-foreground text-sm" role="status">
          omp is still finishing this command.
        </p>
      )}
      {hasLines && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={copy} type="button" variant="outline">
              Copy report
            </Button>
            <p aria-live="polite" className="text-muted-foreground text-xs" role="status">
              {copyNote}
            </p>
          </div>
          {snapshot.truncated && (
            <p className="text-muted-foreground text-xs">Some of this report was cut short.</p>
          )}
          {hasRedaction && (
            <p className="text-muted-foreground text-xs">
              Some details were hidden: paths, keys and email addresses.
            </p>
          )}
          <section aria-label={`${snapshot.title} text`} className="min-w-0">
            <pre className="font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {reportText(snapshot.lines)}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}

export interface DiagnosticReportPanelProps {
  readonly open: boolean;
  readonly snapshot: ReportSnapshot;
  /** The panel's title while no report is open. */
  readonly fallbackTitle: string;
  /** Controls above the report, such as the choice of view or the security form. */
  readonly toolbar?: ReactNode;
  readonly onRetry?: () => void;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
}

/** A read-only report panel: omp's words, copy, close, and every report state. */
export function DiagnosticReportPanel({
  open,
  snapshot,
  fallbackTitle,
  toolbar,
  onRetry,
  onOpenChange,
  invokingFocus,
  restoreFocus,
}: DiagnosticReportPanelProps) {
  return (
    <PanelShell
      body={
        <div className="flex min-w-0 flex-col gap-3">
          {toolbar}
          <ReportBody onRetry={onRetry} snapshot={snapshot} />
        </div>
      }
      invokingFocus={invokingFocus}
      onOpenChange={onOpenChange}
      restoreFocus={restoreFocus}
      state={reportPanelState(snapshot, open, fallbackTitle)}
    />
  );
}

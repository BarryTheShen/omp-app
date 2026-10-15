import type { ThreadId } from "@omp-app/contracts";
import { useState } from "react";
import { Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { PanelFocusToken, PanelOpenReason } from "@/modules/U5/panel/contract";
import type { DiagnosticCommandPort, DiagnosticCommandRequest } from "../contract";
import { changelogRequest, jobsRequest, TRACE_REQUEST } from "./commands";
import { DiagnosticReportPanel } from "./report-panel";
import { useDiagnosticReport } from "./use-diagnostic-report";

export interface ReportChoice {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly request: DiagnosticCommandRequest;
  /** A plain sentence on what the report does; shown under the choices while it is chosen. */
  readonly note?: string;
}

/** The reports the panel offers, each one omp's own slash command. */
export const REPORT_CHOICES: readonly ReportChoice[] = [
  {
    id: "changelog",
    label: "Last three releases",
    title: "Last three releases",
    request: changelogRequest("recent"),
  },
  {
    id: "changelog-full",
    label: "Full changelog",
    title: "Full changelog",
    request: changelogRequest("full"),
  },
  {
    id: "jobs",
    label: "Background jobs",
    title: "Background jobs",
    request: jobsRequest("summary"),
  },
  {
    id: "jobs-full",
    label: "Full job command lines",
    title: "Background jobs, full command lines",
    request: jobsRequest("full"),
  },
  {
    id: "trace",
    label: "Session trace",
    title: "Session trace",
    request: TRACE_REQUEST,
    note: "Starts omp's stats dashboard on this computer and gives a link to this session's trace. The path of this session's file is hidden in the link.",
  },
];

/**
 * The reports panel: each choice runs one omp command through the command gateway and shows its
 * words. Closing the panel stops waiting for a report; omp still finishes the command it was given.
 */
export function ReportsPanel({
  port,
  threadId,
  open,
  onOpenChange,
  invokingFocus,
  restoreFocus,
}: {
  readonly port: DiagnosticCommandPort;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
}) {
  const { snapshot, runner } = useDiagnosticReport(port, threadId);
  const [chosen, setChosen] = useState<ReportChoice | undefined>(undefined);
  const choose = (choice: ReportChoice) => {
    setChosen(choice);
    void runner.run(choice.request, choice.title);
  };
  const toolbar = (
    <div className="flex min-w-0 flex-col gap-2">
      <Toolbar ariaLabel="Report choices">
        {REPORT_CHOICES.map((choice) => {
          const pressed = chosen?.id === choice.id;
          return (
            <Button
              aria-pressed={pressed}
              key={choice.id}
              onClick={() => choose(choice)}
              type="button"
              variant={pressed ? "default" : "outline"}
            >
              {choice.label}
            </Button>
          );
        })}
      </Toolbar>
      {chosen?.note !== undefined && <p className="text-muted-foreground text-xs">{chosen.note}</p>}
    </div>
  );
  return (
    <DiagnosticReportPanel
      fallbackTitle="Reports"
      invokingFocus={invokingFocus}
      onOpenChange={(next, reason) => {
        if (!next) {
          runner.close();
          setChosen(undefined);
        }
        onOpenChange(next, reason);
      }}
      onRetry={chosen === undefined ? undefined : () => choose(chosen)}
      open={open}
      restoreFocus={restoreFocus}
      snapshot={snapshot}
      toolbar={toolbar}
    />
  );
}

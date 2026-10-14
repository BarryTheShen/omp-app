import type { ThreadId } from "@omp-app/contracts";
import { useState } from "react";
import type { PanelFocusToken, PanelOpenReason } from "@/modules/U5/panel/contract";
import { useStableOverlayHost } from "@/overlay/overlay-host";
import type { DiagnosticCommandPort, DiagnosticCommandRequest } from "../contract";
import { useDiagnosticReport } from "../reports/use-diagnostic-report";
import type { SecurityActionInfo } from "./actions";
import { runSecurityAction } from "./run";
import { SecurityPanel } from "./security-panel";

/** The last action the person ran, so "Try again" can run it again. */
interface LastRun {
  readonly action: SecurityActionInfo;
  readonly request: DiagnosticCommandRequest;
}

/**
 * The security panel wired to omp: its runs go through the command gateway, an action that changes
 * something or spends model budget asks first, and closing the panel stops waiting for a run still
 * in progress (omp still finishes it).
 */
export function SecurityReportPanel({
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
  const overlay = useStableOverlayHost();
  const [last, setLast] = useState<LastRun | undefined>(undefined);
  const run = (action: SecurityActionInfo, request: DiagnosticCommandRequest) => {
    setLast({ action, request });
    void runSecurityAction(overlay, runner, action, request);
  };
  return (
    <SecurityPanel
      invokingFocus={invokingFocus}
      onOpenChange={(next, reason) => {
        if (!next) runner.close();
        onOpenChange(next, reason);
      }}
      onRetry={last === undefined ? undefined : () => run(last.action, last.request)}
      onRun={run}
      open={open}
      restoreFocus={restoreFocus}
      snapshot={snapshot}
    />
  );
}

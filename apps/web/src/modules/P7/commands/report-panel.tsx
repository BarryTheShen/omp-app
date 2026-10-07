import type { AppError } from "@omp-app/contracts";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import type { P7CommandResult } from "../contract";
import { CommandResultContent } from "./result-view";

export interface CommandReportPanelProps {
  readonly panelState: PanelState;
  readonly result: P7CommandResult | null;
  readonly error: AppError | null;
  readonly loading: boolean;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly onRetry?: () => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
}

export function CommandReportPanel({
  panelState,
  result,
  error,
  loading,
  onOpenChange,
  onRetry,
  invokingFocus,
  restoreFocus,
}: CommandReportPanelProps) {
  return (
    <PanelShell
      body={
        <CommandResultContent error={error} loading={loading} onRetry={onRetry} result={result} />
      }
      invokingFocus={invokingFocus}
      restoreFocus={restoreFocus}
      onOpenChange={onOpenChange}
      state={panelState}
    />
  );
}

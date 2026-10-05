import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PlanModeController, PlanModeState } from "./mode";

export interface PlanModeStatusProps {
  readonly controller: PlanModeController;
}

function statusLabel(state: PlanModeState): string {
  if (state.mode === "review") return "Plan review";
  if (state.mode === "executing") return "Plan executing";
  if (state.mode === "planning") return "Plan mode";
  return "Plan mode off";
}

export function PlanModeStatus({ controller }: PlanModeStatusProps) {
  const [state, setState] = useState(controller.getSnapshot());
  useEffect(() => controller.subscribe(setState), [controller]);
  return (
    <section
      aria-label="Plan mode status"
      className="flex flex-wrap items-center gap-2"
      data-testid="plan-mode-status"
    >
      <Button
        aria-describedby="plan-mode-capability-reason"
        aria-pressed={state.mode === "planning"}
        data-testid="plan-mode-toggle"
        disabled={state.pending || !state.canToggle}
        size="sm"
        type="button"
        variant={state.mode === "planning" ? "secondary" : "outline"}
        onClick={() => void controller.toggle()}
      >
        {state.pending ? "Switching…" : statusLabel(state)}
      </Button>
      {state.isDirty && <span className="text-warning text-xs">Unsaved plan changes</span>}
      {!state.canToggle && state.capabilityReason && (
        <span
          className="text-muted-foreground text-xs"
          id="plan-mode-capability-reason"
          role="status"
        >
          {state.capabilityReason}
        </span>
      )}
      {state.error && (
        <span className="text-danger text-xs" role="alert">
          {state.error.appError.message}
        </span>
      )}
    </section>
  );
}

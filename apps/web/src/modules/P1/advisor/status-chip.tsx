import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { AdvisorState } from "../contract";
import type { AdvisorCommand, AdvisorCommandController } from "./advisor";
import { type AdvisorStatusTone, advisorCommandLabel, advisorStatusView } from "./model";

export interface AdvisorStatusChipProps {
  readonly state: AdvisorState;
  readonly commands: AdvisorCommandController;
  readonly onConfigure?: () => void;
  readonly disabled?: boolean;
}

function statusClass(tone: AdvisorStatusTone): string {
  switch (tone) {
    case "success":
      return "border-success/30 bg-success-surface text-success-surface-foreground";
    case "warning":
      return "border-warning/40 bg-warning-surface text-warning-surface-foreground";
    case "danger":
      return "border-danger/30 bg-danger-surface text-danger-surface-foreground";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function commandLabel(command: AdvisorCommand): string {
  switch (command) {
    case "on":
      return "Turn on";
    case "off":
      return "Turn off";
    case "status":
      return "Refresh status";
    case "dump":
      return "Copy notes";
    case "toggle":
      return "Toggle advisor";
  }
}

/** A compact, keyboard-accessible advisor status surface. Commands remain typed and opaque to the browser. */
function AdvisorStatusChip({
  state,
  commands,
  onConfigure,
  disabled = false,
}: AdvisorStatusChipProps) {
  const view = advisorStatusView(state);
  const commandState = useSyncExternalStore(
    commands.subscribe,
    commands.getSnapshot,
    commands.getSnapshot,
  );
  const busy = commandState.status === "running";

  const run = (command: AdvisorCommand) => {
    void commands.run(command).catch(() => undefined);
  };

  return (
    <section
      aria-label="Advisor status"
      className={`rounded-lg border px-3 py-2 ${statusClass(view.tone)}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">Advisor: {view.modeLabel}</p>
          <p className="text-xs">{view.label}</p>
        </div>
        {commandState.status !== "idle" ? (
          <span
            aria-live="polite"
            className="text-xs"
            data-advisor-command-state={commandState.status}
          >
            {advisorCommandLabel(commandState)}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs">{view.detail}</p>
      <fieldset className="mt-2 flex flex-wrap gap-1.5">
        <legend className="sr-only">Advisor actions</legend>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || busy || state.mode === "on"}
          onClick={() => run("on")}
        >
          {commandLabel("on")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || busy || state.mode === "off"}
          onClick={() => run("off")}
        >
          {commandLabel("off")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => run("status")}
        >
          {commandLabel("status")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => run("dump")}
        >
          {commandLabel("dump")}
        </Button>
        {onConfigure ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={onConfigure}
          >
            Advisor settings
          </Button>
        ) : null}
      </fieldset>
      {commandState.status === "error" ? (
        <p role="alert" className="mt-2 text-destructive text-xs">
          {commandState.error.appError.message}
        </p>
      ) : null}
    </section>
  );
}

export { AdvisorStatusChip };

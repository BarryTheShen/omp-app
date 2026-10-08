import { Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import { WorkerInspector } from "./inspector";
import type { HubModel, HubView } from "./model";
import { RosterList } from "./roster";

export interface AgentHubPanelProps {
  readonly model: HubModel;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean, reason: PanelOpenReason) => void;
  readonly onViewChange: (view: HubView) => void;
  readonly onSelect: (key: string) => void;
  readonly onCancel: (key: string) => void;
  readonly onOpenTranscript: (key: string) => void;
  readonly onRetry?: () => void | Promise<void>;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly className?: string;
}

const VIEW_OPTIONS: readonly { readonly view: HubView; readonly label: string }[] = [
  { view: "list", label: "List" },
  { view: "byParent", label: "By parent" },
];

function ViewToggle({
  view,
  onViewChange,
}: {
  readonly view: HubView;
  readonly onViewChange: (view: HubView) => void;
}) {
  return (
    <Toolbar ariaLabel="How workers are listed">
      {VIEW_OPTIONS.map((option) => (
        <Button
          aria-pressed={view === option.view}
          key={option.view}
          onClick={() => onViewChange(option.view)}
          size="sm"
          variant={view === option.view ? "secondary" : "ghost"}
        >
          {option.label}
        </Button>
      ))}
    </Toolbar>
  );
}

/**
 * The Agent Hub: the active and recent workers in the body, the selected worker's inspector in the
 * footer. It takes a view model and callbacks only; where it sits is the layout's decision.
 */
export function AgentHubPanel({
  model,
  open = true,
  onOpenChange,
  onViewChange,
  onSelect,
  onCancel,
  onOpenTranscript,
  onRetry,
  invokingFocus,
  restoreFocus,
  className,
}: AgentHubPanelProps) {
  const state: PanelState = {
    open,
    lifecycle: model.lifecycle,
    position: "right",
    title: model.title,
    description: model.description ?? undefined,
    error: model.error,
    readOnly: false,
    pendingUpdates: 0,
  };
  const populated = model.lifecycle === "populated" || model.lifecycle === "updating";
  return (
    <PanelShell
      body={
        populated ? (
          // The roster scrolls inside its own container, so the shell's body never overflows: no
          // "New updates" badge on open, and a roster that loads late keeps its top in view.
          <div className="h-full min-h-0 overflow-y-auto">
            <RosterList onSelect={onSelect} sections={model.sections} />
          </div>
        ) : null
      }
      className={className}
      footer={
        model.inspector ? (
          <div className="max-h-80 overflow-y-auto">
            <WorkerInspector
              inspector={model.inspector}
              onCancel={onCancel}
              onOpenTranscript={onOpenTranscript}
            />
          </div>
        ) : undefined
      }
      invokingFocus={invokingFocus}
      onOpenChange={onOpenChange}
      onRetry={onRetry}
      restoreFocus={restoreFocus}
      state={state}
      toolbar={populated ? <ViewToggle onViewChange={onViewChange} view={model.view} /> : undefined}
    />
  );
}

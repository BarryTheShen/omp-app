import type { EntryId } from "@omp-app/contracts";
import type { ReactNode } from "react";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import { Icons } from "@/tokens";
import { P4TreePickerTrigger } from "./tree-picker";
import { P4TreeSelectorView } from "./tree-selector";
import type { P4TreeSelectorActions } from "./tree-selector-controller";
import type { P4TreeSelectorViewModel } from "./tree-selector-model";

export interface P4TreePanelContentProps {
  readonly model: P4TreeSelectorViewModel;
  readonly activeEntryId: EntryId | null;
  readonly actions: P4TreeSelectorActions;
  readonly showStateMessages?: boolean;
}

export interface P4TreePanelViewProps extends P4TreePanelContentProps {
  readonly state: PanelState;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly onOpenPicker: (trigger: HTMLButtonElement) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly onRetry?: () => void | Promise<void>;
  readonly footer?: ReactNode;
}

export interface P4TreePanelStateOptions {
  readonly open: boolean;
  readonly position: PanelState["position"];
}

/** Maps the selector's loading and error states to the panel lifecycle used by the app shell. */
export function createP4TreePanelState(
  model: P4TreeSelectorViewModel,
  options: P4TreePanelStateOptions,
): PanelState {
  const status = model.status;
  const lifecycle: PanelState["lifecycle"] =
    status?.kind === "loading" || status?.kind === "updating"
      ? status.kind
      : (status?.kind ?? "populated");
  const error: PanelState["error"] =
    status?.kind === "error"
      ? { code: "omp_error", message: status.message, retryable: status.retryable }
      : status?.kind === "unavailable"
        ? { code: "unavailable", message: status.message, retryable: false }
        : null;
  return {
    open: options.open,
    lifecycle,
    position: options.position,
    title: "Conversation history",
    description: "Browse earlier messages.",
    error,
    readOnly: true,
    pendingUpdates: 0,
  };
}

/** The tree content slot; the app layout owns where the enclosing PanelShell appears. */
export function P4TreePanelContent({
  model,
  activeEntryId,
  actions,
  showStateMessages = false,
}: P4TreePanelContentProps) {
  return (
    <P4TreeSelectorView
      actions={actions}
      activeEntryId={activeEntryId}
      model={model}
      showStateMessages={showStateMessages}
    />
  );
}

/** U5 PanelShell surface; the app layout owns this surface's id, area, and order. */
export function P4TreePanelView({
  model,
  activeEntryId,
  actions,
  showStateMessages,
  state,
  onOpenChange,
  onOpenPicker,
  invokingFocus,
  restoreFocus,
  onRetry,
  footer,
}: P4TreePanelViewProps) {
  return (
    <PanelShell
      body={
        <div className="h-full min-h-0 overflow-y-auto">
          <P4TreePanelContent
            actions={actions}
            activeEntryId={activeEntryId}
            model={model}
            showStateMessages={showStateMessages}
          />
        </div>
      }
      invokingFocus={invokingFocus}
      onOpenChange={onOpenChange}
      onRetry={onRetry}
      footer={footer}
      restoreFocus={restoreFocus}
      state={state}
      toolbar={
        <P4TreePickerTrigger
          disabledReason={model.pickerDisabledReason}
          iconOnly
          onOpen={onOpenPicker}
        >
          <Icons.search aria-hidden="true" />
        </P4TreePickerTrigger>
      }
    />
  );
}

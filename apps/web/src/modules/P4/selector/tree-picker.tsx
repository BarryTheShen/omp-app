import type { ReactNode } from "react";
import { Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { OverlayContent, OverlayHostApi, OverlayOpenResult } from "@/overlay";
import { P4TreeSelectorView } from "./tree-selector";
import type { P4TreeSelectorActions } from "./tree-selector-controller";
import type { P4TreeSelectorViewModel } from "./tree-selector-model";

const TREE_PICKER_FRAME_CLASS =
  "h-[min(calc(100dvh-1rem),52rem)] w-[min(calc(100vw-1rem),48rem)] max-h-none max-w-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]";

/** The trigger's name, the same words in the panel header and in any other place that opens the picker. */
const P4_TREE_PICKER_TRIGGER_LABEL = "Choose a message";

export interface P4TreePickerTriggerProps {
  readonly onOpen: (trigger: HTMLButtonElement) => void;
  readonly disabledReason?: string;
  /** An icon-only trigger for a narrow header; it keeps the name and shows it as a tooltip. */
  readonly iconOnly?: boolean;
  readonly children?: ReactNode;
}

export interface P4TreePickerOpenOptions {
  readonly overlay: OverlayHostApi;
  readonly trigger: HTMLButtonElement;
  readonly label: string;
  readonly content: OverlayContent;
}

export interface P4TreePickerDialogViewProps {
  readonly model: P4TreeSelectorViewModel;
  readonly activeEntryId: P4TreeSelectorViewModel["selectedEntryId"];
  readonly actions: P4TreeSelectorActions;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/** Opens the app-owned picker in the large modal frame used for scrollable selections. */
export function openP4TreePickerDialog({
  overlay,
  trigger,
  label,
  content,
}: P4TreePickerOpenOptions): OverlayOpenResult {
  return overlay.open({
    kind: "modal",
    label,
    width: "viewport",
    className: TREE_PICKER_FRAME_CLASS,
    restoreFocus: trigger,
    content,
  });
}

/** A trigger only; the app layout owns opening and placing the OverlayHost modal. */
export function P4TreePickerTrigger({
  onOpen,
  disabledReason,
  iconOnly = false,
  children,
}: P4TreePickerTriggerProps) {
  return (
    <Button
      aria-haspopup="dialog"
      aria-label={iconOnly ? P4_TREE_PICKER_TRIGGER_LABEL : undefined}
      disabled={disabledReason !== undefined}
      size={iconOnly ? "icon-sm" : "default"}
      title={disabledReason ?? (iconOnly ? P4_TREE_PICKER_TRIGGER_LABEL : undefined)}
      type="button"
      variant={iconOnly ? "ghost" : "outline"}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {children ?? P4_TREE_PICKER_TRIGGER_LABEL}
    </Button>
  );
}

/** Dialog content only; U0 OverlayHost and focus restoration belong to the app layout. */
export function P4TreePickerDialogView({
  model,
  activeEntryId,
  actions,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: P4TreePickerDialogViewProps) {
  return (
    <div
      className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3"
      data-testid="tree-picker-dialog"
    >
      <Section description={description} heading={title} variant="dialog">
        {null}
      </Section>
      <P4TreeSelectorView
        actions={actions}
        activeEntryId={activeEntryId}
        model={model}
        showStateMessages
      />
      <Toolbar ariaLabel="Message selection actions" alignment="end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!model.canSelect} type="button" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </Toolbar>
    </div>
  );
}

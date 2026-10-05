import { ActionBarPrimitive, BranchPickerPrimitive, useAuiState } from "@assistant-ui/react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "../../../components/ui/button";

export type BranchPickerProps = Omit<
  ComponentProps<typeof BranchPickerPrimitive.Root>,
  "children"
> & {
  readonly disabled?: boolean;
};

/** assistant-ui's supported branch stepper: ‹ number / count ›. */
export function BranchPicker({ className, disabled = false, ...props }: BranchPickerProps) {
  return (
    <BranchPickerPrimitive.Root
      {...props}
      className={`text-muted-foreground inline-flex items-center gap-(--space-xs) text-xs ${className ?? ""}`}
      hideWhenSingleBranch
    >
      <BranchPickerPrimitive.Previous
        disabled={disabled}
        render={
          <Button aria-label="Previous branch" size="icon-sm" type="button" variant="ghost" />
        }
      >
        <ChevronLeftIcon aria-hidden="true" />
      </BranchPickerPrimitive.Previous>
      <span aria-label="Branch position" className="font-medium" role="status">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next
        disabled={disabled}
        render={<Button aria-label="Next branch" size="icon-sm" type="button" variant="ghost" />}
      >
        <ChevronRightIcon aria-hidden="true" />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

export type MessageActionBarProps = Omit<
  ComponentProps<typeof ActionBarPrimitive.Root>,
  "children"
> & {
  readonly disabled?: boolean;
};

/** U1 row-slot composition: copy for all rows, edit for user rows, reload for assistant rows. */
export function MessageActionBar({ className, disabled = false, ...props }: MessageActionBarProps) {
  const role = useAuiState((state) => state.message.role);
  const showEdit = role === "user";
  const showReload = role === "assistant";
  return (
    <ActionBarPrimitive.Root
      {...props}
      className={`text-muted-foreground inline-flex items-center gap-(--space-xs) ${className ?? ""}`}
      hideWhenRunning={props.hideWhenRunning}
    >
      <ActionBarPrimitive.Copy
        disabled={disabled}
        render={<Button aria-label="Copy message" size="icon-sm" type="button" variant="ghost" />}
      >
        <CopyIcon aria-hidden="true" />
      </ActionBarPrimitive.Copy>
      {showEdit && (
        <ActionBarPrimitive.Edit
          disabled={disabled}
          render={<Button aria-label="Edit message" size="icon-sm" type="button" variant="ghost" />}
        >
          <PencilIcon aria-hidden="true" />
        </ActionBarPrimitive.Edit>
      )}
      {showReload && (
        <ActionBarPrimitive.Reload
          disabled={disabled}
          render={
            <Button aria-label="Regenerate message" size="icon-sm" type="button" variant="ghost" />
          }
        >
          <RefreshCwIcon aria-hidden="true" />
        </ActionBarPrimitive.Reload>
      )}
    </ActionBarPrimitive.Root>
  );
}

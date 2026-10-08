import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { PencilIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Muted at rest, full strength on hover and focus. The controls are always drawn, so touch and keyboard reach them. */
const ACTION_CLASS = "text-muted-foreground hover:text-foreground focus-visible:text-foreground";

export interface P3MessageActionsProps {
  /**
   * Opens the editor for this user row. `trigger` is the pressed button, which focus returns to on cancel.
   * Omitted, the row gets no Edit control.
   */
  readonly onEdit?: ((trigger: HTMLButtonElement) => void) | undefined;
}

/**
 * Edit on a user row and Regenerate on an assistant row. Both wait while a turn streams. Regenerate is
 * assistant-ui's Reload, so it reaches R0's onReload with the user message the answer came from.
 */
export function P3MessageActions({ onEdit }: P3MessageActionsProps) {
  const role = useAuiState((state) => state.message.role);
  const running = useAuiState((state) => state.thread.isRunning);
  if (running) return null;
  if (role === "user") {
    if (onEdit === undefined) return null;
    return (
      <div className="flex justify-end px-2 py-1" data-slot="p3-message-actions">
        <Button
          className={ACTION_CLASS}
          onClick={(event) => onEdit(event.currentTarget)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <PencilIcon aria-hidden="true" />
          Edit
        </Button>
      </div>
    );
  }
  if (role === "assistant") {
    return (
      <ActionBarPrimitive.Root
        className="flex justify-start px-2 py-1"
        data-slot="p3-message-actions"
      >
        <ActionBarPrimitive.Reload
          render={
            <Button
              aria-label="Regenerate response"
              className={ACTION_CLASS}
              size="sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <RefreshCwIcon aria-hidden="true" />
          Regenerate
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    );
  }
  return null;
}

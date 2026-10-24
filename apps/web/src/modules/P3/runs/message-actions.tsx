import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import type { ThreadId } from "@omp-app/contracts";
import { PencilIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Muted at rest, full strength on hover and focus. The controls are always drawn, so touch and keyboard reach them. */
const ACTION_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-40 p-1 transition-colors";

export interface OtherVersion {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface P3MessageActionsProps {
  readonly onEdit?: ((trigger: HTMLButtonElement) => void) | undefined;
  readonly otherVersions?: readonly OtherVersion[];
  readonly onOpenOtherVersion?: (threadId: ThreadId) => void;
}

/**
 * Edit on a user row and Regenerate on an assistant row. A user row's actions wait for a turn to end: the thread's root
 * marks the run (`thread-running:` in index.css), and the row does not subscribe to it, so a run that starts or ends
 * draws no action bar again.
 * The assistant action host stays mounted while streaming so assistant-ui's Reload subscription can
 * reveal the control when the thread settles.
 */
export function P3MessageActions({
  onEdit,
  otherVersions = [],
  onOpenOtherVersion,
}: P3MessageActionsProps) {
  const [versionsOpen, setVersionsOpen] = useState(false);
  const role = useAuiState((state) => state.message.role);
  if (role === "user") {
    if (onEdit === undefined && otherVersions.length === 0) return null;
    return (
      <div
        className="mt-2 flex flex-wrap justify-end gap-1.5 thread-running:hidden"
        data-slot="p3-message-actions"
      >
        <div className="flex flex-wrap justify-end gap-1">
          {onEdit === undefined ? null : (
            <Button
              className={ACTION_CLASS}
              onClick={(event) => onEdit(event.currentTarget)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <PencilIcon aria-hidden="true" className="size-4" />
              <span className="sr-only">Edit</span>
            </Button>
          )}
          {otherVersions.length === 0 ? null : (
            <Button
              aria-expanded={versionsOpen}
              className={ACTION_CLASS}
              onClick={() => setVersionsOpen((open) => !open)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Other versions
            </Button>
          )}
        </div>
        {versionsOpen ? (
          <ul
            aria-label="Other versions"
            className="bg-popover text-popover-foreground border-foreground/10 rounded-surface flex max-w-full flex-col gap-1 border p-1 text-left"
          >
            {otherVersions.map((version) => (
              <li key={version.threadId}>
                <Button
                  className="justify-start"
                  onClick={() => {
                    setVersionsOpen(false);
                    onOpenOtherVersion?.(version.threadId);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {version.title}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  if (role === "assistant") {
    return (
      <ActionBarPrimitive.Root
        className="mt-2 flex items-center gap-1.5"
        data-slot="p3-message-actions"
      >
        <ActionBarPrimitive.Reload
          render={
            <Button
              aria-label="Regenerate response"
              className={ACTION_CLASS}
              size="icon-xs"
              type="button"
              variant="ghost"
            />
          }
        >
          <RefreshCwIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">Regenerate</span>
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    );
  }
  return null;
}

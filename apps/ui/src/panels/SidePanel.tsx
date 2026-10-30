import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatController } from "../chat/controller";
import { KEYS, keycap } from "../keys/table";
import { hidePanel, showPanel, usePanelState } from "./panel-state";
import { PANELS } from "./registry";

/**
 * The side column right of the workspace: one panel at a time, for the focused pane's chat. Closed by default; the rail
 * at the window's right edge, its key and the palette open it, and it opens on the panel it showed last. On a phone,
 * where there is no rail, it is a sheet from the right with the panels as tabs.
 */
export function SidePanel({
  client,
  folder,
  chat,
  phone,
  openGoal,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly chat: ChatController | null;
  readonly phone: boolean;
  /** Opens the goal dialog for a chat. */
  readonly openGoal: (chat: ChatController) => void;
}): ReactNode {
  const { open, panel } = usePanelState();
  const headerRef = useRef<HTMLElement>(null);
  const chosen = PANELS.find((item) => item.id === panel) ?? PANELS[0];
  if (chosen === undefined) return null;
  const body = (
    <>
      <header
        ref={headerRef}
        tabIndex={-1}
        className="flex items-center gap-1 border-b border-l2 px-3 py-2 outline-none"
      >
        {phone && PANELS.length > 1 && (
          <div
            role="tablist"
            aria-label="Panels"
            data-tour="side-panel-tabs"
            className="flex gap-0.5"
          >
            {PANELS.map((item) => (
              <Tooltip key={item.id}>
                <TooltipTrigger
                  render={
                    <Button
                      role="tab"
                      aria-selected={item.id === chosen.id}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={item.title}
                      className={item.id === chosen.id ? "text-t1" : "text-t3 hover:text-t1"}
                      onClick={() => showPanel(item.id)}
                    />
                  }
                >
                  <item.icon />
                </TooltipTrigger>
                <TooltipContent>{item.title}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
        <h2 className="px-1 text-[0.8125rem] font-semibold text-t1">{chosen.title}</h2>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close the side panel"
                className="text-t3 hover:text-t1"
                onClick={hidePanel}
              />
            }
          >
            <X />
          </TooltipTrigger>
          <TooltipContent>Close · {keycap(KEYS.sidePanel)}</TooltipContent>
        </Tooltip>
      </header>
      <div role="tabpanel" aria-label={chosen.title} className="min-h-0 flex-1 overflow-y-auto">
        {chosen.render({ client, folder, chat, openGoal })}
      </div>
    </>
  );
  if (phone) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) hidePanel();
        }}
      >
        <DialogContent
          data-tour="side-panel"
          showCloseButton={false}
          // The sheet opens on its header, not its close button, whose tooltip would take the first Esc.
          initialFocus={headerRef}
          className="top-0 right-0 left-auto flex h-dvh w-[min(360px,92vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">Side panel: {chosen.title}</DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  if (!open) return null;
  return (
    <aside
      data-tour="side-panel"
      aria-label="Side panel"
      className="my-1.5 mr-1.5 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-l2 bg-panel"
    >
      {body}
    </aside>
  );
}

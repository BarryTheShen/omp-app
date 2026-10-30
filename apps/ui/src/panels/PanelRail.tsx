import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KEYS, keycap } from "../keys/table";
import { hidePanel, showPanel, usePanelState } from "./panel-state";
import { PANELS } from "./registry";

/**
 * The side panel's opener, along the window's right edge where the panel opens: one button per panel. A click shows the
 * panel on that one, or hides it when it shows that one already; the button of the panel shown is pressed.
 */
export function PanelRail(): ReactNode {
  const { open, panel } = usePanelState();
  return (
    <nav
      aria-label="Side panel"
      data-tour="side-panel-rail"
      className="flex flex-col items-center gap-1 pt-1.5"
    >
      {PANELS.map((item) => {
        const shown = open && item.id === panel;
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={item.title}
                  aria-pressed={shown}
                  className="text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
                  onClick={() => (shown ? hidePanel() : showPanel(item.id))}
                />
              }
            >
              <item.icon />
            </TooltipTrigger>
            <TooltipContent side="left">
              {item.title} · {keycap(KEYS.sidePanel)} shows or hides the panel
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

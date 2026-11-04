import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../chat/controller";
import { useSidewaysRow } from "../sidewaysRow";
import { showPanel, usePanelState } from "./panel-state";
import { PANELS } from "./registry";

/**
 * A phone's details of the chat it shows, as a screen of their own in the chat's place: the side panel's panels (usage,
 * agents, progress, jobs, side questions) with their names on 44 px tabs, and ‹ back to the chat. The chat's top bar
 * opens it, as do the side panel's key and the palette. On a desktop the same panels are a pane (`SidePane`).
 */
export function ChatDetails({
  client,
  folder,
  chat,
  openGoal,
  onBack,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly chat: ChatController | null;
  /** Opens the goal dialog for a chat. */
  readonly openGoal: (chat: ChatController) => void;
  readonly onBack: () => void;
}): ReactNode {
  const { panel } = usePanelState();
  const tabRow = useSidewaysRow(panel);
  const chosen = PANELS.find((item) => item.id === panel) ?? PANELS[0];
  if (chosen === undefined) return null;
  return (
    <section
      aria-label="Chat details"
      data-tour="side-panel"
      className="flex min-h-0 flex-1 flex-col bg-panel"
    >
      <header className="flex h-11 shrink-0 items-center gap-1 px-1">
        <Button variant="ghost" size="sm" className="h-11 shrink-0 text-t2" onClick={onBack}>
          <ChevronLeft />
          Chat
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-t1">
          Details
        </h1>
        {/* As wide as the back button, so the title sits in the middle. */}
        <span aria-hidden="true" className="w-[4.5rem] shrink-0" />
      </header>
      <div
        ref={tabRow}
        role="tablist"
        aria-label="Details"
        className="row-scroll flex shrink-0 gap-1 border-b border-l2 px-2 pb-2"
      >
        {PANELS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === chosen.id}
            className={cn(
              "flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              item.id === chosen.id ? "bg-l2 font-medium text-t1" : "text-t2",
            )}
            onClick={() => showPanel(item.id)}
          >
            <item.icon className="size-4" />
            {item.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={chosen.title} className="min-h-0 flex-1 overflow-y-auto">
        {chosen.render({ client, folder, chat, openGoal })}
      </div>
    </section>
  );
}

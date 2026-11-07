import { Gauge } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatController } from "../chat/controller";
import { KEYS, keycap } from "../keys/table";
import type { QuestionsSnapshot } from "../questions/questions";
import { hidePanel, showPanel, usePanelState } from "./panel-state";
import { PANELS } from "./registry";

const NO_QUESTIONS: QuestionsSnapshot = { records: null, open: 0, focused: null };
const noSubscription = (): (() => void) => () => undefined;
const noQuestions = (): QuestionsSnapshot => NO_QUESTIONS;

/** How many questions the focused chat's agent asked that wait for an answer. */
function useOpenQuestions(chat: ChatController | null): number {
  return useSyncExternalStore(
    chat?.questions.subscribe ?? noSubscription,
    chat?.questions.getSnapshot ?? noQuestions,
  ).open;
}

/**
 * The side panel's opener, along the window's right edge where the panel opens: one button per panel. A click shows the
 * panel on that one, or hides it when it shows that one already; the button of the panel shown is pressed. Under them,
 * the dashboard (#2836).
 */
export function PanelRail({
  chat,
  onDashboard,
}: {
  /** The focused pane's chat: the BTW button counts its questions that wait for an answer. */
  readonly chat: ChatController | null;
  readonly onDashboard: () => void;
}): ReactNode {
  const { open, panel } = usePanelState();
  const waiting = useOpenQuestions(chat);
  return (
    <nav
      aria-label="Side panel"
      data-tour="side-panel-rail"
      // As short as the page: a phone held sideways with its keyboard up leaves 193 pt, and a rail as tall as its
      // buttons held the row (and the message box with it) under the keyboard (#2824). It scrolls instead.
      className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto pt-1.5 [scrollbar-width:none]"
    >
      {PANELS.map((item) => {
        const shown = open && item.id === panel;
        const count = item.id === "btw" ? waiting : 0;
        const label =
          count > 0
            ? `${item.title}, ${count === 1 ? "1 question" : `${count} questions`} for you`
            : item.title;
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  aria-pressed={shown}
                  className="relative text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1 tablet:size-11"
                  onClick={() => (shown ? hidePanel() : showPanel(item.id))}
                />
              }
            >
              <item.icon />
              {count > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-medium text-primary-foreground"
                >
                  {count}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="left">
              {label} · {keycap(KEYS.sidePanel)} shows or hides the panel
            </TooltipContent>
          </Tooltip>
        );
      })}
      <div aria-hidden="true" className="my-0.5 h-px w-5 shrink-0 bg-l2" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              data-tour="dashboard-button"
              variant="ghost"
              size="icon-sm"
              aria-label="Dashboard"
              aria-keyshortcuts="Control+Shift+D"
              className="text-t3 hover:text-t1 tablet:size-11"
              onClick={onDashboard}
            />
          }
        >
          <Gauge />
        </TooltipTrigger>
        <TooltipContent side="left">
          Dashboard: usage, pace, rules and the queue · {keycap(KEYS.dashboard)}
        </TooltipContent>
      </Tooltip>
    </nav>
  );
}

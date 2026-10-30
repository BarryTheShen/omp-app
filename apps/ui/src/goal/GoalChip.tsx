import type { GoalAnswer } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { Target } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatController } from "../chat/controller";
import { GOAL_SAID, GoalDetails } from "./GoalDetails";

/**
 * omp's goal mode in the message box, while the chat has a goal: the objective and its state; it opens the goal's
 * numbers, and Pause, Resume and Drop.
 */
export function GoalChip({
  controller,
  goal,
}: {
  readonly controller: ChatController;
  readonly goal: GoalAnswer["goal"];
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (goal === null || goal.status === "dropped") return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-w-56 min-w-0 shrink gap-1.5 text-t2 hover:text-t1"
            aria-label={`Goal: ${goal.objective} (${GOAL_SAID[goal.status]})`}
          />
        }
      >
        <Target className={cn(goal.status === "active" && "text-accent-ink")} />
        <span className="truncate">{goal.objective}</span>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80">
        <GoalDetails controller={controller} goal={goal} onDropped={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

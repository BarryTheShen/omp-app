import type { GoalAnswer } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { Target } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatController } from "../chat/controller";
import { fmtDuration, fmtTokens } from "../vendor/collab-web/lib/format";

type Goal = NonNullable<GoalAnswer["goal"]>;

/** omp's goal states, as the chip says them. */
const SAID = {
  active: "Working on it",
  paused: "Paused",
  "budget-limited": "Out of budget",
  complete: "Done",
  dropped: "Dropped",
} as const satisfies Record<Goal["status"], string>;

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
  const [problem, setProblem] = useState<string | null>(null);
  if (goal === null || goal.status === "dropped") return null;
  const said = SAID[goal.status];
  const run = (op: "pause" | "resume" | "drop"): void => {
    setProblem(null);
    controller
      .goal(op)
      .then(() => {
        if (op === "drop") setOpen(false);
      })
      .catch((failure: unknown) =>
        setProblem(failure instanceof Error ? failure.message : String(failure)),
      );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-w-56 min-w-0 shrink gap-1.5 text-t2 hover:text-t1"
            aria-label={`Goal: ${goal.objective} (${said})`}
          />
        }
      >
        <Target className={cn(goal.status === "active" && "text-accent-ink")} />
        <span className="truncate">{goal.objective}</span>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80">
        <section aria-label="Goal" className="flex flex-col gap-3">
          <p className="text-sm text-t1">{goal.objective}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-t3">State</dt>
            <dd className="text-t2">{said}</dd>
            <dt className="text-t3">Tokens</dt>
            <dd className="text-t2 tabular-nums">
              {fmtTokens(goal.tokensUsed)}
              {goal.tokenBudget === undefined ? "" : ` of ${fmtTokens(goal.tokenBudget)}`}
            </dd>
            <dt className="text-t3">Time</dt>
            <dd className="text-t2 tabular-nums">
              {/* omp counts whole seconds: "42s" under a minute, then "5m03s", "1h02m". */}
              {goal.timeUsedSeconds < 60
                ? `${Math.max(0, Math.round(goal.timeUsedSeconds))}s`
                : fmtDuration(goal.timeUsedSeconds * 1000)}
            </dd>
          </dl>
          {problem !== null && (
            <p role="alert" className="text-xs text-bad-ink">
              {problem}
            </p>
          )}
          <div className="flex gap-2">
            {goal.status === "active" && (
              <Button type="button" size="sm" variant="outline" onClick={() => run("pause")}>
                Pause
              </Button>
            )}
            {(goal.status === "paused" || goal.status === "budget-limited") && (
              <Button type="button" size="sm" variant="outline" onClick={() => run("resume")}>
                Resume
              </Button>
            )}
            <Button type="button" size="sm" variant="destructive" onClick={() => run("drop")}>
              Drop
            </Button>
          </div>
        </section>
      </PopoverContent>
    </Popover>
  );
}

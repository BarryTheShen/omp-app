import type { GoalAnswer } from "@omp-app/contracts/chat-host";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../chat/controller";
import { fmtDuration, fmtTokens } from "../vendor/collab-web/lib/format";

export type Goal = NonNullable<GoalAnswer["goal"]>;

/** omp's goal states, as the app says them. */
export const GOAL_SAID = {
  active: "Working on it",
  paused: "Paused",
  "budget-limited": "Out of budget",
  complete: "Done",
  dropped: "Dropped",
} as const satisfies Record<Goal["status"], string>;

/**
 * A goal's objective, its state, tokens and time, and Pause, Resume and Drop: the goal chip's popover and the side
 * panel's Progress show it.
 */
export function GoalDetails({
  controller,
  goal,
  onDropped,
}: {
  readonly controller: ChatController;
  readonly goal: Goal;
  /** After Drop: the chip's popover closes. */
  readonly onDropped?: () => void;
}): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);
  const run = (op: "pause" | "resume" | "drop"): void => {
    setProblem(null);
    controller
      .goal(op)
      .then(() => {
        if (op === "drop") onDropped?.();
      })
      .catch((failure: unknown) =>
        setProblem(failure instanceof Error ? failure.message : String(failure)),
      );
  };
  return (
    <section aria-label="Goal" className="flex flex-col gap-3">
      <p className="text-sm text-t1">{goal.objective}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-t3">State</dt>
        <dd className="text-t2">{GOAL_SAID[goal.status]}</dd>
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
  );
}

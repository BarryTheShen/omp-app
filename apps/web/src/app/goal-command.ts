import type { GoalOperation, GoalRpcArgs, GoalRpcResult, GoalStatus } from "@/modules/D8/contract";

/** What a typed `/goal` asks omp for: one goal operation, or a reason the app does not run it. */
export type GoalCommand =
  | { readonly kind: "operation"; readonly args: GoalRpcArgs }
  | { readonly kind: "refused"; readonly reason: string };

const STATUS_WORDS: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  "budget-limited": "Out of token budget",
  complete: "Complete",
  dropped: "Dropped",
};

/** What omp has when there is no goal for an operation to act on. A drop that succeeds leaves no goal behind. */
const NO_GOAL: Record<Exclude<GoalOperation, "drop">, string> = {
  get: "No goal is set for this chat.",
  create: "omp did not set the goal.",
  pause: "There is no goal to pause.",
  resume: "There is no goal to resume.",
};

/**
 * Reads the text after `/goal`. Nothing, or `show`, reads the goal; `pause`, `resume` and `drop` act on it; any other
 * text is the objective of a new goal. `budget` is not in the app yet, so it is refused with that reason instead of
 * becoming an objective.
 */
export function parseGoalCommand(text: string): GoalCommand {
  const words = text.trim();
  const word = words.toLowerCase();
  if (word === "" || word === "show") return { kind: "operation", args: { op: "get" } };
  if (word === "pause" || word === "resume" || word === "drop") {
    return { kind: "operation", args: { op: word } };
  }
  if (/^budget(\s|$)/u.test(word)) {
    return {
      kind: "refused",
      reason: "Changing a goal's token budget is not in the app yet. Use omp's terminal for it.",
    };
  }
  return { kind: "operation", args: { op: "create", objective: words } };
}

/** Says what omp now has, in plain words. `result` is what omp answered for `op`. */
export function describeGoalResult(op: GoalOperation, result: GoalRpcResult): string {
  const goal = result.goal;
  if (op === "drop") return goal === null ? "Goal dropped." : `Goal dropped: ${goal.objective}.`;
  if (goal === null) return NO_GOAL[op];
  const status = `Status: ${STATUS_WORDS[goal.status]}.`;
  switch (op) {
    case "get":
      return `Goal: ${goal.objective}. ${status}`;
    case "create":
      return `Goal set: ${goal.objective}. ${status}`;
    case "pause":
      return `Goal paused: ${goal.objective}. ${status}`;
    case "resume":
      return `Goal resumed: ${goal.objective}. ${status}`;
  }
}

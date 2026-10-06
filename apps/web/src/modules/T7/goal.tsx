import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeGoal, type GoalDetails } from "./models";

const OPERATION_LABELS = {
  create: "Create goal",
  get: "Check goal",
  complete: "Complete goal",
  resume: "Resume goal",
  drop: "Drop goal",
} as const satisfies Record<NonNullable<GoalDetails["op"]>, string>;

const STATUS_LABELS = {
  active: "Active",
  paused: "Paused",
  "budget-limited": "Budget limited",
  complete: "Complete",
  dropped: "Dropped",
} as const satisfies Record<NonNullable<NonNullable<GoalDetails["goal"]>["status"]>, string>;

export function GoalCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const output = state.result ?? state.partialResult;
  // omp results carry structured data under `details`; bare detail objects pass through.
  const decoded = decodeGoal(
    output !== null && typeof output === "object" && "details" in output ? output.details : output,
  );
  const details = decoded.ok ? decoded.value : undefined;
  const goal = details?.goal ?? undefined;
  // The call's arguments are `{ op, objective?, token_budget? }`; they name the goal while it runs.
  const requested = decodeGoal(state.args);
  const args = requested.ok ? requested.value : undefined;
  const objective = goal?.objective ?? (typeof args?.objective === "string" ? args.objective : "");
  const op = details?.op ?? args?.op;
  const summary = objective.trim()
    ? oneLine(objective, 96)
    : op === undefined
      ? undefined
      : OPERATION_LABELS[op];
  const facts = goal === undefined ? [] : goalFacts(goal, details?.remainingTokens);
  const goalError = details?.error?.message;
  const settled = state.phase === "success";

  return (
    <div data-testid={`t7-goal-card-${state.toolCallId}`}>
      <ToolCard rawResult={rawText(output)} state={state} summary={summary} />
      {!decoded.ok && settled && (
        <p className="text-muted-foreground ms-2 py-1 text-xs">Goal details unavailable.</p>
      )}
      {details?.goal === null && settled && (
        <p className="text-muted-foreground ms-2 py-1 text-xs">No active goal.</p>
      )}
      {facts.length > 0 && (
        <p className="text-muted-foreground ms-2 py-1 text-xs">{facts.join(" · ")}</p>
      )}
      {/* omp's completionBudgetReport is written for the model and repeats the budget line; it stays in the raw details. */}
      {typeof goalError === "string" && goalError.trim() && state.phase !== "error" && (
        <p className="text-destructive ms-2 py-1 text-xs font-medium">{oneLine(goalError, 160)}</p>
      )}
    </div>
  );
}

export const GoalToolRenderer: ToolRenderer = (props) => <GoalCard rendererProps={props} />;

function goalFacts(
  goal: NonNullable<GoalDetails["goal"]>,
  remaining: number | null | undefined,
): readonly string[] {
  const facts: string[] = [];
  if (goal.status !== undefined) facts.push(STATUS_LABELS[goal.status]);
  if (goal.tokensUsed !== undefined) {
    facts.push(
      goal.tokenBudget === undefined
        ? `${tokens(goal.tokensUsed)} used`
        : `${goal.tokensUsed.toLocaleString()} of ${tokens(goal.tokenBudget)} used`,
    );
  }
  if (typeof remaining === "number") facts.push(`${tokens(remaining)} left`);
  return facts;
}

function tokens(count: number): string {
  return `${count.toLocaleString()} token${count === 1 ? "" : "s"}`;
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable goal result]";
  }
}

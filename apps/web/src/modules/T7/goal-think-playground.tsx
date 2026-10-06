import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GoalCard } from "./goal";
import { ThinkCard } from "./think";

function props(
  toolCallId: string,
  toolName: "goal" | "think",
  args: unknown,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const THOUGHT = "Private scratchpad: compare the two parser designs before answering";

function GoalThinkPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t7-goal-think-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-3xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Goal and private note cards</h1>
        <p className="text-muted-foreground text-sm">
          Goal status and token budget, and private notes that never show their content
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-3xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <GoalCard
          rendererProps={props(
            "goal-active",
            "goal",
            {
              op: "create",
              objective: "Ship the release notes for version 2.4 with migration steps",
              token_budget: 50_000,
            },
            {
              content: [{ type: "text", text: "Goal: Ship the release notes" }],
              details: {
                op: "create",
                goal: {
                  id: "goal-active",
                  objective: "Ship the release notes for version 2.4 with migration steps",
                  status: "active",
                  tokenBudget: 50_000,
                  tokensUsed: 12_000,
                  timeUsedSeconds: 240,
                  createdAt: 1,
                  updatedAt: 2,
                },
                remainingTokens: 38_000,
                completionBudgetReport: null,
              },
            },
          )}
        />
        <GoalCard
          rendererProps={props(
            "goal-complete",
            "goal",
            { op: "complete" },
            {
              content: [{ type: "text", text: "Goal: Migrate the settings page" }],
              details: {
                op: "complete",
                goal: {
                  id: "goal-complete",
                  objective: "Migrate the settings page to the new form components",
                  status: "complete",
                  tokenBudget: 80_000,
                  tokensUsed: 61_500,
                  timeUsedSeconds: 1_800,
                  createdAt: 1,
                  updatedAt: 3,
                },
                remainingTokens: 18_500,
                completionBudgetReport:
                  "Goal achieved. Report final budget usage to the user: tokens used: 61500 of 80000; time used: 1800 seconds.",
              },
            },
          )}
        />
        <ThinkCard
          rendererProps={props("think-running", "think", { thoughts: THOUGHT }, undefined, {
            type: "running",
          })}
        />
        <ThinkCard
          rendererProps={props(
            "think-recorded",
            "think",
            { thoughts: THOUGHT },
            { content: [{ type: "text", text: "------" }], details: { recorded: true } },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t7-goal-think-playground-root");
if (!root) throw new Error("Goal and think playground root is missing.");
createRoot(root).render(<GoalThinkPlayground />);

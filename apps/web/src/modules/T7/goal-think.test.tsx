import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GoalCard } from "./goal";
import { ThinkCard } from "./think";

afterEach(cleanup);

const THOUGHT = "Secret plan: rewrite the parser before telling anyone";

function props(
  toolName: "goal" | "think",
  args: unknown,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  toolCallId = `${toolName}-1`,
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

/** The card header; other buttons (copy) appear once the card is open. */
function header(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>("[data-slot='u3-tool-card-trigger']");
  if (!trigger) throw new Error("Tool card header is missing.");
  return trigger;
}

/** The card's text minus its raw-details disclosure (the raw arguments and result). */
function shownText(element: HTMLElement): string {
  const raw = element.querySelector<HTMLElement>("[data-slot='u3-tool-card-raw']");
  return (element.textContent ?? "").replace(raw?.textContent ?? "", "");
}

/** omp v18.6.1 goal result envelope: `{ content, details }` with the goal nested in `details`. */
function goalResult(details: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: "Goal: …" }], details };
}

function goal(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: "goal-1", timeUsedSeconds: 0, createdAt: 1, updatedAt: 2, ...fields };
}

describe("GoalCard", () => {
  test("shows the objective in the header and the token budget below", () => {
    render(
      <GoalCard
        rendererProps={props(
          "goal",
          { op: "create", objective: "Ship the release notes", token_budget: 50_000 },
          goalResult({
            op: "create",
            goal: goal({
              objective: "Ship the release notes",
              status: "active",
              tokenBudget: 50_000,
              tokensUsed: 12_000,
            }),
            remainingTokens: 38_000,
            completionBudgetReport: null,
          }),
        )}
      />,
    );
    expandToolCards();
    const card = screen.getByTestId("t7-goal-card-goal-1");
    expect(header().textContent).toContain("Ship the release notes");
    expect(card.textContent).toContain(
      "Active · 12,000 of 50,000 tokens used · 38,000 tokens left",
    );
  });

  test("a completed goal keeps omp's model-facing budget report in the raw details only", () => {
    const report =
      "Goal achieved. Report final budget usage to the user: tokens used: 1 of 2; time used: 5 seconds.";
    render(
      <GoalCard
        rendererProps={props(
          "goal",
          { op: "complete" },
          goalResult({
            op: "complete",
            goal: goal({ objective: "Tidy the docs", status: "complete", tokensUsed: 1 }),
            remainingTokens: null,
            completionBudgetReport: report,
          }),
          undefined,
          "goal-report",
        )}
      />,
    );
    expandToolCards();
    const card = screen.getByTestId("t7-goal-card-goal-report");
    expect(header().textContent).toContain("Tidy the docs");
    expect(card.textContent).toContain("Complete · 1 token used");
    expect(shownText(card)).not.toContain("tokens left");
    expect(shownText(card)).not.toContain("Goal achieved");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(card.querySelector("[data-slot='u3-tool-card-result']")?.textContent ?? "").toContain(
      "Goal achieved",
    );
  });

  test("a check with no goal says so and labels the operation", () => {
    render(
      <GoalCard
        rendererProps={props(
          "goal",
          { op: "get" },
          goalResult({
            op: "get",
            goal: null,
            remainingTokens: null,
            completionBudgetReport: null,
          }),
        )}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("Check goal");
    expect(screen.getByText("No active goal.")).toBeTruthy();
  });

  test("a running create shortens the requested objective to one line", () => {
    const objective = `Refactor ${"the storage layer ".repeat(10)}`;
    render(
      <GoalCard
        rendererProps={props("goal", { op: "create", objective }, undefined, { type: "running" })}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("…");
    expect(header().textContent).not.toContain(objective.trim());
    expect(screen.queryByText("Goal details unavailable.")).toBeNull();
  });

  test("malformed details show one muted fallback line and no raw data", () => {
    render(
      <GoalCard
        rendererProps={props(
          "goal",
          { op: "get" },
          goalResult({ op: "get", goal: { status: "finished", tokensUsed: "many" } }),
          undefined,
          "goal-malformed",
        )}
      />,
    );
    const card = screen.getByTestId("t7-goal-card-goal-malformed");
    expect(header().textContent).toContain("Check goal");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expandToolCards();
    expect(screen.getByText("Goal details unavailable.")).toBeTruthy();
    expect(shownText(card)).not.toContain("many");
  });

  test("the goal's own error shows once, and never next to the tool error", () => {
    const details = {
      op: "resume",
      goal: goal({ objective: "Finish the audit", status: "budget-limited", tokensUsed: 10 }),
      error: { message: "The token budget is used up." },
    };
    const { unmount } = render(
      <GoalCard rendererProps={props("goal", { op: "resume" }, goalResult(details))} />,
    );
    expandToolCards();
    expect(screen.getByText("The token budget is used up.")).toBeTruthy();
    expect(screen.getByTestId("t7-goal-card-goal-1").textContent).toContain("Budget limited");
    unmount();

    render(
      <GoalCard
        rendererProps={props(
          "goal",
          { op: "resume" },
          goalResult(details),
          { type: "incomplete", reason: "error" },
          "goal-failed",
        )}
      />,
    );
    expandToolCards();
    expect(screen.queryByText("The token budget is used up.")).toBeNull();
    expect(screen.queryByText("Goal details unavailable.")).toBeNull();
  });
});

describe("ThinkCard", () => {
  test("recorded thought shows the acknowledgment and never the thought text", () => {
    render(
      <ThinkCard
        rendererProps={props(
          "think",
          { thoughts: THOUGHT },
          { content: [{ type: "text", text: "------" }], details: { recorded: true } },
        )}
      />,
    );
    fireEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(header().textContent).toContain("Private note recorded");
    expect(screen.getByText("The content stays private.")).toBeTruthy();
    expect(document.body.textContent).not.toContain(THOUGHT);
  });

  test("running thought shows the recording state", () => {
    render(
      <ThinkCard
        rendererProps={props(
          "think",
          { thoughts: THOUGHT },
          undefined,
          { type: "running" },
          "think-running",
        )}
      />,
    );
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(header().textContent).toContain("Recording private note…");
    fireEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).not.toContain(THOUGHT);
  });

  test("failed thought reads as not recorded and still hides the text", () => {
    render(
      <ThinkCard
        rendererProps={props(
          "think",
          { thoughts: THOUGHT },
          { status: "error" },
          { type: "incomplete", reason: "error" },
          "think-failed",
        )}
      />,
    );
    expandToolCards();
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(header().textContent).toContain("Private note not recorded");
    expect(document.body.textContent).not.toContain(THOUGHT);
  });
});

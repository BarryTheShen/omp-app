import { AppError } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Goal, GoalState } from "../contract";
import { continuationStatus } from "../contract";
import type { GoalPanelSnapshot } from "./controller";
import { GoalPanelView, type GoalPanelViewProps } from "./view";

afterEach(cleanup);

function makeGoal(status: Goal["status"] = "active"): Goal {
  return {
    id: "goal-view",
    objective: "Keep the project healthy",
    status,
    tokensUsed: 1_250,
    timeUsedSeconds: 65,
    createdAt: 1,
    updatedAt: 2,
    tokenBudget: 5_000,
  };
}

function makeSnapshot(patch: Partial<GoalPanelSnapshot> = {}): GoalPanelSnapshot {
  const goal = patch.goal === undefined ? makeGoal() : patch.goal;
  const goalState: GoalState | null =
    patch.goalState === undefined
      ? {
          goal,
          state: goal
            ? {
                enabled: goal.status === "active" || goal.status === "budget-limited",
                mode: goal.status === "complete" ? "exiting" : "active",
                goal,
              }
            : null,
          source: "request",
          sessionSettled: true,
        }
      : patch.goalState;
  const continuation =
    patch.continuation === undefined
      ? continuationStatus(goal, ["interactive"])
      : patch.continuation;
  const showCreate = goal === null || goal.status === "complete" || goal.status === "dropped";
  const showPause = goal?.status === "active" || goal?.status === "budget-limited";
  const showResume = goal?.status === "paused";
  const showDrop = showPause || showResume;

  return {
    lifecycle: patch.lifecycle ?? "populated",
    goalState,
    goal,
    continuation,
    pending: null,
    error: null,
    notice: null,
    capabilityMessage: null,
    showPause,
    showResume,
    showDrop,
    createAvailability: showCreate
      ? { state: "available" }
      : { state: "unavailable", reason: "Finish the current goal first." },
    pauseAvailability: showPause
      ? { state: "available" }
      : { state: "unavailable", reason: "This goal cannot be paused in its current state." },
    resumeAvailability: showResume
      ? { state: "available" }
      : { state: "unavailable", reason: "This goal is not paused." },
    dropAvailability: showDrop
      ? { state: "available" }
      : { state: "unavailable", reason: "This goal can no longer be dropped." },
    editAvailability: {
      state: "unavailable",
      reason: "Editing the goal and its token budget is not available yet.",
      capability: "upstream.goal-update",
    },
    budgetAvailability: {
      state: "unavailable",
      reason: "Editing the goal and its token budget is not available yet.",
      capability: "upstream.goal-update",
    },
    ...patch,
    showCreate: patch.showCreate ?? showCreate,
  };
}

function renderGoal(
  snapshot = makeSnapshot(),
  focus: Pick<GoalPanelViewProps, "invokingFocus" | "restoreFocus"> = {},
) {
  const actions = {
    onOpenChange: vi.fn(),
    onRefresh: vi.fn(),
    onCreate: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onDrop: vi.fn(),
  };
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <GoalPanelView
        open={open}
        position="right"
        snapshot={snapshot}
        {...focus}
        {...actions}
        onOpenChange={(next, reason) => {
          actions.onOpenChange(next, reason);
          setOpen(next);
        }}
      />
    );
  }
  render(<Harness />);
  return actions;
}

describe("GoalPanelView", () => {
  test("forwards panel focus tokens to PanelShell for restoration on close", () => {
    const restoreFocus = vi.fn();
    renderGoal(makeSnapshot(), { invokingFocus: "goal-opener", restoreFocus });

    fireEvent.click(screen.getByRole("button", { name: "Close Goal" }));

    expect(restoreFocus).toHaveBeenCalledWith("goal-opener");
  });

  test("shows no continuation row when the goal has no continuation status", () => {
    renderGoal(makeSnapshot({ continuation: null }));
    expect(screen.queryByText("Continuation")).toBeNull();
  });

  test("shows the objective, status, budget, time and continuation in plain language", () => {
    renderGoal();

    expect(screen.getByRole("region", { name: "Goal" })).toBeTruthy();
    expect(screen.getByText("Keep the project healthy")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("5,000 tokens")).toBeTruthy();
    expect(screen.getByText("1 minute 5 seconds")).toBeTruthy();
    expect(
      screen.getByText(
        'omp will not continue this goal by itself. Add "rpc" to Goal Continuation Modes in Settings, Tasks, to let it.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText("active")).toBeNull();
    expect(screen.queryByText("goal-update")).toBeNull();
  });

  test.each([
    { status: "paused", label: "Paused" },
    { status: "budget-limited", label: "Budget limited" },
    { status: "complete", label: "Complete" },
    { status: "dropped", label: "Dropped" },
  ] as const)("shows the $label goal status in plain language", ({ status, label }) => {
    renderGoal(makeSnapshot({ goal: makeGoal(status) }));
    expect(screen.getByText(label)).toBeTruthy();
  });

  test("passes pause, resume and drop actions through callbacks", () => {
    const actions = renderGoal();

    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Drop goal" }));
    expect(actions.onPause).toHaveBeenCalledOnce();
    expect(actions.onDrop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Edit goal" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Change budget" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByText("Editing the goal and its token budget is not available yet."),
    ).toBeTruthy();
  });

  test("renders empty, unavailable, loading and recoverable error states", () => {
    const empty = makeSnapshot({
      lifecycle: "populated",
      goal: null,
      goalState: { goal: null, state: null, source: "request", sessionSettled: true },
    });
    renderGoal(empty);
    expect(screen.getByText("No goal is active")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a goal" })).toBeTruthy();
    cleanup();

    const unavailable = makeSnapshot({
      lifecycle: "populated",
      capabilityMessage: "Goal actions are unavailable for this connection.",
      createAvailability: {
        state: "unavailable",
        reason: "Goal actions are unavailable for this connection.",
        capability: "omp.cmd.goal",
      },
      goal: null,
      goalState: { goal: null, state: null, source: "reconciled", sessionSettled: true },
    });
    renderGoal(unavailable);
    expect(screen.getByText("Goal actions are unavailable for this connection.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a goal" }).hasAttribute("disabled")).toBe(
      true,
    );
    cleanup();

    const loading = makeSnapshot({
      lifecycle: "loading",
      goal: null,
      goalState: null,
      continuation: null,
    });
    renderGoal(loading);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    cleanup();

    const error = makeSnapshot({
      lifecycle: "error",
      goal: null,
      goalState: null,
      continuation: null,
      error: AppError.parse({
        code: "timeout",
        message: "The goal could not be loaded. Try again.",
        retryable: true,
      }),
    });
    const actions = renderGoal(error);
    expect(screen.getByRole("alert").textContent).toContain("The goal could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(actions.onRefresh).toHaveBeenCalledOnce();
  });
});

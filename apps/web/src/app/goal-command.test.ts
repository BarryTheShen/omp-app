import { describe, expect, test } from "vitest";
import type { Goal, GoalResult } from "@/modules/D8/contract";
import { describeGoalResult, parseGoalCommand } from "./goal-command";

const goal: Goal = {
  id: "goal-1",
  objective: "Ship the release notes",
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
};
const none: GoalResult = { goal: null, state: null };

describe("#1261 /goal reads what follows the name", () => {
  test("nothing, or show, reads the goal", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "operation", args: { op: "get" } });
    expect(parseGoalCommand("   ")).toEqual({ kind: "operation", args: { op: "get" } });
    expect(parseGoalCommand("Show")).toEqual({ kind: "operation", args: { op: "get" } });
  });

  test("pause, resume and drop act on the goal, in any letter case", () => {
    expect(parseGoalCommand("pause")).toEqual({ kind: "operation", args: { op: "pause" } });
    expect(parseGoalCommand("RESUME")).toEqual({ kind: "operation", args: { op: "resume" } });
    expect(parseGoalCommand("drop")).toEqual({ kind: "operation", args: { op: "drop" } });
  });

  test("other text is the objective of a new goal, trimmed", () => {
    expect(parseGoalCommand("  Ship the release notes  ")).toEqual({
      kind: "operation",
      args: { op: "create", objective: "Ship the release notes" },
    });
  });

  test("budget is refused with its reason, not made into an objective", () => {
    expect(parseGoalCommand("budget 5000")).toEqual({
      kind: "refused",
      reason: "Changing a goal's token budget is not in the app yet. Use omp's terminal for it.",
    });
    expect(parseGoalCommand("Budget")).toMatchObject({ kind: "refused" });
  });

  test("a word that only starts with budget is an objective", () => {
    expect(parseGoalCommand("budgets for Q4")).toEqual({
      kind: "operation",
      args: { op: "create", objective: "budgets for Q4" },
    });
  });
});

describe("#1261 /goal says what omp now has, in plain words", () => {
  test("a bare read with no goal says so", () => {
    expect(describeGoalResult("get", none)).toBe("No goal is set for this chat.");
  });

  test("a read shows the objective and its status", () => {
    expect(describeGoalResult("get", { goal, state: null })).toBe(
      "Goal: Ship the release notes. Status: Active.",
    );
  });

  test("a status with its own words reads plainly", () => {
    expect(
      describeGoalResult("get", { goal: { ...goal, status: "budget-limited" }, state: null }),
    ).toBe("Goal: Ship the release notes. Status: Out of token budget.");
    expect(describeGoalResult("get", { goal: { ...goal, status: "complete" }, state: null })).toBe(
      "Goal: Ship the release notes. Status: Complete.",
    );
  });

  test("setting, pausing and resuming name the objective and the status", () => {
    expect(describeGoalResult("create", { goal, state: null })).toBe(
      "Goal set: Ship the release notes. Status: Active.",
    );
    const paused = { goal: { ...goal, status: "paused" as const }, state: null };
    expect(describeGoalResult("pause", paused)).toBe(
      "Goal paused: Ship the release notes. Status: Paused.",
    );
    expect(describeGoalResult("resume", { goal, state: null })).toBe(
      "Goal resumed: Ship the release notes. Status: Active.",
    );
  });

  test("dropping names the objective when omp still returns it", () => {
    expect(describeGoalResult("drop", { goal: { ...goal, status: "dropped" }, state: null })).toBe(
      "Goal dropped: Ship the release notes.",
    );
  });

  test("a drop that leaves no goal behind still reports that the goal was dropped", () => {
    expect(describeGoalResult("drop", none)).toBe("Goal dropped.");
  });

  test("pausing, resuming or setting with no goal to act on says what is missing", () => {
    expect(describeGoalResult("pause", none)).toBe("There is no goal to pause.");
    expect(describeGoalResult("resume", none)).toBe("There is no goal to resume.");
    expect(describeGoalResult("create", none)).toBe("omp did not set the goal.");
  });
});

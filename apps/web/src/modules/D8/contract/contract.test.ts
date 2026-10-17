import { describe, expect, test } from "vitest";
import {
  AP6_UNAVAILABLE_REASONS,
  continuationStatus,
  D8_AP6_CAPABILITIES,
  type Goal,
  GoalCreateRequestSchema,
  GoalRpcArgsSchema,
  GoalStateSchema,
  unavailableAutonomy,
  WorkerDispatchRequestSchema,
  WorkerObservationSchema,
} from ".";

const goal: Goal = {
  id: "goal-1",
  objective: "Keep the test suite green",
  status: "active",
  tokensUsed: 120,
  timeUsedSeconds: 30,
  createdAt: 1,
  updatedAt: 2,
  tokenBudget: 1_000,
};

describe("D8 autonomy contracts", () => {
  test("validates released goal operations and preserves state/resource fields", () => {
    expect(GoalRpcArgsSchema.parse({ op: "get" })).toMatchObject({ op: "get" });
    expect(
      GoalCreateRequestSchema.parse({ objective: "  Keep tests green  ", token_budget: 100 }),
    ).toEqual({ objective: "Keep tests green", token_budget: 100 });
    const state = GoalStateSchema.parse({
      goal,
      state: { enabled: true, mode: "active", goal },
      source: "rpc",
      sessionSettled: false,
      futureState: { retained: true },
    });
    expect(state.goal?.tokenBudget).toBe(1_000);
    expect(state.futureState).toEqual({ retained: true });
  });

  test("says what omp does with an open goal, from its own setting", () => {
    expect(continuationStatus(goal, ["rpc"])?.label).toBe(
      "omp keeps working on this goal by itself.",
    );
    expect(continuationStatus({ ...goal, status: "paused" }, ["rpc"])?.label).toBe("Paused");
    expect(continuationStatus(goal, ["interactive"])?.label).toBe(
      'omp will not continue this goal by itself. Add "rpc" to Goal Continuation Modes in Settings, Tasks, to let it.',
    );
    expect(continuationStatus(goal, null)?.label).toBe(
      "The app cannot tell whether omp continues this goal by itself.",
    );
  });

  test("shows no continuation status for a goal that is finished, dropped, or absent", () => {
    expect(continuationStatus(null, ["rpc"])).toBeNull();
    expect(continuationStatus({ ...goal, status: "complete" }, ["rpc"])).toBeNull();
    expect(continuationStatus({ ...goal, status: "dropped" }, ["rpc"])).toBeNull();
  });

  test("keeps the AP6 capabilities unavailable with their reasons", () => {
    expect(D8_AP6_CAPABILITIES.loop).toBe("upstream.loop");
    expect(AP6_UNAVAILABLE_REASONS.loop).toContain("cannot repeat a prompt");
    expect(
      unavailableAutonomy(D8_AP6_CAPABILITIES.vibeWorker, AP6_UNAVAILABLE_REASONS.vibeWorker)
        .appError,
    ).toMatchObject({
      code: "unavailable",
      capability: "upstream.vibe-worker",
    });
  });
});

describe("D8 worker contracts", () => {
  test("keeps worker observations and lineage tolerant", () => {
    const worker = WorkerObservationSchema.parse({
      id: "worker-1",
      kind: "vibe",
      status: "running",
      progress: 0.5,
      lineage: ["goal-1"],
      transcriptRef: { threadId: "thread-1", future: "kept" },
      futureWorkerField: "retained",
    });
    expect(worker.transcriptRef?.future).toBe("kept");
    expect(worker.futureWorkerField).toBe("retained");
    expect(WorkerDispatchRequestSchema.parse({ objective: "Inspect failures" })).toEqual({
      objective: "Inspect failures",
    });
  });
});

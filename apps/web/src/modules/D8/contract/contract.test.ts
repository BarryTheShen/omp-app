import { describe, expect, test } from "vitest";
import {
  AP6_UNAVAILABLE_REASONS,
  continuationPolicy,
  D8_AP6_CAPABILITIES,
  GoalCreateRequestSchema,
  GoalRpcArgsSchema,
  GoalStateSchema,
  goalStateFromEvent,
  goalStateFromResult,
  unavailableAutonomy,
  WorkerDispatchRequestSchema,
  WorkerObservationSchema,
} from ".";

const goal = {
  id: "goal-1",
  objective: "Keep the test suite green",
  status: "active" as const,
  tokensUsed: 120,
  timeUsedSeconds: 30,
  createdAt: 1,
  updatedAt: 2,
  tokenBudget: 1_000,
  continuationModes: ["rpc"],
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

  test("maps goal_updated without inferring continuation from command text", () => {
    const state = goalStateFromEvent({
      type: "goal_updated",
      goal,
      state: { enabled: true, mode: "active", goal },
    });
    expect(state.source).toBe("event");
    expect(continuationPolicy(state).mode).toBe("rpc");

    const paused = goalStateFromResult(
      {
        goal: { ...goal, status: "paused" },
        state: { enabled: true, mode: "active", goal: { ...goal, status: "paused" } },
      },
      "rpc",
      true,
    );
    expect(continuationPolicy(paused)).toMatchObject({ mode: "rpc", canResume: true });
  });

  test("makes missing typed continuation explicit instead of resubmitting prompts", () => {
    const unavailable = GoalStateSchema.parse({
      goal: { ...goal, continuationModes: undefined },
      state: { enabled: true, mode: "active", goal: { ...goal, continuationModes: undefined } },
      source: "rpc",
      sessionSettled: true,
    });
    expect(continuationPolicy(unavailable)).toMatchObject({
      mode: "unavailable",
      canPause: false,
      reason: expect.stringContaining("typed RPC"),
    });
    expect(D8_AP6_CAPABILITIES.loop).toBe("upstream.loop");
    expect(AP6_UNAVAILABLE_REASONS.loop).toContain("not resubmitted");
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

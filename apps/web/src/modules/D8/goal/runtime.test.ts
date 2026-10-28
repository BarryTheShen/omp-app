import type { ChatSessionRequest } from "@omp-app/contracts";
import { ChatSessionEvent, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { notificationEvent } from "@/modules/R0/store/session-events";
import { OmpRuntimeStore } from "../../R0/store";
import type { Goal, GoalModeState, GoalResult, GoalUpdatedEvent } from "../contract";
import { createAutonomyPort } from "./runtime";

const threadId = ThreadId.parse("thread-goal-port");

function makeGoal(): Goal {
  return {
    id: "goal-port",
    objective: "Keep the project healthy",
    status: "active",
    tokensUsed: 12,
    timeUsedSeconds: 5,
    createdAt: 1,
    updatedAt: 2,
  };
}

function modeState(goal: Goal): GoalModeState {
  return { enabled: true, mode: "active", goal };
}

function resultFor(goal: Goal): GoalResult {
  return { goal, state: modeState(goal) };
}

describe("createAutonomyPort", () => {
  test("sends the goal request, forwards validated R0 goal updates and null for unreadable ones", async () => {
    const goal = makeGoal();
    const store = new OmpRuntimeStore({ threadId });
    const sent: unknown[] = [];
    const request = (async (args: { method: string; params: { op: string } }) => {
      sent.push(args);
      if (args.params.op !== "get") throw new Error("Unexpected goal operation in this test.");
      return resultFor(goal);
    }) as unknown as ChatSessionRequest;
    const autonomy = createAutonomyPort({ request, store });

    await expect(autonomy.goal(threadId, { op: "get" })).resolves.toEqual(resultFor(goal));
    expect(sent).toEqual([{ threadId, method: "goal", params: { op: "get" } }]);

    const updates: (GoalUpdatedEvent | null)[] = [];
    const unsubscribe = autonomy.subscribeGoal(threadId, (event) => updates.push(event));
    store.ingest(
      ChatSessionEvent.parse(notificationEvent({ type: "goal_updated", goal: "invalid" })),
      1,
    );
    expect(updates).toEqual([null]);
    store.ingest(
      ChatSessionEvent.parse(
        notificationEvent({ type: "goal_updated", goal, state: modeState(goal) }),
      ),
      2,
    );
    expect(updates).toEqual([null, { type: "goal_updated", goal, state: modeState(goal) }]);
    unsubscribe();
    store.ingest(
      ChatSessionEvent.parse(notificationEvent({ type: "goal_updated", goal: null })),
      3,
    );
    expect(updates).toHaveLength(2);
  });

  test("rejects goal calls made for a different runtime thread", async () => {
    const goal = makeGoal();
    const store = new OmpRuntimeStore({ threadId });
    const request = (async () => resultFor(goal)) as unknown as ChatSessionRequest;
    const autonomy = createAutonomyPort({ request, store });
    const otherThreadId = ThreadId.parse("another-thread");

    await expect(autonomy.goal(otherThreadId, { op: "get" })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
  });
});

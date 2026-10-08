import type { SendCommandArgs } from "@omp-app/contracts";
import { RpcSessionEvent, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../R0/store";
import type { Goal, GoalModeState, GoalRpcResult, GoalUpdatedEvent } from "../contract";
import { createAutonomyPort, type GoalRpcSender } from "./runtime";

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

function resultFor(goal: Goal): GoalRpcResult {
  return { goal, state: modeState(goal) };
}

describe("createAutonomyPort", () => {
  test("sends typed goal RPC, forwards validated R0 goal updates and null for unreadable ones", async () => {
    const goal = makeGoal();
    const store = new OmpRuntimeStore({ threadId });
    const sent: SendCommandArgs<"goal">[] = [];
    const rpc: GoalRpcSender = async (args) => {
      sent.push(args);
      if (args.command.op !== "get") throw new Error("Unexpected goal operation in this test.");
      return resultFor(goal);
    };
    const autonomy = createAutonomyPort({ rpc, store });

    await expect(autonomy.goal(threadId, { op: "get" })).resolves.toEqual(resultFor(goal));
    expect(sent).toEqual([{ threadId, command: { type: "goal", op: "get" } }]);

    const updates: (GoalUpdatedEvent | null)[] = [];
    const unsubscribe = autonomy.subscribeGoal(threadId, (event) => updates.push(event));
    store.ingest(
      RpcSessionEvent.parse({
        kind: "notification",
        frame: { type: "goal_updated", goal: "invalid" },
      }),
      1,
    );
    expect(updates).toEqual([null]);
    store.ingest(
      RpcSessionEvent.parse({
        kind: "notification",
        frame: { type: "goal_updated", goal, state: modeState(goal) },
      }),
      2,
    );
    expect(updates).toEqual([null, { type: "goal_updated", goal, state: modeState(goal) }]);
    unsubscribe();
    store.ingest(
      RpcSessionEvent.parse({ kind: "notification", frame: { type: "goal_updated", goal: null } }),
      3,
    );
    expect(updates).toHaveLength(2);
  });

  test("rejects goal calls made for a different runtime thread", async () => {
    const goal = makeGoal();
    const store = new OmpRuntimeStore({ threadId });
    const rpc = async () => resultFor(goal);
    const autonomy = createAutonomyPort({ rpc, store });
    const otherThreadId = ThreadId.parse("another-thread");

    await expect(autonomy.goal(otherThreadId, { op: "get" })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
  });
});

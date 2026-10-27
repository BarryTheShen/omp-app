import { ChatSessionEvent, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { notificationEvent } from "@/modules/R0/store/session-events";
import { OmpRuntimeStore } from "../../R0/store";
import type { GoalModeState } from "../contract";
import { GuidedGoalController } from "./controller";
import { goalSourceOf } from "./goal-source";

const threadId = ThreadId.parse("thread-goal-source");

const activeGoal: GoalModeState = {
  enabled: true,
  mode: "active",
  goal: {
    id: "goal-1",
    objective: "Keep the project healthy",
    status: "active",
    tokensUsed: 1_200,
    timeUsedSeconds: 45,
    createdAt: 1,
    updatedAt: 2,
  },
};

describe("goalSourceOf", () => {
  test("reports no goal before the session has one", () => {
    const store = new OmpRuntimeStore({ threadId });

    expect(goalSourceOf(store).getSnapshot()).toBeNull();
  });

  test("a goal omp reports through goal_updated blocks a new goal in the guided interview", () => {
    const store = new OmpRuntimeStore({ threadId });
    const controller = new GuidedGoalController({
      threadId,
      autonomy: {
        goal: async () => {
          throw new Error("No create is expected in this test.");
        },
        subscribeGoal: () => () => undefined,
      },
      dialogs: {
        open: () => {
          throw new Error("No dialog is expected in this test.");
        },
        confirm: async () => false,
      },
      capabilities: () => ({ "omp.cmd.goal": { state: "available", via: "rpc" } }),
      goal: goalSourceOf(store),
      composer: { read: () => "", write: async () => undefined },
    });

    store.ingest(
      ChatSessionEvent.parse(
        notificationEvent({ type: "goal_updated", goal: activeGoal.goal, state: activeGoal }),
      ),
      1,
    );

    expect(controller.getSnapshot().createReason).toBe(
      "A goal is already active. Drop it before creating another.",
    );
    controller.dispose();
  });
});

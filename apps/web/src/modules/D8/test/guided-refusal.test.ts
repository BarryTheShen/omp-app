import { type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { AutonomyPort, GoalModeState } from "../contract";
import { CREATE_REFUSED_ACTIVE_GOAL } from "../fixtures";
import type { GuidedComposerDraft } from "../guided/composer";
import { GuidedGoalController } from "../guided/controller";

const threadId = ThreadId.parse("thread-d8-refusal");
const available: CapabilityMap = { "omp.cmd.goal": { state: "available", via: "rpc" } };

const activeGoal: GoalModeState = {
  enabled: true,
  mode: "active",
  goal: {
    id: "goal-refusal",
    objective: "Keep the notes current",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  },
};

/** No goal call is made: the refusal shows before any create is sent. */
const autonomy: AutonomyPort = {
  goal: () => Promise.reject(new Error("the refusal test sends no goal call")),
  subscribeGoal: () => () => undefined,
};

const composer: GuidedComposerDraft = {
  read: () => "",
  write: () => Promise.resolve(),
};

describe("the guided interview's create refusal", () => {
  test("while a goal is active, the interview shows omp's own refusal wording", () => {
    const controller = new GuidedGoalController({
      threadId,
      autonomy,
      dialogs: {
        open: () => Promise.reject(new Error("the refusal test opens no dialog")),
        confirm: () => Promise.resolve(false),
      },
      capabilities: () => available,
      goal: { getSnapshot: () => activeGoal, subscribe: () => () => undefined },
      composer,
    });
    expect(controller.getSnapshot().createReason).toBe(CREATE_REFUSED_ACTIVE_GOAL);
    controller.dispose();
  });
});

import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { Goal, GoalRpcArgs, GoalRpcResult } from "@/modules/D8/contract";
import type { PromptIntent } from "@/modules/U2/contract";
import { goalSlashCommand, runSlashRoute } from "./slash-commands";

const goal: Goal = {
  id: "goal-1",
  objective: "Ship the release notes",
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
};
const prompt: PromptIntent = { mode: "prompt", text: "/goal pause", delivery: "new" };

describe("#1261 the /goal app command", () => {
  test("is named goal and takes its text as arguments", () => {
    const command = goalSlashCommand({ sendGoal: async () => ({ goal: null, state: null }) });
    expect(command.name).toBe("goal");
    expect(command.takesArguments).toBe(true);
  });

  test("bare /goal asks omp to read the goal and says what it has", async () => {
    const sendGoal = vi.fn(
      async (_args: GoalRpcArgs): Promise<GoalRpcResult> => ({
        goal: null,
        state: null,
      }),
    );
    const command = goalSlashCommand({ sendGoal });
    await expect(command.run({})).resolves.toEqual({
      message: "No goal is set for this chat.",
    });
    expect(sendGoal).toHaveBeenCalledWith({ op: "get" });
  });

  test("text after /goal sets a goal with that objective", async () => {
    const sendGoal = async (): Promise<GoalRpcResult> => ({ goal, state: null });
    await expect(
      goalSlashCommand({ sendGoal }).run({ args: "Ship the release notes" }),
    ).resolves.toEqual({ message: "Goal set: Ship the release notes. Status: Active." });
  });

  test("budget is refused before omp is asked, with the reason shown", async () => {
    const sendGoal = vi.fn(async (): Promise<GoalRpcResult> => ({ goal: null, state: null }));
    const command = goalSlashCommand({ sendGoal });
    await expect(command.run({ args: "budget 500" })).rejects.toBeInstanceOf(AppFailure);
    await expect(command.run({ args: "budget 500" })).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "Changing a goal's token budget is not in the app yet. Use omp's terminal for it.",
      },
    });
    expect(sendGoal).not.toHaveBeenCalled();
  });

  test("omp's own refusal reaches the person as its message", async () => {
    const sendGoal = async (): Promise<GoalRpcResult> => {
      throw new AppFailure({
        code: "conflict",
        message: "Goal mode is disabled.",
        retryable: false,
      });
    };
    await expect(goalSlashCommand({ sendGoal }).run({ args: "pause" })).rejects.toMatchObject({
      appError: { message: "Goal mode is disabled." },
    });
  });
});

describe("#1261 a routed /goal passes its typed text to the command", () => {
  test("runSlashRoute hands the arguments over and shows what omp now has", async () => {
    const sendGoal = vi.fn(
      async (): Promise<GoalRpcResult> => ({
        goal: { ...goal, status: "paused" },
        state: null,
      }),
    );
    const shown: Array<string | null> = [];
    await runSlashRoute({
      route: { kind: "app", command: goalSlashCommand({ sendGoal }), args: "pause" },
      intent: prompt,
      provider: null,
      showStatus: (text) => shown.push(text),
    });
    expect(sendGoal).toHaveBeenCalledWith({ op: "pause" });
    expect(shown).toEqual([null, "Goal paused: Ship the release notes. Status: Paused."]);
  });

  test("a bare route runs with no arguments, as it did before", async () => {
    const run = vi.fn(async () => ({}));
    const command = { name: "new", description: "Start a new chat", run };
    await runSlashRoute({
      route: { kind: "app", command },
      intent: prompt,
      provider: null,
      showStatus: () => undefined,
    });
    expect(run).toHaveBeenCalledWith({});
  });
});

import { type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Goal, GoalRpcResult } from "@/modules/D8/contract";
import type { GoalRpcSender } from "@/modules/D8/goal/runtime";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { useGoalCommands } from "./use-goal-command";

const threadId = ThreadId.parse("thread-goal-hook");
const available: CapabilityMap = { "omp.cmd.goal": { state: "available", via: "rpc" } };
const goal: Goal = {
  id: "goal-hook",
  objective: "Ship the release notes",
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
};

function resultFor(next: Goal | null): GoalRpcResult {
  return { goal: next, state: null };
}

/** Renders the goal commands for `chat` while the page shows `threadId`, with the header's two lines as spies. */
function renderGoals(options: {
  readonly send: GoalRpcSender;
  readonly capabilities?: CapabilityMap;
  readonly chat?: ThreadId;
}) {
  const store = new OmpRuntimeStore({ threadId });
  const notify = vi.fn<(text: string | null) => void>();
  const fail = vi.fn<(text: string | null) => void>();
  const { result } = renderHook(() =>
    useGoalCommands({
      capabilities: options.capabilities ?? available,
      rpc: { send: options.send },
      store,
      threadId: options.chat ?? threadId,
      notify,
      fail,
    }),
  );
  return { goals: result.current, notify, fail };
}

describe("#1261 the goal commands send through the chat on screen", () => {
  test("a palette goal command sends one goal request and reports what omp now has", async () => {
    const send = vi.fn<GoalRpcSender>(async () => resultFor({ ...goal, status: "paused" }));
    const { goals, notify, fail } = renderGoals({ send });

    goals.runFromPalette("pause");

    await vi.waitFor(() =>
      expect(notify).toHaveBeenLastCalledWith(
        "Goal paused: Ship the release notes. Status: Paused.",
      ),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({ threadId, command: { type: "goal", op: "pause" } });
    expect(fail).toHaveBeenLastCalledWith(null);
  });

  test("the typed /goal command runs through the same request and returns its message", async () => {
    const send = vi.fn<GoalRpcSender>(async () => resultFor(goal));
    const { goals } = renderGoals({ send });

    await expect(goals.command.run({ args: "Ship the release notes" })).resolves.toEqual({
      message: "Goal set: Ship the release notes. Status: Active.",
    });
    expect(send.mock.calls[0]?.[0]).toEqual({
      threadId,
      command: { type: "goal", op: "create", objective: "Ship the release notes" },
    });
  });

  test("a chat whose omp has no goal command is refused before anything is sent", async () => {
    const send = vi.fn<GoalRpcSender>(async () => resultFor(goal));
    const { goals, fail } = renderGoals({ send, capabilities: {} });

    goals.runFromPalette("");

    await vi.waitFor(() =>
      expect(fail).toHaveBeenLastCalledWith("Goals are unavailable in this omp session."),
    );
    expect(send).not.toHaveBeenCalled();
  });

  test("a request for a chat that is no longer on screen is refused, not sent to the new one", async () => {
    const send = vi.fn<GoalRpcSender>(async () => resultFor(goal));
    const { goals, fail } = renderGoals({ send, chat: ThreadId.parse("thread-goal-old") });

    goals.runFromPalette("drop");

    await vi.waitFor(() =>
      expect(fail).toHaveBeenLastCalledWith(
        "The selected conversation changed before the goal request could run.",
      ),
    );
    expect(send).not.toHaveBeenCalled();
  });

  test("a reply the app cannot read is a plain failure, never a goal", async () => {
    const send = vi.fn<GoalRpcSender>(
      async () => ({ unexpected: true }) as unknown as GoalRpcResult,
    );
    const { goals, notify, fail } = renderGoals({ send });

    goals.runFromPalette("");

    await vi.waitFor(() =>
      expect(fail).toHaveBeenLastCalledWith("The goal could not be changed. Try again."),
    );
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/^Goal/));
  });
});

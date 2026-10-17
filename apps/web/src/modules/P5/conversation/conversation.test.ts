import type { ConversationHead } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { BranchRequest, ConversationBranchResult } from "@/modules/P4/contract";
import { conversationForRestore, createConversationRestoreCoordinator } from "./conversation";

const current: ConversationHead = {
  threadId: "thread-current" as ConversationHead["threadId"],
  sessionFile: "/tmp/current.jsonl" as ConversationHead["sessionFile"],
  entryId: "entry-current" as ConversationHead["entryId"],
};
const checkpoint: ConversationHead = {
  threadId: current.threadId,
  sessionFile: current.sessionFile,
  entryId: "entry-checkpoint" as ConversationHead["entryId"],
};

function branchResult(overrides: Partial<ConversationBranchResult> = {}): ConversationBranchResult {
  return {
    sourceThreadId: current.threadId,
    threadId: "thread-rewound" as ConversationHead["threadId"],
    entryId: checkpoint.entryId,
    sessionFile: "/tmp/rewound.jsonl" as ConversationHead["sessionFile"],
    cancelled: false,
    reloaded: true,
    sourceRetained: true,
    wording: "conversation rewind",
    ...overrides,
  };
}

describe("ConversationRestoreCoordinator", () => {
  test("maps both restore operations through P4 and returns the reloaded head", async () => {
    const branch = vi.fn(async () => branchResult());
    const coordinator = createConversationRestoreCoordinator({ branch });

    const result = await coordinator.restore({
      operation: "both",
      current,
      target: checkpoint,
    });

    expect(branch).toHaveBeenCalledWith({
      threadId: current.threadId,
      entryId: checkpoint.entryId,
      signal: undefined,
    });
    expect(result).toEqual({
      operation: "both",
      previous: current,
      current: {
        threadId: "thread-rewound",
        sessionFile: "/tmp/rewound.jsonl",
        entryId: checkpoint.entryId,
      },
      restored: true,
      reloaded: true,
      sourceRetained: true,
      wording: "conversation rewind",
    });
  });

  test("reports a cancelled transition without claiming that the head changed", async () => {
    const branch = vi.fn(async () =>
      branchResult({
        threadId: current.threadId,
        sessionFile: current.sessionFile,
        entryId: checkpoint.entryId,
        cancelled: true,
        reloaded: false,
      }),
    );
    const coordinator = createConversationRestoreCoordinator({ branch });

    const result = await coordinator.restore({
      operation: "conversation-only",
      current,
      target: checkpoint,
    });

    expect(result.operation).toBe("conversation-only");
    expect(result.restored).toBe(false);
    expect(result.previous).toEqual(current);
    expect(result.current).toEqual(current);
    expect(result.reloaded).toBe(false);
  });

  test("rejects a checkpoint from another thread before calling P4", async () => {
    const branch = vi.fn();
    const coordinator = createConversationRestoreCoordinator({ branch });
    const other = { ...checkpoint, threadId: "other-thread" as ConversationHead["threadId"] };

    await expect(
      coordinator.restore({ operation: "conversation-only", current, target: other }),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(branch).not.toHaveBeenCalled();
  });

  test("rejects a checkpoint that names no entry before calling P4", async () => {
    const branch = vi.fn();
    const coordinator = createConversationRestoreCoordinator({ branch });
    const noEntry = { ...checkpoint, entryId: null };

    await expect(
      coordinator.restore({ operation: "both", current, target: noEntry }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(branch).not.toHaveBeenCalled();
  });

  test("hands the caller's abort signal to P4, so cancelling a restore reaches the transition", async () => {
    const branch = vi.fn(async (_request: BranchRequest) => branchResult());
    const coordinator = createConversationRestoreCoordinator({ branch });
    const controller = new AbortController();

    await coordinator.restore({
      operation: "conversation-only",
      current,
      target: checkpoint,
      signal: controller.signal,
    });

    expect(branch.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  test("keeps files-only restores on the current conversation", () => {
    expect(conversationForRestore("files-only", current, null)).toEqual(current);
    expect(conversationForRestore("files-only", current, checkpoint)).toEqual(current);
  });

  test("requires a target head for a conversation-axis restore", () => {
    expect(() => conversationForRestore("both", current, null)).toThrow(AppFailure);
    expect(() => conversationForRestore("conversation-only", current, null)).toThrow(
      /requires a checkpoint conversation head/,
    );
  });
});

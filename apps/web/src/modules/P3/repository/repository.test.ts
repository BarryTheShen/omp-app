import type { ThreadMessageLike } from "@assistant-ui/react";
import { AppFailure, type ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { BranchRepositoryItem } from "../contract";
import { type BranchHeadStorage, createBranchRepository } from ".";

const threadId = "p3-thread" as ThreadId;

function message(id: string, text: string): ThreadMessageLike {
  return {
    role: "assistant",
    id,
    content: [{ type: "text", text }],
    metadata: { custom: {} },
  };
}

function storage(): BranchHeadStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

const branchItems: readonly BranchRepositoryItem<ThreadMessageLike>[] = [
  { message: message("child", "child"), parentId: "root" },
  { message: message("root", "root"), parentId: null },
  { message: message("sibling", "sibling"), parentId: "root" },
];

describe("P3 assistant-ui branch repository", () => {
  test("imports parents before children and exports assistant-ui head data", () => {
    const repository = createBranchRepository({
      threadId,
      items: branchItems,
      headId: "child",
      switchBranch: async (headId) => ({ threadId, headId, items: branchItems }),
    });
    expect(repository.snapshot().items.map((item) => item.message.id)).toEqual([
      "root",
      "child",
      "sibling",
    ]);
    expect(repository.exported()).toMatchObject({
      headId: "child",
      messages: [
        { parentId: null, message: { id: "root" } },
        { parentId: "root", message: { id: "child" } },
        { parentId: "root", message: { id: "sibling" } },
      ],
    });
  });

  test("persists the selected head after the R0.4 branch callback", async () => {
    const persisted = storage();
    const switchCalls: string[] = [];
    const first = createBranchRepository({
      threadId,
      items: branchItems,
      storage: persisted,
      switchBranch: async (headId) => {
        switchCalls.push(headId);
        return { threadId, headId, items: branchItems };
      },
    });
    await first.switchHead("sibling");
    const second = createBranchRepository({
      threadId,
      items: branchItems,
      storage: persisted,
      switchBranch: async (headId) => ({ threadId, headId, items: branchItems }),
    });
    expect(switchCalls).toEqual(["sibling"]);
    expect(second.snapshot().headId).toBe("sibling");
    await second.persistHead(null);
    expect(second.snapshot().headId).toBeNull();
    expect(persisted.values.size).toBe(1);
  });

  test("rejects missing/orphaned heads and supports authoritative refetch", async () => {
    expect(() =>
      createBranchRepository({ threadId, items: branchItems, headId: "missing" }),
    ).toThrow(AppFailure);
    expect(() =>
      createBranchRepository({
        threadId,
        items: [{ message: message("orphan", "orphan"), parentId: "missing" }],
      }),
    ).toThrow(AppFailure);

    let calls = 0;
    const repository = createBranchRepository({
      threadId,
      items: branchItems,
      refetch: async () => {
        calls += 1;
        return { threadId, headId: "sibling", items: branchItems };
      },
    });
    await repository.refetch();
    expect(calls).toBe(1);
    expect(repository.snapshot().headId).toBe("sibling");
  });
});

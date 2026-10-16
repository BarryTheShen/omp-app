import type { ThreadMessageLike } from "@assistant-ui/react";
import { AppFailure, type ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { BranchRepositoryItem } from "../contract";
import { type BranchHeadStorage, createBranchRepository } from ".";
import { HEAD_KEY_PREFIX } from "./repository";

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

  test("persists the selected head with no omp command, and a reload reads it back", async () => {
    const persisted = storage();
    const first = createBranchRepository({
      threadId,
      items: branchItems,
      headId: "child",
      storage: persisted,
    });
    await first.switchHead("sibling");
    expect(first.snapshot().headId).toBe("sibling");
    expect(persisted.values.get(`${HEAD_KEY_PREFIX}${threadId}`)).toBe("sibling");

    const second = createBranchRepository({
      threadId,
      items: branchItems,
      headId: "child",
      storage: persisted,
    });
    expect(second.snapshot().headId).toBe("sibling");
    await second.persistHead(null);
    expect(second.snapshot().headId).toBeNull();
    expect(persisted.values.size).toBe(1);
  });

  test("a head switch never needs omp: it moves the visible head, and a head the repository lacks is refused", async () => {
    const repository = createBranchRepository({
      threadId,
      items: branchItems,
      headId: "child",
      storage: storage(),
    });

    await repository.switchHead("sibling");
    expect(repository.snapshot().headId).toBe("sibling");

    await expect(repository.switchHead("missing")).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    expect(repository.snapshot().headId).toBe("sibling");
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

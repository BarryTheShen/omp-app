import type { EntryId, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  asEditFailure,
  BranchMessageSchema,
  type BranchRepositoryItem,
  type BranchRepositoryPort,
  type EditRunPort,
  EditRunResultSchema,
  EditSourceSchema,
  P3_INVENTORY_COVERS,
  type ReloadRunPort,
} from ".";

const threadId = "thread-p3" as ThreadId;
const entryId = "entry-user" as EntryId;

const source = {
  threadId,
  entryId,
  parentId: null,
  originalText: "original",
  originalImages: [{ type: "image", data: "bytes", mimeType: "image/png" }],
  sourceHeadId: "aui-head",
};

describe("P3 edit/reload contracts", () => {
  test("validates EditSource, result guarantees and branch-message identity", () => {
    expect(EditSourceSchema.parse(source)).toMatchObject({ entryId, originalText: "original" });
    expect(EditSourceSchema.safeParse({ ...source, entryId: "" }).success).toBe(false);
    expect(
      EditRunResultSchema.parse({
        threadId,
        admitted: true,
        settled: false,
        workspaceGuarantee: "not-managed",
        externalChanges: [],
      }),
    ).toMatchObject({ admitted: true, workspaceGuarantee: "not-managed" });
    expect(BranchMessageSchema.parse({ entryId, text: "pick me" })).toEqual({
      entryId,
      text: "pick me",
    });
  });

  test("keeps repository parent/head topology typed without importing React", () => {
    const item: BranchRepositoryItem<{ readonly id: string }> = {
      message: { id: "message-1" },
      parentId: null,
    };
    const repository: BranchRepositoryPort<{ readonly id: string }> = {
      snapshot: () => ({ threadId, headId: "message-1", items: [item] }),
      switchHead: async () => ({ threadId, headId: "message-1", items: [item] }),
      persistHead: async () => {},
      refetch: async () => ({ threadId, headId: "message-1", items: [item] }),
    };
    expect(repository.snapshot()).toMatchObject({ threadId, headId: "message-1" });
  });

  test("normalizes plain cross-layer errors into AppFailure and preserves typed failures", () => {
    const typed = new AppFailure({ code: "conflict", message: "stale head", retryable: true });
    expect(asEditFailure(typed)).toBe(typed);
    expect(asEditFailure(new Error("failed edit"))).toMatchObject({
      appError: { code: "internal", message: "failed edit", retryable: true },
    });
  });

  test("covers exactly the two P3 inventory rows and leaves durable tree rows out", () => {
    expect(P3_INVENTORY_COVERS).toEqual([
      "P3.branch-message-selector",
      "P3.branch-summary-divider",
    ]);
    expect(P3_INVENTORY_COVERS).not.toContain("P3.get-tree");
    const editPort: EditRunPort = {
      edit: async () => ({ threadId, admitted: true, settled: true }),
    };
    const reloadPort: ReloadRunPort = {
      reload: async () => ({ threadId, admitted: true, settled: true }),
    };
    expect(editPort).toBeDefined();
    expect(reloadPort).toBeDefined();
  });
});

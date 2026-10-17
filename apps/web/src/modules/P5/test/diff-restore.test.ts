import { FolderPath, RestorePlan, SnapshotId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { toRestorePlanView } from "../contract";
import { createDiffViewModel } from "../diff";
import { createRestorePlanViewModel } from "../restore";

const workspace = FolderPath.parse("/workspace");
const conversation = { threadId: ThreadId.parse("p5-thread"), sessionFile: null, entryId: null };
function restorePlan(operation: "files-only" | "conversation-only") {
  return toRestorePlanView(
    RestorePlan.parse({
      planId: `plan-${operation}`,
      workspace,
      operation,
      snapshotId: SnapshotId.parse("snapshot-1"),
      currentConversation: conversation,
      targetConversation: null,
      currentWorkspaceHash: "current",
      targetWorkspaceHash: "target",
      includedPaths: [{ path: "src/app.ts", kind: "file" }],
      excludedPaths: [],
      externalChanges: [],
      capturedPathCount: 1,
      snapshotGuarantee: "boundary",
      destructive: true,
      requiresConfirmation: true,
    }),
  );
}

describe("P5 diff and restore UI models", () => {
  test("summarizes changed, external and excluded paths", () => {
    const model = createDiffViewModel({
      snapshotId: SnapshotId.parse("snapshot-1"),
      workspace,
      entries: [
        {
          path: "src/app.ts",
          change: "modified",
          beforeHash: "a",
          afterHash: "b",
          beforeMode: 0o644,
          afterMode: 0o644,
        },
      ],
      excludedPaths: [{ path: ".git", reason: "protected" }],
      externalChanges: [
        { path: "README.md", change: "modified", expectedHash: "a", actualHash: "b" },
      ],
      currentWorkspaceHash: "current",
      snapshotWorkspaceHash: "snapshot",
    });
    expect(model).toMatchObject({
      changedCount: 1,
      externalCount: 1,
      excludedCount: 1,
      summary: "1 changed path",
    });
  });

  test("keeps conversation rewind wording and requires confirmation", () => {
    const model = createRestorePlanViewModel(restorePlan("conversation-only"), {});
    expect(model).toMatchObject({
      operation: "conversation-only",
      requiresConfirmation: true,
      guarantee: "boundary",
      pathCount: 1,
    });
  });

  test("does not claim exact restore without the upstream capability", () => {
    expect(() =>
      createRestorePlanViewModel({ ...restorePlan("files-only"), workspaceGuarantee: "exact" }, {}),
    ).toThrow();
  });
});

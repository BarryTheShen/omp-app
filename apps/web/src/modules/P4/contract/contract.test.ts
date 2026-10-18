import type { EntryId, ThreadId } from "@omp-app/contracts";
import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  CONVERSATION_FORK_LABEL,
  CONVERSATION_REWIND_LABEL,
  EntryCursorSchema,
  P4_DESCRIPTORS,
  ReadOnlyTreeLabelSchema,
  TREE_LABEL_CAPABILITY,
  TreeNodeSchema,
  TreeSelectorFilterSchema,
  TreeSnapshotSchema,
} from ".";

const threadId = "thread-p4" as ThreadId;
const rootId = "entry-root" as EntryId;
const childId = "entry-child" as EntryId;

const entry = (id: EntryId, parentId: EntryId | null): Record<string, unknown> => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-05T00:00:00.000Z",
  message: { role: "user", content: "message", timestamp: 1 },
  futureField: { retained: true },
});

describe("P4 entry/tree contracts", () => {
  test("validates cursors, open tree nodes, unknown fields and leaf identity", () => {
    const cursor = EntryCursorSchema.parse({
      threadId,
      entries: [entry(rootId, null), entry(childId, rootId)],
      leafId: childId,
      nextSince: childId,
    });
    expect(cursor.entries).toHaveLength(2);
    expect(TreeNodeSchema.parse({ entry: entry(rootId, null), children: [] })).toMatchObject({
      entry: { id: rootId },
    });
    expect(
      TreeSnapshotSchema.parse({
        threadId,
        sessionFile: null,
        tree: [{ entry: entry(rootId, null), children: [] }],
        leafId: rootId,
        labels: [],
        labelsCapability: "unavailable",
      }).leafId,
    ).toBe(rootId);
  });

  test("keeps label display read-only and gates mutation on the future capability", () => {
    const label = ReadOnlyTreeLabelSchema.parse({
      targetId: rootId,
      text: "checkpoint",
      editable: false,
      disabledReason: "Labels are read-only at the omp release floor",
    });
    expect(label.editable).toBe(false);
    expect(TREE_LABEL_CAPABILITY).toBe("upstream.session-labels");
    expect(TreeSelectorFilterSchema.parse({}).showLabels).toBe(true);
  });
});

describe("P4 descriptor boundary", () => {
  test("covers the nine durable-tree rows and registers tree chords without duplicate ids", () => {
    expect(P4_DESCRIPTORS).toHaveLength(14);
    expect(P4_DESCRIPTORS.flatMap((descriptor) => descriptor.covers).sort()).toEqual([
      "P3.app-session-tree",
      "P3.app-tree-foldorup",
      "P3.app-tree-unfoldordown",
      "P3.branch",
      "P3.fork",
      "P3.get-entries",
      "P3.get-tree",
      "P3.tree",
      "P3.tree-selector",
    ]);
    expect(
      P4_DESCRIPTORS.flatMap((descriptor) =>
        descriptor.kind === "shortcut" &&
        [
          "P4.treeFoldOrUpCtrl",
          "P4.treeFoldOrUpAlt",
          "P4.treeUnfoldOrDownCtrl",
          "P4.treeUnfoldOrDownAlt",
        ].includes(descriptor.id)
          ? [descriptor.chord]
          : [],
      ),
    ).toEqual(["Ctrl+ArrowLeft", "Alt+ArrowLeft", "Ctrl+ArrowRight", "Alt+ArrowRight"]);
    expect(P4_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).not.toContain(
      "P3.branch-message-selector",
    );
  });

  test("passes C0 validation and uses conversation wording, not workspace restore", () => {
    expect(validateRegistry(P4_DESCRIPTORS)).toEqual([]);
    expect(P4_DESCRIPTORS.find((descriptor) => descriptor.id === "P4.branch")?.title).toBe(
      CONVERSATION_REWIND_LABEL.replace("conversation ", "Conversation "),
    );
    expect(P4_DESCRIPTORS.find((descriptor) => descriptor.id === "P4.fork")?.title).toBe(
      CONVERSATION_FORK_LABEL.replace("conversation ", "Conversation "),
    );
    expect(P4_DESCRIPTORS.map((descriptor) => descriptor.title)).not.toContain("Workspace restore");
  });
});

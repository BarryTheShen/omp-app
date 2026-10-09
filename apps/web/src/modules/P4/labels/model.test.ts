import { EntryId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ReadOnlyTreeLabel, TreeNode, TreeSnapshot } from "../contract";
import { LABELS_READ_ONLY_NOTICE } from "../selector/tree-selector-model";
import { createP4LabelsViewModel } from "./model";

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const WRITTEN = "2026-10-06T07:00:00.000Z";

function label(target: string, text: string | null): ReadOnlyTreeLabel {
  return {
    targetId: EntryId.parse(target),
    text,
    editable: false,
    disabledReason: "Labels can't be changed here.",
  };
}

function entry(id: string, timestamp: string): TreeNode {
  return {
    entry: { type: "message", id: EntryId.parse(id), parentId: null, timestamp },
    children: [],
  };
}

function snapshot(
  labels: readonly ReadOnlyTreeLabel[],
  tree: readonly TreeNode[],
  labelsCapability: TreeSnapshot["labelsCapability"],
): Pick<TreeSnapshot, "labels" | "labelsCapability" | "tree"> {
  return { labels, labelsCapability, tree };
}

describe("P4 read-only label model", () => {
  test("lists each label by its text and the time of the entry it marks, and drops a clear", () => {
    const model = createP4LabelsViewModel(
      snapshot(
        [label("entry-checkpoint", "Review checkpoint"), label("entry-cleared", null)],
        [entry("entry-checkpoint", WRITTEN), entry("entry-cleared", WRITTEN)],
        "unavailable",
      ),
    );

    expect(model.items).toEqual([
      {
        key: "entry-checkpoint",
        title: "Review checkpoint",
        detail: `Entry from ${WHEN.format(new Date(WRITTEN))}`,
      },
    ]);
  });

  test("gives no second line when the entry a label marks is not loaded", () => {
    const model = createP4LabelsViewModel(
      snapshot([label("entry-missing", "Not loaded")], [], "unavailable"),
    );

    expect(model.items).toEqual([{ key: "entry-missing", title: "Not loaded", detail: null }]);
  });

  test("counts labels in the words the app uses, and says so when there are none", () => {
    const one = createP4LabelsViewModel(
      snapshot([label("entry-one", "One")], [entry("entry-one", WRITTEN)], "unavailable"),
    );
    const two = createP4LabelsViewModel(
      snapshot(
        [label("entry-one", "One"), label("entry-two", "Two")],
        [entry("entry-one", WRITTEN), entry("entry-two", WRITTEN)],
        "unavailable",
      ),
    );
    const none = createP4LabelsViewModel(snapshot([], [], "unavailable"));

    expect(one.summary).toBe("1 label");
    expect(two.summary).toBe("2 labels");
    expect(none).toEqual({
      items: [],
      summary: null,
      emptyMessage: "No labels yet.",
      editDisabledReason: LABELS_READ_ONLY_NOTICE,
    });
  });

  test("states omp's terminal as the reason while the capability is unavailable, and the app's own reason otherwise", () => {
    const unavailable = createP4LabelsViewModel(snapshot([], [], "unavailable"));
    const available = createP4LabelsViewModel(snapshot([], [], "available"));

    expect(unavailable.editDisabledReason).toBe(
      "Labels can only be changed in omp's terminal for now.",
    );
    expect(available.editDisabledReason).toBe("Labels are read-only in this app.");
  });
});

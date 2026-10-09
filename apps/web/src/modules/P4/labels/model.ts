import type { EntryId } from "@omp-app/contracts";
import type { ReadOnlyTreeLabel, TreeNode, TreeSnapshot } from "../contract";
import { LABELS_READ_ONLY_NOTICE } from "../selector/tree-selector-model";

export interface P4LabelItemViewModel {
  readonly key: EntryId;
  readonly title: string;
  /** When the labelled entry was written, so rows with the same text tell apart. Null if the entry is not loaded. */
  readonly detail: string | null;
}

export interface P4LabelsViewModel {
  readonly items: readonly P4LabelItemViewModel[];
  readonly summary: string | null;
  readonly emptyMessage: string | null;
  readonly editDisabledReason: string;
}

const WHEN_WRITTEN = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The timestamps of the loaded entries, by id. A stack walks the tree, so a long chat cannot overflow the call stack. */
function entryTimestamps(tree: readonly TreeNode[]): Map<string, string> {
  const timestamps = new Map<string, string>();
  const pending = [...tree];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    timestamps.set(node.entry.id, node.entry.timestamp);
    pending.push(...node.children);
  }
  return timestamps;
}

function whenWritten(timestamp: string | undefined): string | null {
  if (timestamp === undefined) return null;
  const when = new Date(timestamp);
  return Number.isNaN(when.getTime()) ? null : WHEN_WRITTEN.format(when);
}

export function createP4LabelsViewModel(
  snapshot: Pick<TreeSnapshot, "labels" | "labelsCapability" | "tree">,
): P4LabelsViewModel {
  const timestamps = entryTimestamps(snapshot.tree);
  const items = snapshot.labels.flatMap((label: ReadOnlyTreeLabel) => {
    // A label without text is a clear: omp keeps no label to list.
    if (label.text === null || label.text.trim() === "") return [];
    const when = whenWritten(timestamps.get(label.targetId));
    return [
      {
        key: label.targetId,
        title: label.text,
        detail: when === null ? null : `Entry from ${when}`,
      },
    ];
  });
  const count = items.length;
  const summary = count === 0 ? null : count === 1 ? "1 label" : `${count} labels`;
  const editDisabledReason =
    snapshot.labelsCapability === "unavailable"
      ? LABELS_READ_ONLY_NOTICE
      : "Labels are read-only in this app.";

  return {
    items,
    summary,
    emptyMessage: count === 0 ? "No labels yet." : null,
    editDisabledReason,
  };
}

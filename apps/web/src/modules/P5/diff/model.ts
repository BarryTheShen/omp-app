import type { CheckpointDiff } from "../contract";

export type DiffViewModel = {
  readonly changedCount: number;
  readonly externalCount: number;
  readonly excludedCount: number;
  readonly summary: string;
  readonly entries: readonly {
    readonly path: string;
    readonly change: string;
  }[];
  readonly externalChanges: readonly {
    readonly path: string;
    readonly change: string;
  }[];
  readonly excludedPaths: CheckpointDiff["excludedPaths"];
};

const CHANGE_LABELS = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  "mode-changed": "Permissions changed",
} as const;

export function createDiffViewModel(diff: CheckpointDiff): DiffViewModel {
  const changedCount = diff.entries.length;
  const externalCount = diff.externalChanges.length;
  const excludedCount = diff.excludedPaths.length;
  const noun = changedCount === 1 ? "path" : "paths";
  return {
    changedCount,
    externalCount,
    excludedCount,
    summary: `${changedCount} changed ${noun}`,
    entries: diff.entries.map((entry) => ({
      path: entry.path,
      change: CHANGE_LABELS[entry.change],
    })),
    externalChanges: diff.externalChanges.map((change) => ({
      path: change.path,
      change: CHANGE_LABELS[change.change],
    })),
    excludedPaths: diff.excludedPaths,
  };
}

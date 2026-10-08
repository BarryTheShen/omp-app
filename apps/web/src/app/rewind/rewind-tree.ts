import type { AppError, CapabilityMap, EntryId, SessionEntryHead } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { TreeNode } from "@/modules/P4/contract";
import type { OmpRuntimeStore } from "@/modules/R0/store";

/** What the rewind tree needs from omp: the session tree, and the branch command that rewinds. */
export const REWIND_CAPABILITIES = ["omp.cmd.get_tree", "omp.cmd.branch"] as const;

/** The panel, its palette command and its chord are offered only while omp has both commands. */
export function rewindAvailable(capabilities: CapabilityMap): boolean {
  return REWIND_CAPABILITIES.every((key) => capabilities[key]?.state === "available");
}

/** The entry with this id. Iterative: a conversation can be thousands of entries deep. */
export function treeEntry(
  nodes: readonly TreeNode[],
  entryId: EntryId,
): SessionEntryHead | undefined {
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.entry.id === entryId) return node.entry;
    for (const child of node.children) pending.push(child);
  }
  return undefined;
}

/** omp branches from a user message only; any other entry is refused by omp, so it is refused here first. */
export function isUserMessage(entry: SessionEntryHead): boolean {
  const message: unknown = entry.message;
  return (
    typeof message === "object" && message !== null && "role" in message && message.role === "user"
  );
}

export function isStreaming(store: OmpRuntimeStore): boolean {
  return Object.keys(store.getSnapshot().streaming).length > 0;
}

export function transcriptEntryCount(store: OmpRuntimeStore): number {
  return Object.keys(store.getSnapshot().transcript.entries).length;
}

/** The sentence a failed rewind shows: omp's words when the app has them, never a stack trace. */
export function rewindFailureMessage(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  return "The conversation could not be rewound. Try again.";
}

/** The error a failed tree read reports to the panel. */
export function treeLoadError(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return { code: "internal", message: "Conversation history couldn't be loaded.", retryable: true };
}

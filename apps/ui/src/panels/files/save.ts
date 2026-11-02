import type { FileHash, FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";
import { baseName, childPath, conflictCopyName, parentOf } from "./names";
import { type FilesClient, failureCode, readFileBytes, uploadBytes } from "./transfer";

/**
 * Saving an open text file (#2782): a save carries the hash the file had when it was opened, so a file changed on disk
 * since then is never overwritten silently; the conflict is the person's to settle.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SaveResult =
  | { readonly kind: "saved"; readonly hash: FileHash }
  /** The file changed on disk since it was opened (or is there now, when it was not). */
  | { readonly kind: "conflict" };

/** Saves `text`; `expectedHash` null for a file that must not exist yet (one deleted on disk meanwhile). */
export async function saveText(
  files: FilesClient,
  folder: FolderPath,
  path: WorkspaceRelativePath,
  text: string,
  expectedHash: FileHash | null,
): Promise<SaveResult> {
  try {
    return {
      kind: "saved",
      hash: await uploadBytes(files, folder, path, encoder.encode(text), { expectedHash }),
    };
  } catch (failure) {
    if (failureCode(failure) === "conflict") return { kind: "conflict" };
    throw failure;
  }
}

/** The four ways out of "This file changed since you opened it". */
export type ConflictChoice = "compare" | "overwrite" | "copy" | "discard";

export type ConflictOutcome =
  /** Overwrite: the person's text is on disk now. */
  | { readonly kind: "overwritten"; readonly hash: FileHash }
  /** Save as copy: the person's text went to a copy beside it; the open file is the disk's again. */
  | {
      readonly kind: "copied";
      readonly copy: WorkspaceRelativePath;
      readonly diskText: string;
      readonly diskHash: FileHash | null;
    }
  /** Discard mine: the disk's text replaces the person's. */
  | { readonly kind: "discarded"; readonly diskText: string; readonly diskHash: FileHash | null }
  /** Compare: the disk's text and hash, for a merge saved against that hash. */
  | { readonly kind: "compare"; readonly diskText: string; readonly diskHash: FileHash | null };

/** The disk's text and hash now; empty and null when the file is gone. */
async function disk(
  files: FilesClient,
  folder: FolderPath,
  path: WorkspaceRelativePath,
): Promise<{ diskText: string; diskHash: FileHash | null }> {
  try {
    const { hash } = await files.stat({ folder, path });
    const { bytes } = await readFileBytes(files, folder, path);
    return { diskText: decoder.decode(bytes), diskHash: hash };
  } catch (failure) {
    if (failureCode(failure) === "not_found") return { diskText: "", diskHash: null };
    throw failure;
  }
}

export async function resolveConflict(
  choice: ConflictChoice,
  files: FilesClient,
  folder: FolderPath,
  path: WorkspaceRelativePath,
  mine: string,
  now: Date = new Date(),
): Promise<ConflictOutcome> {
  switch (choice) {
    case "overwrite": {
      const hash = await uploadBytes(files, folder, path, encoder.encode(mine));
      return { kind: "overwritten", hash };
    }
    case "copy": {
      const copy = childPath(
        parentOf(path),
        conflictCopyName(baseName(path), now),
      ) as WorkspaceRelativePath;
      await uploadBytes(files, folder, copy, encoder.encode(mine), { expectedHash: null });
      return { kind: "copied", copy, ...(await disk(files, folder, path)) };
    }
    case "discard":
      return { kind: "discarded", ...(await disk(files, folder, path)) };
    case "compare":
      return { kind: "compare", ...(await disk(files, folder, path)) };
  }
}

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type FolderPath,
  MAX_LIST_ENTRIES,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceFileReadArgs,
  type WorkspaceFileReadResult,
  type WorkspaceListArgs,
  type WorkspaceListResult,
  type WorkspaceRelativePath,
  type WorkspaceStatResult,
} from "@omp-app/contracts";
import { WALK_SKIPPED_NAMES } from "../file-search/search";
import { isAtomicWriteArtifact } from "../fs/atomic-file";
import { mediaTypeOf, UNKNOWN_MEDIA_TYPE } from "./media";
import { folderItself, folderRoot, followInside, invalidFailure, linkTargetInside } from "./paths";

/** Files up to this size get a sha256 in `stat`; a bigger one is never edited in the panel. */
export const MAX_HASHED_BYTES = 50 * 1024 * 1024;
const HASH_READ_BYTES = 1024 * 1024;
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function kindOf(info: Stats): WorkspaceEntryKind {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

/**
 * A directory's entries: directories first, then by name as people sort them; ignored names only when asked for, and
 * with `match` only the names that hold it, whatever its case.
 */
export async function listEntries(
  args: WorkspaceListArgs,
  limit = MAX_LIST_ENTRIES,
): Promise<WorkspaceListResult> {
  const root = await folderRoot(args.folder);
  const directory =
    args.path === undefined ? await folderItself(root) : await followInside(root, args.path);
  if (!directory.info.isDirectory()) throw invalidFailure(`${args.path} is not a directory.`);
  const match = args.match?.toLocaleLowerCase();
  const entries: WorkspaceEntry[] = [];
  for (const name of await readdir(directory.real)) {
    // A save in progress writes its temp and lock files beside the file: they are not the person's.
    if (isAtomicWriteArtifact(name)) continue;
    if (match !== undefined && !name.toLocaleLowerCase().includes(match)) continue;
    const ignored = WALK_SKIPPED_NAMES.has(name);
    if (ignored && !args.showIgnored) continue;
    const at = join(directory.real, name);
    let info: Stats;
    try {
      info = await lstat(at);
    } catch {
      // Gone since the directory was read.
      continue;
    }
    const kind = kindOf(info);
    const entry: WorkspaceEntry = {
      name,
      kind,
      size: kind === "file" ? info.size : 0,
      modifiedMs: info.mtimeMs,
      ignored,
    };
    entries.push(
      kind === "symlink"
        ? { ...entry, targetInside: (await linkTargetInside(root, at)) !== null }
        : entry,
    );
  }
  entries.sort(
    (left, right) =>
      Number(left.kind !== "directory") - Number(right.kind !== "directory") ||
      COLLATOR.compare(left.name, right.name),
  );
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
    total: entries.length,
  };
}

/**
 * Opens a regular file for reading without waiting on it: a FIFO put in its place since it was checked opens at once
 * (`O_NONBLOCK`) and is refused here, where a plain open would wait for a writer.
 */
async function openFile(real: string, path: string): Promise<{ handle: FileHandle; info: Stats }> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw invalidFailure(`${path} is not a file.`);
  }
  return { handle, info };
}

async function hashOpen(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(HASH_READ_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/** A file's sha256 in hex, read without waiting on a FIFO. */
export async function hashFile(real: string, path: string): Promise<string> {
  const { handle } = await openFile(real, path);
  try {
    return await hashOpen(handle);
  } finally {
    await handle.close();
  }
}

export async function statPath(args: {
  readonly folder: FolderPath;
  readonly path: WorkspaceRelativePath;
}): Promise<WorkspaceStatResult> {
  const root = await folderRoot(args.folder);
  const at = await followInside(root, args.path);
  const kind = kindOf(at.info);
  if (kind !== "file") {
    return {
      kind,
      size: 0,
      modifiedMs: at.info.mtimeMs,
      hash: null,
      mediaType: kind === "directory" ? "inode/directory" : UNKNOWN_MEDIA_TYPE,
    };
  }
  const hash = at.info.size <= MAX_HASHED_BYTES ? await hashFile(at.real, args.path) : null;
  return {
    kind,
    size: at.info.size,
    modifiedMs: at.info.mtimeMs,
    hash,
    mediaType: mediaTypeOf(basename(args.path)),
  };
}

/** Up to `length` bytes from `offset`, with the file's size and time as it was read. */
export async function readChunk(args: WorkspaceFileReadArgs): Promise<WorkspaceFileReadResult> {
  const root = await folderRoot(args.folder);
  const at = await followInside(root, args.path);
  if (!at.info.isFile()) throw invalidFailure(`${args.path} is not a file.`);
  const { handle, info } = await openFile(at.real, args.path);
  try {
    const length = Math.max(0, Math.min(args.length, info.size - args.offset));
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, args.offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return {
      bytes: buffer.subarray(0, read).toString("base64"),
      size: info.size,
      modifiedMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

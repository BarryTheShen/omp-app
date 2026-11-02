import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { WorkspaceRelativePath } from "./file-search";

/**
 * The Files panel's port (#2782): a chat folder's files, listed, read, written and watched over the app's socket, so a
 * laptop or a phone sees the files its chats work in. No HTTP route serves them: both sign-in paths cover this, and
 * nothing is reachable without signing in. Every path is relative to the call's folder; the server keeps every one
 * inside it (`permission` otherwise).
 */

/** One app frame is 1 MiB: file bytes cross in chunks of at most 512 KiB, base64. */
export const MAX_FILE_CHUNK_BYTES = 512 * 1024;
/** A directory lists at most this many entries; `truncated` says there were more. */
export const MAX_LIST_ENTRIES = 5000;
/** A connection watches at most this many paths: the expanded directories and the open file. */
export const MAX_WATCHED_PATHS = 64;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** At most one chunk's bytes, base64. */
export const FileChunkBytes = z
  .string()
  .max(Math.ceil(MAX_FILE_CHUNK_BYTES / 3) * 4)
  .regex(BASE64, "bytes must be base64");
export type FileChunkBytes = z.infer<typeof FileChunkBytes>;

/** A file's sha256, lowercase hex. */
export const FileHash = z.string().regex(/^[0-9a-f]{64}$/, "hash must be a sha256 in hex");
export type FileHash = z.infer<typeof FileHash>;

/** An upload's or a trashed item's id, given by the server. */
export const WorkspaceFilesId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export type WorkspaceFilesId = z.infer<typeof WorkspaceFilesId>;

/** A watched path: a path in the folder, or `""` for the folder itself. */
export const WatchedPath = z.union([z.literal(""), WorkspaceRelativePath]);
export type WatchedPath = z.infer<typeof WatchedPath>;

export const WorkspaceEntryKind = z.enum(["file", "directory", "symlink", "other"]);
export type WorkspaceEntryKind = z.infer<typeof WorkspaceEntryKind>;

/** One entry of a directory. */
export const WorkspaceEntry = z.strictObject({
  /** The entry's own name: one path segment. */
  name: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (name) => !/[\\/\0]/.test(name) && name !== "." && name !== "..",
      "name must be one path segment",
    ),
  kind: WorkspaceEntryKind,
  size: z.int().nonnegative(),
  modifiedMs: z.number().finite().nonnegative(),
  /** A name a walk skips (`.git`, `node_modules`, caches): left out of a list unless it asks for them. */
  ignored: z.boolean(),
  /** A symlink's target is inside the folder: then it is read, listed and stated through. Symlinks only. */
  targetInside: z.boolean().optional(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

export const WorkspaceListArgs = z.strictObject({
  folder: FolderPath,
  /** The directory listed; none is the folder itself. */
  path: WorkspaceRelativePath.optional(),
  showIgnored: z.boolean(),
});
export type WorkspaceListArgs = z.infer<typeof WorkspaceListArgs>;

export const WorkspaceListResult = z.strictObject({
  /** Directories first, then by name as people sort them. */
  entries: z.array(WorkspaceEntry).max(MAX_LIST_ENTRIES),
  truncated: z.boolean(),
});
export type WorkspaceListResult = z.infer<typeof WorkspaceListResult>;

const PathArgs = z.strictObject({ folder: FolderPath, path: WorkspaceRelativePath });

export const WorkspaceStatResult = z.strictObject({
  kind: WorkspaceEntryKind,
  size: z.int().nonnegative(),
  modifiedMs: z.number().finite().nonnegative(),
  /** The file's sha256, for files up to 50 MiB; null otherwise. */
  hash: FileHash.nullable(),
  /** From the name's extension; `application/octet-stream` when unknown. */
  mediaType: z.string().min(1).max(255),
});
export type WorkspaceStatResult = z.infer<typeof WorkspaceStatResult>;

export const WorkspaceFileReadArgs = z.strictObject({
  folder: FolderPath,
  path: WorkspaceRelativePath,
  offset: z.int().nonnegative(),
  length: z.int().min(1).max(MAX_FILE_CHUNK_BYTES),
});
export type WorkspaceFileReadArgs = z.infer<typeof WorkspaceFileReadArgs>;

export const WorkspaceFileReadResult = z.strictObject({
  bytes: FileChunkBytes,
  /** The file's size and time when this chunk was read: a reader starts over when they change between chunks. */
  size: z.int().nonnegative(),
  modifiedMs: z.number().finite().nonnegative(),
});
export type WorkspaceFileReadResult = z.infer<typeof WorkspaceFileReadResult>;

export const WorkspaceBeginWriteArgs = z.strictObject({
  folder: FolderPath,
  path: WorkspaceRelativePath,
  /**
   * A hash: the file must still have it when the write commits. `null`: nothing may be there yet. Left out: the file is
   * overwritten whatever it holds, only after the person chose Overwrite.
   */
  expectedHash: FileHash.nullable().optional(),
});
export type WorkspaceBeginWriteArgs = z.infer<typeof WorkspaceBeginWriteArgs>;

export const WorkspaceWriteChunkArgs = z.strictObject({
  uploadId: WorkspaceFilesId,
  /** Where this chunk starts: chunks come in order, each where the last one ended. */
  offset: z.int().nonnegative(),
  bytes: FileChunkBytes,
});
export type WorkspaceWriteChunkArgs = z.infer<typeof WorkspaceWriteChunkArgs>;

export const WorkspaceMoveArgs = z.strictObject({
  folder: FolderPath,
  from: WorkspaceRelativePath,
  to: WorkspaceRelativePath,
});
export type WorkspaceMoveArgs = z.infer<typeof WorkspaceMoveArgs>;

export const WorkspaceWatchArgs = z.strictObject({
  folder: FolderPath,
  /** Replaces this connection's watched paths; ends with the connection. */
  paths: z.array(WatchedPath).max(MAX_WATCHED_PATHS),
});
export type WorkspaceWatchArgs = z.infer<typeof WorkspaceWatchArgs>;

/** Something in a watched path changed on disk, by anyone. */
export const WorkspaceFileChanged = z.strictObject({
  folder: FolderPath,
  path: WorkspaceRelativePath,
  change: z.enum(["created", "modified", "deleted"]),
});
export type WorkspaceFileChanged = z.infer<typeof WorkspaceFileChanged>;

const EMPTY = z.strictObject({});
const CAPABILITY = "host.workspace-files";

export const WorkspaceFilesPort = definePort({
  name: "A1.workspaceFiles",
  methods: {
    list: { args: WorkspaceListArgs, result: WorkspaceListResult, capability: CAPABILITY },
    stat: { args: PathArgs, result: WorkspaceStatResult, capability: CAPABILITY },
    read: { args: WorkspaceFileReadArgs, result: WorkspaceFileReadResult, capability: CAPABILITY },
    beginWrite: {
      args: WorkspaceBeginWriteArgs,
      result: z.strictObject({ uploadId: WorkspaceFilesId }),
      capability: CAPABILITY,
    },
    writeChunk: {
      args: WorkspaceWriteChunkArgs,
      result: z.strictObject({ received: z.int().nonnegative() }),
      capability: CAPABILITY,
    },
    commit: {
      args: z.strictObject({ uploadId: WorkspaceFilesId }),
      result: z.strictObject({ hash: FileHash }),
      capability: CAPABILITY,
    },
    createDirectory: { args: PathArgs, result: EMPTY, capability: CAPABILITY },
    move: { args: WorkspaceMoveArgs, result: EMPTY, capability: CAPABILITY },
    trash: {
      args: PathArgs,
      result: z.strictObject({ trashId: WorkspaceFilesId }),
      capability: CAPABILITY,
    },
    restore: {
      args: z.strictObject({ trashId: WorkspaceFilesId }),
      result: z.strictObject({ folder: FolderPath, path: WorkspaceRelativePath }),
      capability: CAPABILITY,
    },
    watch: { args: WorkspaceWatchArgs, result: EMPTY, capability: CAPABILITY },
  },
  events: {
    changed: { payload: WorkspaceFileChanged, capability: CAPABILITY },
  },
});

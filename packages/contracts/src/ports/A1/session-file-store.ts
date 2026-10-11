import { z } from "zod";
import { definePort } from "../../core/envelope";
import { EntryId, FolderPath, SessionFilePath, ThreadId } from "../../core/ids";
import { Cursor, Timestamp } from "./shared";

export const SessionStatus = z.enum([
  "complete",
  "interrupted",
  "aborted",
  "error",
  "pending",
  "unknown",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Liveness is explicit about the difference between omp's lease and this server's process. */
export const SessionLiveness = z.strictObject({
  lease: z.enum(["held", "free", "unknown"]),
  serverProcess: z.boolean(),
});
export type SessionLiveness = z.infer<typeof SessionLiveness>;

/**
 * Whether this server's omp is inside a turn on the chat. Absent when this server runs no omp for the chat, so a
 * chat open in another omp (a terminal) has no turn state here.
 */
export const SessionTurn = z.enum(["running", "idle"]);
export type SessionTurn = z.infer<typeof SessionTurn>;

/** How a worker ended, read from its own transcript: `unknown` when the file records no end. */
export const SubagentFinalStatus = z.enum(["completed", "failed", "aborted", "unknown"]);
export type SubagentFinalStatus = z.infer<typeof SubagentFinalStatus>;

/** A discovered child transcript; entries stay in the session-file port, not the browser. */
export const SubagentTranscript = z.strictObject({
  key: z.string().min(1),
  agentId: z.string().min(1),
  parent: z.string().min(1).nullable(),
  sessionFile: SessionFilePath,
  leafId: z.string().min(1).nullable(),
  entryCount: z.int().nonnegative(),
  aborted: z.boolean(),
  /** The end state the transcript records; `unknown` while it records none (the worker may still run). */
  status: SubagentFinalStatus,
  /** When the transcript or its abort marker was last written; null while the status is `unknown`. */
  endedAt: Timestamp.nullable(),
  /** The agent type omp recorded when the worker started; null when the file does not record one. */
  agent: z.string().min(1).nullable(),
});
export type SubagentTranscript = z.infer<typeof SubagentTranscript>;

/** Header and bounded listing metadata from an omp JSONL session. */
export const SessionFile = z.strictObject({
  id: ThreadId,
  sessionFile: SessionFilePath,
  version: z.int().min(1).max(3).nullable(),
  title: z.string().nullable(),
  /** The first user message, trimmed to one line of at most 120 characters, for untitled sessions. */
  firstPrompt: z.string().nullable(),
  cwd: FolderPath,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  parentSession: SessionFilePath.nullable(),
  messageCount: z.int().nonnegative(),
  assistantTurns: z.int().nonnegative(),
  sizeBytes: z.int().nonnegative(),
  status: SessionStatus,
  liveness: SessionLiveness,
  turn: SessionTurn.optional(),
  subagents: z.array(SubagentTranscript),
  /** Non-fatal issues found while tolerantly reading a v3 (or older) file. */
  parseWarnings: z.array(z.string().min(1)),
});
export type SessionFile = z.infer<typeof SessionFile>;

export const SessionListArgs = z.strictObject({
  folder: FolderPath,
  cursor: Cursor.optional(),
  limit: z.int().min(1).max(100).optional(),
});
export type SessionListArgs = z.infer<typeof SessionListArgs>;

export const SessionListResult = z.strictObject({
  sessions: z.array(SessionFile),
  nextCursor: Cursor.nullable(),
});
export type SessionListResult = z.infer<typeof SessionListResult>;

export const SessionFolderListArgs = z.strictObject({
  cursor: Cursor.optional(),
  limit: z.int().min(1).max(100).optional(),
});
export type SessionFolderListArgs = z.infer<typeof SessionFolderListArgs>;

export const SessionFolderListResult = z.strictObject({
  folders: z.array(FolderPath),
  nextCursor: Cursor.nullable(),
});
export type SessionFolderListResult = z.infer<typeof SessionFolderListResult>;

export const SessionReadArgs = z.strictObject({ sessionFile: SessionFilePath });
export type SessionReadArgs = z.infer<typeof SessionReadArgs>;

export const SessionSubagentsResult = z.strictObject({
  sessionFile: SessionFilePath,
  transcripts: z.array(SubagentTranscript),
});
export type SessionSubagentsResult = z.infer<typeof SessionSubagentsResult>;

/** Arguments of `readSubagent`: one transcript the session's listing names, read from a byte cursor. */
export const SubagentReadArgs = z.strictObject({
  sessionFile: SessionFilePath,
  fromByte: z.int().nonnegative().optional(),
});
export type SubagentReadArgs = z.infer<typeof SubagentReadArgs>;

/** One page of a subagent transcript, shaped like omp's `get_subagent_messages` result. */
export const SubagentReadResult = z.strictObject({
  sessionFile: SessionFilePath,
  fromByte: z.int().nonnegative(),
  nextByte: z.int().nonnegative(),
  reset: z.boolean(),
  entries: z.array(z.record(z.string(), z.unknown())),
  messages: z.array(z.record(z.string(), z.unknown())),
});
export type SubagentReadResult = z.infer<typeof SubagentReadResult>;
/** The newest entries of one branch, read from the session file (omp's stream sends all of them). */
export const SessionEntryWindowArgs = z.strictObject({
  sessionFile: SessionFilePath,
  /** The leaf to walk from (omp's leaf from `get_entries`). Omit it to walk from the file's last entry. */
  leafId: EntryId.optional(),
  /** Only entries strictly older than this one on the same branch: the next window back. */
  before: EntryId.optional(),
  /** The budget for the serialized entries, in bytes: 4 MB by default, 8 MB at most. */
  byteBudget: z.int().min(1024).max(8_388_608).optional(),
});
export type SessionEntryWindowArgs = z.infer<typeof SessionEntryWindowArgs>;

export const SessionEntryWindow = z.strictObject({
  sessionFile: SessionFilePath,
  /** The leaf the window walked from, and the file's last entry (for omp's `since` check). */
  leafId: EntryId.nullable(),
  fileLastId: EntryId.nullable(),
  /** Raw session entries of this branch, oldest first. A tool output over the cut limit is shortened and marked `outputCut`. */
  entries: z.array(z.record(z.string(), z.unknown())),
  /** Pass as `before` for the next older window; null when this window is empty. */
  oldestId: EntryId.nullable(),
  hasOlder: z.boolean(),
});
export type SessionEntryWindow = z.infer<typeof SessionEntryWindow>;

export const SessionEntryOutputArgs = z.strictObject({
  sessionFile: SessionFilePath,
  entryId: EntryId,
});
export type SessionEntryOutputArgs = z.infer<typeof SessionEntryOutputArgs>;

/** The whole entry as omp wrote it, with no output cut: what "Load full output" shows. */
export const SessionEntryOutputResult = z.strictObject({
  entry: z.record(z.string(), z.unknown()),
});
export type SessionEntryOutputResult = z.infer<typeof SessionEntryOutputResult>;

export const SessionFileChanged = z.strictObject({
  folder: FolderPath,
  sessionFile: SessionFilePath,
  id: ThreadId,
  kind: z.enum(["created", "updated", "removed"]),
});
export type SessionFileChanged = z.infer<typeof SessionFileChanged>;

/**
 * Deletes one chat: its session file and the artifacts directory beside it. `folder` is the chat's folder, and only a
 * file that this folder's listing returns can be deleted. The server refuses (conflict) a chat omp holds or runs a turn
 * in, so close the chat first.
 */
export const SessionDeleteArgs = z.strictObject({
  folder: FolderPath,
  sessionFile: SessionFilePath,
});
export type SessionDeleteArgs = z.infer<typeof SessionDeleteArgs>;

export const SessionDeleteResult = z.strictObject({
  id: ThreadId,
  sessionFile: SessionFilePath,
  removed: z.literal(true),
});
export type SessionDeleteResult = z.infer<typeof SessionDeleteResult>;

export const SessionFileStore = definePort({
  name: "A1.sessionFileStore",
  methods: {
    listSessions: {
      args: SessionListArgs,
      result: SessionListResult,
      capability: "host.session-files",
    },
    listFolders: {
      args: SessionFolderListArgs,
      result: SessionFolderListResult,
      capability: "host.session-files",
    },
    readSession: {
      args: SessionReadArgs,
      result: SessionFile,
      capability: "host.session-files",
    },
    listSubagents: {
      args: SessionReadArgs,
      result: SessionSubagentsResult,
      capability: "host.session-files",
    },
    readSubagent: {
      args: SubagentReadArgs,
      result: SubagentReadResult,
      capability: "host.session-files",
    },
    readEntryWindow: {
      args: SessionEntryWindowArgs,
      result: SessionEntryWindow,
      capability: "host.session-files",
    },
    readEntryOutput: {
      args: SessionEntryOutputArgs,
      result: SessionEntryOutputResult,
      capability: "host.session-files",
    },
    deleteSession: {
      args: SessionDeleteArgs,
      result: SessionDeleteResult,
      capability: "host.session-files",
    },
  },
  events: {
    changed: {
      payload: SessionFileChanged,
      capability: "host.session-files",
    },
  },
});

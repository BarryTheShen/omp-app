import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath, SessionFilePath, ThreadId } from "../../core/ids";
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

export const SessionFileChanged = z.strictObject({
  folder: FolderPath,
  sessionFile: SessionFilePath,
  id: ThreadId,
  kind: z.enum(["created", "updated", "removed"]),
});
export type SessionFileChanged = z.infer<typeof SessionFileChanged>;

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
  },
  events: {
    changed: {
      payload: SessionFileChanged,
      capability: "host.session-files",
    },
  },
});

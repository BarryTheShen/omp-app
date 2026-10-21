/** Read-only metadata exposed by the omp session-file adapter. */

import type { SessionSummary } from "./summary";

export type SessionTitleSource = "auto" | "user";

export interface SessionTitleSlot {
  readonly type: "title";
  readonly v: 1;
  readonly title: string;
  readonly source?: SessionTitleSource;
  readonly updatedAt: string;
  readonly pad: string;
}

/** The v1-v3 header shape written as the first logical JSONL record by omp. */
export interface SessionHeader {
  readonly type: "session";
  readonly version?: number;
  readonly id: string;
  readonly title?: string;
  readonly titleSource?: SessionTitleSource;
  readonly timestamp?: string;
  readonly cwd: string;
  readonly parentSession?: string;
  readonly [key: string]: unknown;
}

export type SessionEntry = Record<string, unknown>;

export type ParseWarningCode =
  | "malformed_line"
  | "invalid_header"
  | "header_not_first"
  | "read_error"
  | "subagent_read_error";

/** Safe diagnostics: the raw line is deliberately not returned. */
export interface ParseWarning {
  readonly code: ParseWarningCode;
  readonly message: string;
  readonly line?: number;
  readonly sessionFile?: string;
  readonly partial?: boolean;
}

export interface ParsedSession {
  readonly header?: SessionHeader;
  readonly titleSlot?: SessionTitleSlot;
  /** Logical records, including the session header and unknown record types. */
  readonly entries: readonly unknown[];
  readonly malformedRecords: number;
  readonly partialLine: boolean;
  readonly unknownEntryTypes: readonly string[];
  readonly parseWarnings: readonly ParseWarning[];
}

export type SessionLeaseState = "held" | "free" | "unknown";

export interface SessionLiveness {
  /** `held` means another process owns omp's session lease. */
  readonly lease: SessionLeaseState;
  /** True when this server reports a process for the session. */
  readonly serverProcess: boolean;
}

/** The turn state of a chat this server runs omp for: a turn is running, or the session is idle. */
export type SessionTurn = "running" | "idle";

export type SessionStatus =
  | "complete"
  | "interrupted"
  | "aborted"
  | "error"
  | "pending"
  | "unknown";

export type SubagentFinalStatus = "completed" | "failed" | "aborted" | "stopped" | "unknown";

export type RecordedWorkerStatus = "completed" | "failed" | "aborted";

export interface SubagentTranscript {
  readonly key: string;
  readonly agentId: string;
  readonly parent: string | null;
  readonly sessionFile: string;
  readonly path: string;
  readonly id?: string;
  readonly header?: SessionHeader;
  readonly entryCount: number;
  readonly leafId: string | null;
  readonly aborted: boolean;
  /** How the worker ended, from its own records; see `finalStatusOf` in `subagents.ts`. */
  readonly status: SubagentFinalStatus;
  /** When the transcript, or its abort marker, was last written; null while the status is unknown. */
  readonly endedAt: string | null;
  /** The agent type from the worker's `session_init` record; null when the file records none. */
  readonly agent: string | null;
  /** Why a failed worker failed: the failure its last assistant message keeps, without omp's saved-request path. */
  readonly reason?: string;
  /** The outcome omp recorded for the worker in its parent's session (its `<task-result status>`); absent when none is recorded. */
  readonly recordedStatus?: RecordedWorkerStatus;
  readonly parseWarnings: readonly ParseWarning[];
}

/** The exact file metadata consumed by A1.1's SessionFileStore port. */
export interface SessionFile {
  readonly id: string;
  readonly sessionFile: string;
  readonly version: number;
  readonly title?: string;
  /** The first user message, trimmed to one line of at most 120 characters, for untitled sessions. */
  readonly firstPrompt: string | null;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSession?: string;
  readonly messageCount: number;
  readonly assistantTurns: number;
  readonly sizeBytes: number;
  readonly status: SessionStatus;
  readonly liveness: SessionLiveness;
  /** A turn of this server's omp on the chat; absent when this server runs no omp for the chat. */
  readonly turn?: SessionTurn;
  /** Nested transcripts are empty in readSession; use listSubagents to load them. */
  readonly subagents: readonly SubagentTranscript[];
  readonly parseWarnings: readonly ParseWarning[];
}

/** Backwards-compatible local name for the listing object. */
export type SessionListing = SessionFile;

export interface SessionFolder {
  readonly bucket: string;
  readonly sessionDir: string;
  readonly sessionCount: number;
}

export interface ListSessionsArgs {
  /** Absolute project cwd. Omit to scan every bucket for direct callers. */
  readonly folder?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionListResult {
  readonly sessions: readonly SessionFile[];
  readonly nextCursor: string | null;
  readonly parseWarnings: readonly ParseWarning[];
  /** On a folder's first page: the chats this server runs a turn for that have no session file yet (their ids). */
  readonly running: readonly string[];
}

export interface ListFoldersArgs {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionFoldersResult {
  readonly folders: readonly string[];
  readonly nextCursor: string | null;
}

export interface ReadSessionArgs {
  readonly sessionFile: string;
}

export interface SubagentListResult {
  readonly sessionFile: string;
  readonly transcripts: readonly SubagentTranscript[];
}

export type LeaseProbeResult = "active" | "inactive" | "unknown" | boolean | null | (() => void);

/**
 * Optional bridge to omp's native owner lease. A1 cannot import omp's native
 * module, so the running-server adapter supplies this probe when available.
 * A probe should acquire and immediately release a free lease; `null` means
 * another process currently owns it.
 */
export interface SessionLeaseProbe {
  (sessionId: string, sessionFile: string): LeaseProbeResult | Promise<LeaseProbeResult>;
  /** Returns a probe that shares one lease-table read across one session listing. */
  forListing?(): SessionLeaseProbe;
}

export interface SessionFileStoreOptions {
  /** Defaults to omp's resolved `~/.omp/agent/sessions` equivalent. */
  readonly sessionsRoot?: string;
  /** Overrides home only for bucket classification and deterministic tests. */
  readonly home?: string;
  /** Overrides the temporary root only for bucket classification and tests. */
  readonly tempRoot?: string;
  /** Optional native lease bridge; omitted liveness is `unknown`. */
  readonly leaseProbe?: SessionLeaseProbe;
  /** State-directory path made available to a native lease bridge. */
  readonly ownersRoot?: string;
  readonly serverSessionIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
  readonly serverOwnsSession?: (sessionId: string, sessionFile: string) => boolean;
  /** Whether this server's process registry is currently stopping the chat's omp. */
  readonly serverStopping?: (sessionId: string) => boolean;
  /** Whether a view holds the chat open. A chat the server keeps only for omp's idle time is not watched. */
  readonly serverWatches?: (sessionId: string) => boolean;
  /**
   * Stops this server's omp for the chat when nobody but `ownViews` watches it and no turn runs, and resolves once it has
   * stopped. A delete passes the views of the connection asking: they stay counted while the stop runs, and omp's exit
   * takes them with it. It rejects when the stop fails or does not finish in time: the delete then removes nothing,
   * because omp may still write the file.
   */
  readonly stopUnwatched?: (sessionId: string, ownViews: number) => Promise<void>;
  /** The turn state of the chat's omp on this server; `undefined` when this server runs no omp for the chat. */
  readonly turnOf?: (sessionId: string) => SessionTurn | undefined;
  /**
   * The views the server's connections hold on its chats, and how many views hold each chat together. A delete that names
   * the connection asking checks the turn and the other views first; omp's exit then takes that connection's views with
   * it (see `SessionFileStore.deleteSession`).
   */
  readonly views?: SessionViews;
  /** The chats this server runs a turn for in a folder. A chat with no session file yet is listed from these. */
  readonly runningIn?: (folder: string) => readonly string[];
  /**
   * The app data folder. The listing keeps its summary cache in it (`session-summaries.json`, mode 0600), so a restart
   * reads a chat again only when the chat changed. Without it the cache lives in memory and a restart reads every chat.
   */
  readonly appDataDir?: string;
  /**
   * Reads a chat's summary for a listing and for a background refresh. The store's streaming reader unless a test replaces it,
   * to hold or fail a read at a known point.
   */
  readonly summarizeFile?: (sessionFile: string) => Promise<SessionSummary>;
}

/** The views on the server's chats, as the app port counts them. */
export interface SessionViews {
  /** How many views the connection holds on the chat. */
  viewsOf(sessionId: string, connectionId: string): number;
  /** How many views every connection holds on the chat together. */
  watcherCount(sessionId: string): number;
  /** Lets go of every view the connection holds on the chat. */
  releaseViews(sessionId: string, connectionId: string): Promise<void>;
  /**
   * Gives the connection back the views a delete's stop took from it, when the delete is refused and another tab's omp
   * serves the chat: `count` less what it holds on the chat now.
   */
  restoreViews?(sessionId: string, connectionId: string, count: number): void;
}

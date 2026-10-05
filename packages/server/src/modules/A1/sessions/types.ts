/** Read-only metadata exposed by the omp session-file adapter. */

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

export type SessionStatus =
  | "complete"
  | "interrupted"
  | "aborted"
  | "error"
  | "pending"
  | "unknown";

export interface SubagentTranscript {
  readonly key: string;
  readonly agentId: string;
  readonly parent: string | null;
  readonly sessionFile: string;
  readonly path: string;
  readonly id?: string;
  readonly header?: SessionHeader;
  readonly entries: readonly unknown[];
  readonly leafId: string | null;
  readonly aborted: boolean;
  readonly parseWarnings: readonly ParseWarning[];
}

/** The exact file metadata consumed by A1.1's SessionFileStore port. */
export interface SessionFile {
  readonly id: string;
  readonly sessionFile: string;
  readonly version: number;
  readonly title?: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSession?: string;
  readonly messageCount: number;
  readonly assistantTurns: number;
  readonly sizeBytes: number;
  readonly status: SessionStatus;
  readonly liveness: SessionLiveness;
  readonly subagents: readonly SubagentTranscript[];
  readonly parseWarnings: readonly ParseWarning[];
  /** Full logical records are available to direct store callers. */
  readonly entries: readonly unknown[];
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
export type SessionLeaseProbe = (
  sessionId: string,
  sessionFile: string,
) => LeaseProbeResult | Promise<LeaseProbeResult>;

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
}

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AppFailure } from "@omp-app/contracts";
import { detectSessionLiveness } from "./liveness";
import { isJsonObject, parseSessionContent } from "./parser";
import {
  defaultSessionOwnersRoot,
  defaultSessionsRoot,
  sessionBucketName,
  sessionBucketPath,
} from "./paths";
import { collectSubagentTranscripts } from "./subagents";
import type {
  ListFoldersArgs,
  ListSessionsArgs,
  ParseWarning,
  ReadSessionArgs,
  SessionFile,
  SessionFileStoreOptions,
  SessionFolder,
  SessionFoldersResult,
  SessionHeader,
  SessionLeaseState,
  SessionListing,
  SessionListResult,
  SessionStatus,
  SubagentListResult,
} from "./types";

interface SessionFileStat {
  readonly size: number;
  readonly mtimeIso: string;
}

export interface SessionReadOutcome {
  readonly file?: SessionFile;
  readonly parseWarnings: readonly ParseWarning[];
  readonly missing: boolean;
}

function appFailure(
  code: "invalid_args" | "not_found" | "permission" | "internal",
  message: string,
  retryable: boolean,
  cause?: unknown,
): AppFailure {
  const appError = { code, message, retryable } as const;
  return cause === undefined ? new AppFailure(appError) : new AppFailure(appError, { cause });
}

function fileErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = error.code;
  return typeof value === "string" ? value : undefined;
}

function isMissing(error: unknown): boolean {
  const code = fileErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function normalizeSessionFile(value: string): string {
  return path.resolve(value);
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw appFailure("invalid_args", "Invalid session-list cursor", false);
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset))
    throw appFailure("invalid_args", "Invalid session-list cursor", false);
  return offset;
}

function parseLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw appFailure("invalid_args", "Session-list limit must be a positive integer", false);
  }
  return limit;
}

function warningForReadFailure(sessionFile: string, error: unknown): ParseWarning {
  const code = fileErrorCode(error);
  return {
    code: "read_error",
    message:
      code === "EACCES"
        ? "Permission denied while reading session file"
        : "Unable to read session file",
    sessionFile,
  };
}

function serverOwnsSession(
  options: SessionFileStoreOptions,
  sessionId: string,
  sessionFile: string,
): boolean {
  if (options.serverOwnsSession?.(sessionId, sessionFile)) return true;
  const ids =
    typeof options.serverSessionIds === "function"
      ? options.serverSessionIds()
      : options.serverSessionIds;
  return ids?.has(sessionId) ?? false;
}

function statusFromEntries(entries: readonly unknown[]): SessionStatus {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isJsonObject(entry) || entry.type !== "message" || !isJsonObject(entry.message)) continue;
    const message = entry.message;
    switch (message.role) {
      case "assistant": {
        if (message.stopReason === "error") return "error";
        if (message.stopReason === "aborted") return "aborted";
        if (message.stopReason === "length") return "interrupted";
        if (
          Array.isArray(message.content) &&
          message.content.some((content) => isJsonObject(content) && content.type === "toolCall")
        ) {
          return "interrupted";
        }
        return "complete";
      }
      case "toolResult":
        return "interrupted";
      case "user":
        return "pending";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

function messageCounts(entries: readonly unknown[]): {
  messageCount: number;
  assistantTurns: number;
} {
  let messageCount = 0;
  let assistantTurns = 0;
  for (const entry of entries) {
    if (!isJsonObject(entry) || entry.type !== "message") continue;
    messageCount++;
    if (isJsonObject(entry.message) && entry.message.role === "assistant") assistantTurns++;
  }
  return { messageCount, assistantTurns };
}

function sortListings(listings: SessionListing[]): void {
  listings.sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt);
    const leftTime = Date.parse(left.updatedAt);
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.sessionFile.localeCompare(right.sessionFile);
  });
}

/**
 * Read-only access to omp's native session JSONL files. This class never
 * creates buckets, migrates legacy names, writes transcripts or mutates any
 * artifact beside a session file.
 */
export class SessionFileStore {
  readonly sessionsRoot: string;
  readonly ownersRoot: string;
  readonly #options: SessionFileStoreOptions;

  constructor(options: SessionFileStoreOptions = {}) {
    this.#options = options;
    this.sessionsRoot = path.resolve(
      options.sessionsRoot ?? defaultSessionsRoot({ home: options.home }),
    );
    this.ownersRoot = path.resolve(options.ownersRoot ?? defaultSessionOwnersRoot(options.home));
  }

  /** Apply omp's exact cwd-to-bucket rule without touching the filesystem. */
  bucketName(folder: string): string {
    return sessionBucketName(folder, this.#options);
  }

  /** Return the bucket path for a cwd, whether or not it exists yet. */
  bucketPath(folder: string): string {
    return sessionBucketPath(folder, this.sessionsRoot, this.#options);
  }

  /** Low-level bucket inventory; unlike `listFolders`, names are omp buckets. */
  async listBucketFolders(): Promise<readonly SessionFolder[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw appFailure("permission", "Unable to read omp session folders", true, error);
    }

    const folders: SessionFolder[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(this.sessionsRoot, entry.name);
      let files: Dirent[];
      try {
        files = await fs.readdir(sessionDir, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw appFailure("permission", "Unable to read an omp session folder", true, error);
      }
      const sessionCount = files.filter(
        (file) => file.isFile() && file.name.endsWith(".jsonl") && !file.name.includes(".bak"),
      ).length;
      folders.push({ bucket: entry.name, sessionDir, sessionCount });
    }
    folders.sort((left, right) => left.bucket.localeCompare(right.bucket));
    return folders;
  }

  /** List distinct cwd values represented by session headers for the port. */
  async listFolders(args: ListFoldersArgs = {}): Promise<SessionFoldersResult> {
    const listings = await this.listSessions();
    const folders = [
      ...new Set(listings.sessions.map((session) => session.cwd).filter((cwd) => cwd.length > 0)),
    ].sort();
    const limit = parseLimit(args.limit);
    const offset = parseCursor(args.cursor);
    const selected =
      limit === undefined ? folders.slice(offset) : folders.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return {
      folders: selected,
      nextCursor: nextOffset < folders.length ? String(nextOffset) : null,
    };
  }

  /** Port-friendly listing, with numeric cursors stable over one read. */
  async listSessions(args: ListSessionsArgs = {}): Promise<SessionListResult> {
    const limit = parseLimit(args.limit);
    const offset = parseCursor(args.cursor);
    const parseWarnings: ParseWarning[] = [];
    const sessionDirs = await this.#sessionDirectories(args.folder, parseWarnings);
    const candidateFiles: string[] = [];

    for (const sessionDir of sessionDirs) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(sessionDir, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        parseWarnings.push(warningForReadFailure(sessionDir, error));
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".bak")) {
          candidateFiles.push(path.join(sessionDir, entry.name));
        }
      }
    }

    const outcomes = await Promise.all(candidateFiles.map((file) => this.#readSessionFile(file)));
    const sessions: SessionFile[] = [];
    for (const outcome of outcomes) {
      parseWarnings.push(...outcome.parseWarnings);
      if (outcome.file) sessions.push(outcome.file);
    }
    sortListings(sessions);

    const selected =
      limit === undefined ? sessions.slice(offset) : sessions.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return {
      sessions: selected,
      nextCursor: nextOffset < sessions.length ? String(nextOffset) : null,
      parseWarnings,
    };
  }

  /** Read one session file and its nested transcript tree. */
  async readSession(args: ReadSessionArgs | string): Promise<SessionFile> {
    const sessionFile = normalizeSessionFile(typeof args === "string" ? args : args.sessionFile);
    const outcome = await this.#readSessionFile(sessionFile);
    if (outcome.file) return outcome.file;
    if (outcome.missing) throw appFailure("not_found", "Session file was not found", false);
    if (outcome.parseWarnings.some((warning) => warning.code === "read_error")) {
      throw appFailure("permission", "Unable to read omp session file", true);
    }
    throw appFailure("invalid_args", "Session file has no valid session header", false);
  }

  /** Alias used by direct store callers. */
  async getSession(args: ReadSessionArgs | string): Promise<SessionFile> {
    return this.readSession(args);
  }

  /** Read only nested subagent transcripts beside one parent session. */
  async listSubagents(args: ReadSessionArgs | string): Promise<SubagentListResult> {
    const sessionFile = normalizeSessionFile(typeof args === "string" ? args : args.sessionFile);
    try {
      await fs.stat(sessionFile);
    } catch (error) {
      if (isMissing(error)) throw appFailure("not_found", "Session file was not found", false);
      throw appFailure("permission", "Unable to read omp session file", true, error);
    }
    const collection = await collectSubagentTranscripts(sessionFile);
    return { sessionFile, transcripts: collection.subagents };
  }

  /** Lower-level helper useful to tests and adapters that need parse diagnostics. */
  async readSessionWithWarnings(args: ReadSessionArgs | string): Promise<SessionReadOutcome> {
    const sessionFile = normalizeSessionFile(typeof args === "string" ? args : args.sessionFile);
    return this.#readSessionFile(sessionFile);
  }

  async #sessionDirectories(
    folder: string | undefined,
    parseWarnings: ParseWarning[],
  ): Promise<readonly string[]> {
    if (folder !== undefined) return [this.bucketPath(folder)];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      parseWarnings.push(warningForReadFailure(this.sessionsRoot, error));
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.sessionsRoot, entry.name));
  }

  async #readSessionFile(sessionFile: string): Promise<SessionReadOutcome> {
    let stat: SessionFileStat;
    let content: string;
    try {
      const fileStat = await fs.stat(sessionFile);
      stat = {
        size: fileStat.size,
        mtimeIso: new Date(fileStat.mtimeMs).toISOString(),
      };
      content = await fs.readFile(sessionFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return { parseWarnings: [], missing: true };
      return { parseWarnings: [warningForReadFailure(sessionFile, error)], missing: false };
    }

    const parsed = parseSessionContent(content, sessionFile);
    if (!parsed.header) return { parseWarnings: parsed.parseWarnings, missing: false };

    const subagents = await collectSubagentTranscripts(sessionFile);
    const header = parsed.header as SessionHeader;
    const serverProcess = serverOwnsSession(this.#options, header.id, sessionFile);
    const lease = serverProcess
      ? ({ lease: "held" } satisfies { lease: SessionLeaseState })
      : await detectSessionLiveness(header.id, sessionFile, this.#options.leaseProbe);
    const counts = messageCounts(parsed.entries);
    const file: SessionFile = {
      id: header.id,
      sessionFile,
      version: header.version ?? 1,
      title: header.title,
      cwd: header.cwd,
      createdAt: header.timestamp ?? stat.mtimeIso,
      updatedAt: stat.mtimeIso,
      parentSession: header.parentSession,
      messageCount: counts.messageCount,
      assistantTurns: counts.assistantTurns,
      sizeBytes: stat.size,
      status: statusFromEntries(parsed.entries),
      liveness: { lease: lease.lease, serverProcess },
      subagents: subagents.subagents,
      parseWarnings: [...parsed.parseWarnings, ...subagents.parseWarnings],
      entries: parsed.entries,
    };
    return {
      file,
      parseWarnings: file.parseWarnings,
      missing: false,
    };
  }
}

/** Construct a default store for callers that only need one read-only scan. */
export function createSessionFileStore(options: SessionFileStoreOptions = {}): SessionFileStore {
  return new SessionFileStore(options);
}

/** Convenience function for one listing call. */
export async function listSessions(
  options: SessionFileStoreOptions & ListSessionsArgs = {},
): Promise<SessionListResult> {
  const { folder, cursor, limit, ...storeOptions } = options;
  return new SessionFileStore(storeOptions).listSessions({ folder, cursor, limit });
}

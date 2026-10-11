import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AppFailure,
  type SessionEntryOutputArgs,
  type SessionEntryOutputResult,
  type SessionEntryWindow,
  type SessionEntryWindowArgs,
} from "@omp-app/contracts";
import { detectSessionLiveness } from "./liveness";
import { isJsonObject, parseSessionContent } from "./parser";
import {
  defaultSessionOwnersRoot,
  defaultSessionsRoot,
  sessionBucketName,
  sessionBucketPath,
} from "./paths";
import { readSubagentPage, type SubagentPage, subagentTranscriptPath } from "./subagent-read";
import { collectSubagentTranscripts } from "./subagents";
import { readSessionHeader, type SessionSummary, summarizeSessionFile } from "./summary";
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
  SessionListResult,
  SessionStatus,
  SessionTurn,
  SubagentListResult,
} from "./types";
import {
  readEntryOutput as readOutputFromFile,
  readEntryWindow as readWindowFromFile,
} from "./window";

interface SessionFileStat {
  readonly size: number;
  readonly mtimeIso: string;
}

export interface SessionReadOutcome {
  readonly file?: SessionFile;
  readonly parseWarnings: readonly ParseWarning[];
  readonly missing: boolean;
}

/** What a delete removed: the chat's id and the path of its session file. */
export interface SessionDeletion {
  readonly id: string;
  readonly sessionFile: string;
  /** The artifacts directory that could not be removed: it stays, and the delete still succeeded. */
  readonly artifactsKept?: string;
}

function appFailure(
  code: "invalid_args" | "not_found" | "permission" | "internal" | "conflict",
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

/** True when `child` is inside `parent`, compared as resolved paths; `parent` itself is not inside it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
}

/** The refusal for a path the caller made up, or one that the folder's listing does not return. */
function notListed(): AppFailure {
  return appFailure("not_found", "Session file is not listed", false);
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

/** The chat's turn state when this server runs omp for it; absent otherwise (a chat open in another omp has none). */
function turnFields(
  options: SessionFileStoreOptions,
  sessionId: string,
): { readonly turn?: SessionTurn } {
  const turn = options.turnOf?.(sessionId);
  return turn === undefined ? {} : { turn };
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

const FIRST_PROMPT_MAX = 120;

function messageCounts(entries: readonly unknown[]): {
  messageCount: number;
  assistantTurns: number;
  firstPrompt: string | null;
} {
  let messageCount = 0;
  let assistantTurns = 0;
  let firstPrompt: string | null = null;
  for (const entry of entries) {
    if (!isJsonObject(entry) || entry.type !== "message") continue;
    messageCount++;
    if (!isJsonObject(entry.message)) continue;
    if (entry.message.role === "assistant") assistantTurns++;
    if (firstPrompt === null && entry.message.role === "user") {
      firstPrompt = promptLine(entry.message.content);
    }
  }
  return { messageCount, assistantTurns, firstPrompt };
}

/** A user message's text as one line of at most FIRST_PROMPT_MAX characters; null when empty. */
function promptLine(content: unknown): string | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              isJsonObject(part) && part.type === "text" && typeof part.text === "string"
                ? part.text
                : "",
            )
            .join(" ")
        : "";
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > FIRST_PROMPT_MAX ? `${line.slice(0, FIRST_PROMPT_MAX - 1)}…` : line;
}

/** What the list cache remembers about a file: valid while the file's size and time are unchanged. */
interface CachedSummary {
  readonly size: number;
  readonly mtimeMs: number;
  readonly summary: SessionSummary;
}

/**
 * A place in a listing's order: the modified time, the base name and a tag (a short hash of the full path). The
 * base name orders files modified at the same time, and the tag orders files that also share a base name.
 */
interface ListingPlace {
  readonly mtimeMs: number;
  readonly name: string;
  readonly tag: string;
}

/** A file a listing may show: found by its name and its size and time, never by reading it. */
interface SessionCandidate extends ListingPlace {
  readonly file: string;
  readonly size: number;
}

/** A short hash of a file's full path, the last part of its place in a listing. */
function placeTag(file: string): string {
  return createHash("sha256").update(file).digest("hex").slice(0, 16);
}

/** The listing's order: newest first by the whole milliseconds an ISO timestamp holds, then by base name, then tag. */
function newestFirst(left: ListingPlace, right: ListingPlace): number {
  const leftTime = Math.trunc(left.mtimeMs);
  const rightTime = Math.trunc(right.mtimeMs);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.tag === right.tag) return 0;
  return left.tag < right.tag ? -1 : 1;
}

/**
 * A listing cursor is the place of the last file of a page, in the listing's order: `<modified time>.<tag>.<base name>`,
 * the name in base64url. It never carries the path, so it stays short whatever the folder, and a name is at most 255
 * bytes, so the cursor is at most about 375 characters. A place rather than a count: a file deleted or added before it
 * does not move the files after it. Clients pass it back unread.
 */
function encodeListingCursor(place: ListingPlace): string {
  const name = Buffer.from(place.name, "utf8").toString("base64url");
  return `${Math.trunc(place.mtimeMs)}.${place.tag}.${name}`;
}

function decodeListingCursor(cursor: string): ListingPlace {
  const invalid = () => appFailure("invalid_args", "Invalid session-list cursor", false);
  const parts = cursor.split(".");
  if (parts.length !== 3) throw invalid();
  const [time, tag, encodedName] = parts as [string, string, string];
  const mtimeMs = Number(time);
  if (!/^-?\d{1,16}$/.test(time) || !Number.isSafeInteger(mtimeMs)) throw invalid();
  if (!/^[0-9a-f]{16}$/.test(tag)) throw invalid();
  const name = Buffer.from(encodedName, "base64url").toString("utf8");
  if (name.length === 0) throw invalid();
  return { mtimeMs, name, tag };
}

/** Files whose summaries are remembered; the oldest are forgotten first. */
const SUMMARY_CACHE_LIMIT = 2_000;
/** Files stat-ed or read at the same moment, so a folder with many sessions can't exhaust file handles. */
const FILE_BATCH = 24;

async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += FILE_BATCH) {
    results.push(...(await Promise.all(items.slice(start, start + FILE_BATCH).map(work))));
  }
  return results;
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
  readonly #summaries = new Map<string, CachedSummary>();
  readonly #cwds = new Map<string, { size: number; mtimeMs: number; cwd: string | undefined }>();

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
    const candidates = await this.#candidates(undefined, []);
    // Only each file's first lines are read (and remembered), never the whole file.
    const cwds = await inBatches(candidates, (candidate) => this.#cwdOf(candidate));
    const folders = [
      ...new Set(cwds.filter((cwd): cwd is string => cwd !== undefined && cwd.length > 0)),
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

  /**
   * Port-friendly listing. The order depends only on each file's modified time, so files are found and ordered by
   * their size and time alone; only the files of the requested page are summarized (in one streaming pass,
   * remembered until the file changes). A page is the files after the cursor's place in that order, so a file deleted
   * or added before the place does not move the rest of the list. A page counts files without a valid header too,
   * and silently skips them. A file modified after its page was read is listed where its new time puts it. A listing
   * doesn't walk nested subagent transcripts (`readSession` and `listSubagents` do) and carries no entries.
   */
  async listSessions(args: ListSessionsArgs = {}): Promise<SessionListResult> {
    const limit = parseLimit(args.limit);
    const after = args.cursor ? decodeListingCursor(args.cursor) : undefined;
    const parseWarnings: ParseWarning[] = [];
    const candidates = await this.#candidates(args.folder, parseWarnings);
    const found =
      after === undefined
        ? 0
        : candidates.findIndex((candidate) => newestFirst(candidate, after) > 0);
    const start = found < 0 ? candidates.length : found;
    const end = limit === undefined ? candidates.length : start + limit;
    const page = candidates.slice(start, end);
    const outcomes = await inBatches(page, (candidate) => this.#listingEntry(candidate));
    const sessions: SessionFile[] = [];
    for (const outcome of outcomes) {
      parseWarnings.push(...outcome.parseWarnings);
      if (outcome.file) sessions.push(outcome.file);
    }
    const last = page.at(-1);
    return {
      sessions,
      nextCursor: end < candidates.length && last !== undefined ? encodeListingCursor(last) : null,
      parseWarnings,
    };
  }

  /**
   * The session with this id, or undefined. omp names a file after its session id, so the files
   * whose names contain the id are looked at first; if none is the one, every file's first lines
   * are compared. Nothing is summarized except the match (opening a chat used to list, and read,
   * every session on the machine).
   */
  async findSession(sessionId: string): Promise<SessionFile | undefined> {
    const candidates = await this.#candidates(undefined, []);
    const named = candidates.filter((candidate) =>
      path.basename(candidate.file).includes(sessionId),
    );
    for (const candidate of named) {
      const outcome = await this.#listingEntry(candidate);
      if (outcome.file?.id === sessionId) return outcome.file;
    }
    const others = candidates.filter((candidate) => !named.includes(candidate));
    const headers = await inBatches(others, async (candidate) => {
      try {
        return (await readSessionHeader(candidate.file))?.id === sessionId ? candidate : undefined;
      } catch (error) {
        if (fileErrorCode(error) === undefined) throw error;
        return undefined;
      }
    });
    const match = headers.find((candidate) => candidate !== undefined);
    return match === undefined ? undefined : (await this.#listingEntry(match)).file;
  }

  /**
   * The newest entries of one branch, from a session file this store lists. Any other path, including
   * one outside the sessions folders, is refused before the file is read.
   */
  async readEntryWindow(args: SessionEntryWindowArgs): Promise<SessionEntryWindow> {
    const sessionFile = await this.#listedSessionFile(args.sessionFile);
    const window = await readWindowFromFile(sessionFile, {
      ...(args.leafId === undefined ? {} : { leafId: args.leafId }),
      ...(args.before === undefined ? {} : { before: args.before }),
      ...(args.byteBudget === undefined ? {} : { byteBudget: args.byteBudget }),
    });
    return { sessionFile: args.sessionFile, ...window };
  }

  /** One entry as omp wrote it, from a session file this store lists. */
  async readEntryOutput(args: SessionEntryOutputArgs): Promise<SessionEntryOutputResult> {
    const sessionFile = await this.#listedSessionFile(args.sessionFile);
    return { entry: await readOutputFromFile(sessionFile, args.entryId) };
  }

  /**
   * Deletes one chat: its session file and the artifacts directory beside it. Only a file that the listing of `folder`
   * returns can be deleted. The path is resolved; it must lie inside the sessions root and be a regular file, not a
   * symlink, that reads as a session. This server first stops its own omp for the chat when nobody watches it and no
   * turn runs (`stopUnwatched`), then reads the chat again. A chat that is still watched, one a viewer opened during the
   * stop, or one whose turn runs, is refused, because omp would write it back. The server's own chats are checked once
   * more with no await before the removal. The artifacts directory is checked the same way before anything is removed.
   * Once the chat's file is gone the delete succeeds: artifacts that cannot be removed stay, and are reported as
   * `artifactsKept`.
   */
  async deleteSession(args: {
    readonly folder: string;
    readonly sessionFile: string;
  }): Promise<SessionDeletion> {
    const sessionFile = await this.#deletableSessionFile(args.folder, args.sessionFile);
    const artifacts = await this.#artifactsDirectory(sessionFile);
    const first = await this.#readSessionFile(sessionFile);
    if (!first.file) throw notListed();
    // The id comes from the file, so the stop follows the first read. Stopping waits for a stop already under way, so
    // the chat is not read while omp is still exiting.
    await this.#options.stopUnwatched?.(first.file.id);
    const outcome = await this.#readSessionFile(sessionFile);
    if (!outcome.file) throw notListed();
    const { file } = outcome;
    if (file.turn === "running") {
      throw appFailure("conflict", "Wait for this chat's turn to finish, then delete it.", true);
    }
    if (file.liveness.serverProcess || file.liveness.lease === "held") {
      throw appFailure("conflict", "Close this chat before deleting it: omp has it open.", true);
    }
    // No await between this check and the removal below: a viewer that came in while the lease was probed is refused.
    if (serverOwnsSession(this.#options, file.id, sessionFile)) {
      throw appFailure("conflict", "Close this chat before deleting it: omp has it open.", true);
    }
    try {
      await fs.rm(sessionFile);
    } catch (error) {
      if (isMissing(error)) throw notListed();
      throw appFailure("permission", "Unable to delete the omp session file", true, error);
    }
    let artifactsKept: string | undefined;
    if (artifacts !== undefined) {
      try {
        await fs.rm(artifacts, { recursive: true, force: true });
      } catch {
        artifactsKept = artifacts;
      }
    }
    return { id: file.id, sessionFile, ...(artifactsKept === undefined ? {} : { artifactsKept }) };
  }

  async #listedSessionFile(value: string): Promise<string> {
    const sessionFile = normalizeSessionFile(value);
    const candidates = await this.#candidates(undefined, []);
    if (!candidates.some((candidate) => candidate.file === sessionFile)) {
      throw appFailure("not_found", "Session file is not listed", false);
    }
    return sessionFile;
  }

  /**
   * The file to delete: resolved, inside the sessions root, a regular file (not a symlink), and listed for `folder`.
   * Its real path must stay inside the real sessions root, so a symlinked folder cannot lead out of it.
   */
  async #deletableSessionFile(folder: string, value: string): Promise<string> {
    const sessionFile = normalizeSessionFile(value);
    if (!isInside(this.sessionsRoot, sessionFile)) throw notListed();
    const listed = await this.#candidates(folder, []);
    if (!listed.some((candidate) => candidate.file === sessionFile)) throw notListed();
    let stat: Stats;
    let real: string;
    let realRoot: string;
    try {
      stat = await fs.lstat(sessionFile);
      real = await fs.realpath(sessionFile);
      realRoot = await fs.realpath(this.sessionsRoot);
    } catch (error) {
      if (isMissing(error)) throw notListed();
      throw appFailure("permission", "Unable to read omp session file", true, error);
    }
    if (!stat.isFile() || !isInside(realRoot, real)) throw notListed();
    return sessionFile;
  }

  /**
   * The artifacts directory omp keeps beside a chat: its file name without `.jsonl`. It must be a real directory inside
   * the sessions root (not a symlink, not a file) before anything is removed. Undefined when the chat has none.
   */
  async #artifactsDirectory(sessionFile: string): Promise<string | undefined> {
    const artifacts = path.resolve(sessionFile.slice(0, -".jsonl".length));
    if (path.dirname(artifacts) !== path.dirname(sessionFile)) throw notListed();
    let stat: Stats;
    let real: string;
    let realRoot: string;
    try {
      stat = await fs.lstat(artifacts);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw appFailure("permission", "Unable to read the chat's artifacts", true, error);
    }
    if (!stat.isDirectory()) throw notListed();
    try {
      real = await fs.realpath(artifacts);
      realRoot = await fs.realpath(this.sessionsRoot);
    } catch (error) {
      throw appFailure("permission", "Unable to read the chat's artifacts", true, error);
    }
    if (!isInside(realRoot, real)) throw notListed();
    return artifacts;
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

  /** One page of a worker transcript the chat's listing names, from a byte cursor. Read only. */
  async readSubagent(args: {
    readonly sessionFile: string;
    readonly fromByte?: number;
  }): Promise<SubagentPage> {
    const file = await subagentTranscriptPath(this.sessionsRoot, args.sessionFile);
    return readSubagentPage(file, args.fromByte ?? 0);
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

  /** Every session file a listing may show, found and ordered by name, size and time alone. */
  async #candidates(
    folder: string | undefined,
    warnings: ParseWarning[],
  ): Promise<SessionCandidate[]> {
    const names: string[] = [];
    for (const sessionDir of await this.#sessionDirectories(folder, warnings)) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(sessionDir, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        warnings.push(warningForReadFailure(sessionDir, error));
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".bak")) {
          names.push(path.join(sessionDir, entry.name));
        }
      }
    }
    const found = await inBatches(names, async (file): Promise<SessionCandidate | undefined> => {
      try {
        const stat = await fs.stat(file);
        return {
          file,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          name: path.basename(file),
          tag: placeTag(file),
        };
      } catch (error) {
        // A file that vanished between listing and stat is simply not listed.
        if (!isMissing(error)) warnings.push(warningForReadFailure(file, error));
        return undefined;
      }
    });
    const candidates = found.filter(
      (candidate): candidate is SessionCandidate => candidate !== undefined,
    );
    // Newest first, then by base name and tag: the order every listing cursor is a place in.
    candidates.sort(newestFirst);
    return candidates;
  }

  /** One streaming pass over a file, remembered until its size or modified time changes. */
  async #summary(candidate: SessionCandidate): Promise<SessionSummary> {
    const cached = this.#summaries.get(candidate.file);
    if (cached && cached.size === candidate.size && cached.mtimeMs === candidate.mtimeMs) {
      // Most recently used goes last, so the oldest entry is the one forgotten.
      this.#summaries.delete(candidate.file);
      this.#summaries.set(candidate.file, cached);
      return cached.summary;
    }
    const summary = await summarizeSessionFile(candidate.file);
    this.#summaries.delete(candidate.file);
    this.#summaries.set(candidate.file, {
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
      summary,
    });
    for (const oldest of this.#summaries.keys()) {
      if (this.#summaries.size <= SUMMARY_CACHE_LIMIT) break;
      this.#summaries.delete(oldest);
    }
    return summary;
  }

  /** The working folder a session was started in, from the start of its file. */
  async #cwdOf(candidate: SessionCandidate): Promise<string | undefined> {
    const cached = this.#cwds.get(candidate.file);
    if (cached && cached.size === candidate.size && cached.mtimeMs === candidate.mtimeMs) {
      return cached.cwd;
    }
    let cwd: string | undefined;
    try {
      cwd = (await readSessionHeader(candidate.file))?.cwd;
    } catch (error) {
      // A file that can't be read has no folder to offer; it is not an error for the folder list.
      if (!isMissing(error) && fileErrorCode(error) === undefined) throw error;
      cwd = undefined;
    }
    this.#cwds.delete(candidate.file);
    this.#cwds.set(candidate.file, { size: candidate.size, mtimeMs: candidate.mtimeMs, cwd });
    for (const oldest of this.#cwds.keys()) {
      if (this.#cwds.size <= SUMMARY_CACHE_LIMIT) break;
      this.#cwds.delete(oldest);
    }
    return cwd;
  }

  /** A listing item built from a summary; `readSession` is the whole-file read. */
  async #listingEntry(candidate: SessionCandidate): Promise<SessionReadOutcome> {
    let summary: SessionSummary;
    try {
      summary = await this.#summary(candidate);
    } catch (error) {
      if (isMissing(error)) return { parseWarnings: [], missing: true };
      return { parseWarnings: [warningForReadFailure(candidate.file, error)], missing: false };
    }
    const header = summary.header;
    if (!header) return { parseWarnings: summary.parseWarnings, missing: false };
    const mtimeIso = new Date(candidate.mtimeMs).toISOString();
    const serverProcess = serverOwnsSession(this.#options, header.id, candidate.file);
    const lease = serverProcess
      ? ({ lease: "held" } satisfies { lease: SessionLeaseState })
      : await detectSessionLiveness(header.id, candidate.file, this.#options.leaseProbe);
    const file: SessionFile = {
      id: header.id,
      sessionFile: candidate.file,
      version: header.version ?? 1,
      title: header.title,
      cwd: header.cwd,
      createdAt: header.timestamp ?? mtimeIso,
      updatedAt: mtimeIso,
      parentSession: header.parentSession,
      messageCount: summary.messageCount,
      assistantTurns: summary.assistantTurns,
      firstPrompt: summary.firstPrompt,
      sizeBytes: candidate.size,
      status: summary.status,
      liveness: { lease: lease.lease, serverProcess },
      ...turnFields(this.#options, header.id),
      subagents: [],
      parseWarnings: summary.parseWarnings,
      entries: [],
    };
    return { file, parseWarnings: file.parseWarnings, missing: false };
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
      firstPrompt: counts.firstPrompt,
      sizeBytes: stat.size,
      status: statusFromEntries(parsed.entries),
      liveness: { lease: lease.lease, serverProcess },
      ...turnFields(this.#options, header.id),
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

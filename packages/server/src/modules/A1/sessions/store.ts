import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AppFailure,
  SESSION_DELETE_OTHER_VIEW,
  SESSION_DELETE_RUNNING_TURN,
  type SessionDeleteRefusal,
  type SessionEntryOutputArgs,
  type SessionEntryOutputResult,
  type SessionEntryWindow,
  type SessionEntryWindowArgs,
} from "@omp-app/contracts";
import { headerTimestamp, lastMessageTimestamp, TAIL_CAP_BYTES } from "./activity";
import { detectSessionLiveness } from "./liveness";
import {
  defaultSessionOwnersRoot,
  defaultSessionsRoot,
  sessionBucketName,
  sessionBucketPath,
} from "./paths";
import { REFRESH_READ_LIMITS, ReadBudget } from "./read-budget";
import { readSubagentPage, type SubagentPage, subagentTranscriptPath } from "./subagent-read";
import { collectSubagentTranscripts, type WorkerLeaseProbe } from "./subagents";
import { readSessionHeader, type SessionSummary, summarizeSessionFile } from "./summary";
import {
  type FileIdentity,
  identityOf,
  type StoredSummary,
  SUMMARY_CACHE_FILE,
  SummaryCache,
  type SummaryCacheEntry,
  sameIdentity,
  storedSummaryOf,
  summaryOf,
} from "./summary-cache";
import { type ResumeState, readSummary, type SummaryRead } from "./summary-resume";
import type {
  ListFoldersArgs,
  ListSessionsArgs,
  ParseWarning,
  ReadSessionArgs,
  SessionFile,
  SessionFileStoreOptions,
  SessionFolder,
  SessionFoldersResult,
  SessionLeaseState,
  SessionListResult,
  SessionTurn,
  SubagentListResult,
} from "./types";
import {
  readEntryOutput as readOutputFromFile,
  readEntryWindow as readWindowFromFile,
} from "./window";

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

/**
 * What the store reports from its background work. `refreshed`: a chat whose cached facts were stale has been read again, so
 * its listing entry is current. `failed`: a background read or write did not succeed; the cache then drops the facts it could
 * not check, or is rewritten.
 */
export type SessionBackgroundEvent =
  | {
      readonly kind: "refreshed";
      readonly sessionFile: string;
      readonly id: string;
      readonly cwd: string;
    }
  | { readonly kind: "failed"; readonly sessionFile?: string; readonly message: string };

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

/**
 * The refusal of a delete for a chat omp still holds. A chat the server keeps only for omp's idle time, which no other view
 * holds, has an omp still on its way out: the person is asked to try again. A chat another view holds open is refused in
 * words that say so. A lease another process holds is refused as a chat omp has open. `ownViews` are the views of the
 * connection asking the delete: they are not another view.
 */
function heldFailure(
  options: SessionFileStoreOptions,
  sessionId: string,
  serverProcess: boolean,
  ownViews = 0,
): AppFailure {
  if (serverProcess && !watchedByOthers(options, sessionId, ownViews)) {
    return appFailure("conflict", "omp is still finishing this chat. Try again in a moment.", true);
  }
  return appFailure(
    "conflict",
    serverProcess
      ? SESSION_DELETE_OTHER_VIEW
      : "Close this chat before deleting it: omp has it open.",
    true,
  );
}

/** Whether a view other than the connection's own holds the chat open. */
function watchedByOthers(
  options: SessionFileStoreOptions,
  sessionId: string,
  ownViews: number,
): boolean {
  if (options.views !== undefined) return options.views.watcherCount(sessionId) > ownViews;
  return options.serverWatches?.(sessionId) !== false;
}

/** The chat's turn state when this server runs omp for it; absent otherwise (a chat open in another omp has none). */
function turnFields(
  options: SessionFileStoreOptions,
  sessionId: string,
): { readonly turn?: SessionTurn } {
  const turn = options.turnOf?.(sessionId);
  return turn === undefined ? {} : { turn };
}

/**
 * A place in a listing's order: the time the chat last had a message (in whole milliseconds), the base name and a tag
 * (a short hash of the full path). The base name orders chats with the same time, and the tag orders files that also
 * share a base name.
 */
interface ListingPlace {
  readonly activityMs: number;
  readonly name: string;
  readonly tag: string;
}

/** A file a listing may show: found by its name, size and times; its update time is read by `#updatedAt`. */
interface SessionCandidate extends ListingPlace {
  readonly file: string;
  /** The file's real path: the key of its cached facts. */
  readonly real: string;
  readonly size: number;
  /** The file's modified time and identity: the cached facts are valid while these are unchanged. */
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  /** When the chat last had a message, as an ISO time: the time a listing shows. */
  readonly updatedAt: string;
}

/** A short hash of a file's full path, the last part of its place in a listing. */
function placeTag(file: string): string {
  return createHash("sha256").update(file).digest("hex").slice(0, 16);
}

/** The same file: a file keeps its device and inode while it is appended to, and a rewrite gives it a new inode. */
function sameInode(cached: FileIdentity | undefined, current: FileIdentity): boolean {
  return cached !== undefined && cached.dev === current.dev && cached.ino === current.ino;
}

/** The state an earlier read kept for a file: only while the file keeps its inode. The state's own checks decide the rest. */
function priorOf(
  cached: SummaryCacheEntry | undefined,
  identity: FileIdentity,
): ResumeState | undefined {
  return cached?.resume !== undefined && sameInode(cached.identity, identity)
    ? cached.resume
    : undefined;
}

/** The listing's order: newest first by the whole milliseconds of the update time, then by base name, then tag. */
function newestFirst(left: ListingPlace, right: ListingPlace): number {
  const leftTime = Math.trunc(left.activityMs);
  const rightTime = Math.trunc(right.activityMs);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.tag === right.tag) return 0;
  return left.tag < right.tag ? -1 : 1;
}

/**
 * A listing cursor is the place of the last file of a page, in the listing's order: `a.<update time>.<tag>.<base name>`,
 * the time in whole milliseconds and the name in base64url. It never carries the path, so it stays short whatever the
 * folder, and a name is at most 255 bytes, so the cursor is at most about 375 characters. A place rather than a count: a
 * file deleted or added before it does not move the files after it. Clients pass it back unread.
 */
function encodeListingCursor(place: ListingPlace): string {
  const name = Buffer.from(place.name, "utf8").toString("base64url");
  return `a.${Math.trunc(place.activityMs)}.${place.tag}.${name}`;
}

/**
 * The place a cursor names. A cursor in the form listings used before their order was the update time names no place:
 * it is stale, so the list starts again from its top (undefined). Any other text is an invalid cursor.
 */
function decodeListingCursor(cursor: string): ListingPlace | undefined {
  const invalid = () => appFailure("invalid_args", "Invalid session-list cursor", false);
  const parts = cursor.split(".");
  if (
    parts.length === 3 &&
    /^-?\d{1,16}$/.test(parts[0] ?? "") &&
    /^[0-9a-f]{16}$/.test(parts[1] ?? "")
  ) {
    return undefined;
  }
  if (parts.length !== 4 || parts[0] !== "a") throw invalid();
  const [, time, tag, encodedName] = parts as [string, string, string, string];
  const activityMs = Number(time);
  if (!/^-?\d{1,16}$/.test(time) || !Number.isSafeInteger(activityMs)) throw invalid();
  if (!/^[0-9a-f]{16}$/.test(tag)) throw invalid();
  const name = Buffer.from(encodedName, "base64url").toString("utf8");
  if (name.length === 0) throw invalid();
  return { activityMs, name, tag };
}

/** Working folders remembered per file; the oldest are forgotten first. */
const CWD_CACHE_LIMIT = 2_000;
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
  /** omp's blob store, where the pictures it saves beside a session are kept. */
  readonly blobsDir: string;
  readonly ownersRoot: string;
  readonly #options: SessionFileStoreOptions;
  readonly #cwds = new Map<string, { size: number; mtimeMs: number; cwd: string | undefined }>();
  /** The facts each chat file's listing read. They are kept in the app data folder between starts when it is set. */
  readonly #cache: SummaryCache;
  /** The bytes a listing has in flight, and how many files: see `read-budget.ts`. */
  readonly #budget = new ReadBudget();
  /** The bytes the background refreshes have in flight: their own budget, so that a refresh never holds up a listing. */
  readonly #refreshBudget = new ReadBudget(REFRESH_READ_LIMITS);
  /** The refreshes under way, by real path; `cancelled` is set when the chat is deleted or the store closes. */
  readonly #refreshes = new Map<string, { cancelled: boolean }>();
  /** The refreshes under way until each settles: `close` waits for them. */
  readonly #refreshing = new Set<Promise<void>>();
  /** Set by `close`: no refresh starts, and nothing is cached, after it. */
  #closed = false;
  /** Reads a chat's summary for a listing and a background refresh: the store's own reader unless one is given. */
  readonly #summarize: (
    sessionFile: string,
    size: number,
    prior?: ResumeState,
  ) => Promise<SummaryRead>;
  readonly #backgroundListeners = new Set<(event: SessionBackgroundEvent) => void>();

  /** A worker's own session lease, read by `collectSubagentTranscripts`: `free` once no live omp holds that session. */
  readonly #workerLease: WorkerLeaseProbe = async (sessionId, sessionFile) =>
    (await detectSessionLiveness(sessionId, sessionFile, this.#options.leaseProbe)).lease;

  constructor(options: SessionFileStoreOptions = {}) {
    this.#options = options;
    this.#summarize = options.summarizeFile ?? readSummary;
    this.sessionsRoot = path.resolve(
      options.sessionsRoot ?? defaultSessionsRoot({ home: options.home }),
    );
    // omp keeps its blob store beside its sessions folder: `<agent>/blobs` next to `<agent>/sessions`.
    this.blobsDir = path.join(path.dirname(this.sessionsRoot), "blobs");
    this.ownersRoot = path.resolve(options.ownersRoot ?? defaultSessionOwnersRoot(options.home));
    this.#cache = new SummaryCache({
      ...(options.appDataDir === undefined
        ? {}
        : { file: path.join(path.resolve(options.appDataDir), SUMMARY_CACHE_FILE) }),
      onError: (error) => {
        this.#emit({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    void this.#cache.ready();
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
   * Port-friendly listing. The order is each chat's update time, the time of its newest conversation message, then its
   * base name (see `activity.ts`). Each file's update time and summary are cached (see `summary-cache.ts`): a file is read
   * only when its cached facts are missing, or it changed since they were read. Only the files of the requested page are
   * summarized. A page is the files after the cursor's place in that order, so a file deleted or added before the place
   * does not move the rest of the list; a rename does not move a chat, since it is not a message. A page counts files
   * without a valid header too, and silently skips them. A file modified after its page was read is listed where its new
   * time puts it. A listing doesn't walk nested subagent transcripts (`readSession` and `listSubagents` do) and carries no
   * entries.
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
    const leaseProbe = this.#options.leaseProbe?.forListing?.() ?? this.#options.leaseProbe;
    const outcomes = await inBatches(page, (candidate) =>
      this.#listingEntry(candidate, leaseProbe),
    );
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
      running:
        after === undefined && args.folder !== undefined
          ? this.#runningWithoutFile(args.folder, candidates)
          : [],
    };
  }

  /**
   * Hears what the background work reports: a chat read again after its cached facts were stale, or a read or write that
   * failed. Returns the function that stops the listening.
   */
  onBackground(listener: (event: SessionBackgroundEvent) => void): () => void {
    this.#backgroundListeners.add(listener);
    return () => {
      this.#backgroundListeners.delete(listener);
    };
  }

  /** Writes the summary cache now. It writes itself as it changes, at most once per five seconds. */
  flushSummaries(): Promise<void> {
    return this.#cache.flush();
  }

  /**
   * Ends the store for shutdown. A refresh under way is cancelled: `close` waits for its read to finish, and the refresh then
   * changes nothing and reports nothing. The summary cache is written once and refuses every later change, so nothing is
   * written to the app data folder after this resolves. A listing after this still reads the chats and caches nothing.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#refreshes.values()) job.cancelled = true;
    await Promise.allSettled([...this.#refreshing]);
    await this.#cache.close();
  }

  /**
   * The chats this server runs a turn for in the folder that have no session file yet. omp names a file after its
   * session id, so a chat has a file when some file's name holds its id.
   */
  #runningWithoutFile(folder: string, candidates: readonly SessionCandidate[]): string[] {
    return (this.#options.runningIn?.(folder) ?? []).filter(
      (id) => !candidates.some((candidate) => path.basename(candidate.file).includes(id)),
    );
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
  /** Resolves only the cwd and session path from each candidate's bounded header scan. */
  async resolveThread(
    sessionId: string,
  ): Promise<{ readonly cwd: string; readonly sessionFile: string } | undefined> {
    const candidates = await this.#candidates(undefined, [], false);
    const named = candidates.filter((candidate) =>
      path.basename(candidate.file).includes(sessionId),
    );
    const readHeader = async (
      candidate: SessionCandidate,
    ): Promise<{ readonly cwd: string; readonly sessionFile: string } | undefined> => {
      try {
        const header = await readSessionHeader(candidate.file);
        return header?.id === sessionId
          ? { cwd: header.cwd, sessionFile: candidate.file }
          : undefined;
      } catch (error) {
        if (fileErrorCode(error) === undefined) throw error;
        return undefined;
      }
    };
    for (const candidate of named) {
      const match = await readHeader(candidate);
      if (match !== undefined) return match;
    }
    const others = candidates.filter((candidate) => !named.includes(candidate));
    const headers = await inBatches(others, readHeader);
    return headers.find((candidate) => candidate !== undefined);
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
      blobsDir: this.blobsDir,
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
   * symlink, that reads as a session. A delete from `caller` is refused first, with nothing changed, when the caller holds
   * the chat and its turn runs, or when another connection holds it (`#checkOwnViews`). Otherwise this server stops its own
   * omp for the chat when nobody else watches it and no turn runs (`stopUnwatched`); the caller's own views stay counted
   * while that stop runs, so a refusal before omp exits leaves them as they were. The chat is then read again: a chat that
   * is still watched, one a viewer opened during the stop, or one whose turn runs, is refused, because omp would write it
   * back. The server's own chats are checked once more with no await before the removal. The artifacts directory is checked
   * the same way before anything is removed. Once the chat's file is gone the delete succeeds: artifacts that cannot be
   * removed stay, and are reported as `artifactsKept`. omp's exit takes the caller's views with it, so a refusal after omp
   * has exited gives them back to the chat's running omp when another tab's omp serves the chat (`#restoreViews`): the tab
   * keeps the chat it asked to delete, counted once.
   */
  async deleteSession(
    args: { readonly folder: string; readonly sessionFile: string },
    caller?: { readonly connectionId: string },
  ): Promise<SessionDeletion> {
    const { sessionFile, real } = await this.#deletableSessionFile(args.folder, args.sessionFile);
    const artifacts = await this.#artifactsDirectory(sessionFile);
    const first = await this.#readSessionFile(sessionFile);
    if (!first.file) throw notListed();
    const ownViews = this.#checkOwnViews(first.file, caller);
    // The id comes from the file, so the stop follows the first read. Stopping waits for a stop already under way, so the
    // chat is not read while omp is still exiting.
    await this.#options.stopUnwatched?.(first.file.id, ownViews);
    const outcome = await this.#readSessionFile(sessionFile);
    if (!outcome.file) throw notListed();
    const { file } = outcome;
    try {
      this.#refuseWhileHeld(file, sessionFile, caller);
    } catch (error) {
      // The stop took the asking connection's views with omp: when another tab's omp serves the chat now, they come back.
      this.#restoreViews(file, sessionFile, caller, ownViews);
      throw error;
    }
    try {
      await fs.rm(sessionFile);
    } catch (error) {
      if (isMissing(error)) throw notListed();
      throw appFailure("permission", "Unable to delete the omp session file", true, error);
    }
    this.#forget(real);
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

  /**
   * The checks a `/session delete` omp runs itself gets before omp runs: the registry is not already stopping the chat,
   * the chat's turn does not run, and no other view holds it. omp writes a chat back once its file is gone, so it must not
   * be deleted while another view could still write it. The sidebar's own delete makes the same refusals (`deleteSession`).
   * A refusal comes back with its reason, so the person reads it in the header. The file is undefined when the chat has
   * none on disk: omp's own reply says so.
   */
  async checkOmpDelete(
    sessionId: string,
    caller: { readonly connectionId: string },
  ): Promise<
    | { readonly outcome: "refused"; readonly reason: SessionDeleteRefusal }
    | { readonly outcome: "clear"; readonly file: SessionFile | undefined }
  > {
    const file = await this.findSession(sessionId);
    if (file === undefined) return { outcome: "clear", file: undefined };
    if (this.#options.serverStopping?.(file.id) === true) {
      return { outcome: "refused", reason: "finishing" };
    }
    if (file.turn === "running") return { outcome: "refused", reason: "running" };
    const views = this.#options.views;
    if (
      views !== undefined &&
      views.watcherCount(file.id) > views.viewsOf(file.id, caller.connectionId)
    ) {
      // The split `heldFailure` makes: a chat only omp is still finishing asks the person to try again.
      const finishing = this.#options.serverWatches?.(file.id) === false;
      return { outcome: "refused", reason: finishing ? "finishing" : "open-elsewhere" };
    }
    return { outcome: "clear", file };
  }

  /**
   * Finishes a `/session delete` that omp ran on a chat and that deleted its file. omp writes the chat back when its omp
   * stops, so the chat's omp is stopped when nothing else watches it (the step the sidebar's delete takes before it removes
   * a file), with the caller's own views counted as its own: omp's exit takes them with the chat, and a stop that fails
   * leaves them as they were. A stop that fails throws, and the error reaches the person. Once omp has stopped, the check
   * deleteSession makes runs again: a view that came in while omp stopped, or an omp another tab started, still holds the
   * chat, and omp would write it back. The file is then left as it is and the refusal is returned, not thrown. Otherwise
   * the file omp wrote back is removed. A refusal also gives the caller's views back to the omp that serves the chat now,
   * as `deleteSession` does.
   */
  async finishOmpDelete(
    file: SessionFile,
    caller: { readonly connectionId: string },
  ): Promise<
    | { readonly outcome: "removed" }
    | { readonly outcome: "refused"; readonly reason: SessionDeleteRefusal }
  > {
    // The caller's own views stay counted while omp stops: omp's exit takes them with the chat, and a stop that fails keeps them.
    const own = this.#options.views?.viewsOf(file.id, caller.connectionId) ?? 0;
    await this.#options.stopUnwatched?.(file.id, own);
    const serverProcess = serverOwnsSession(this.#options, file.id, file.sessionFile);
    // Another view counts only where the views are known: a store without them can see no other view to refuse for.
    const others =
      this.#options.views !== undefined &&
      this.#options.views.watcherCount(file.id) > this.#heldViewsOf(file.id, caller);
    if (serverProcess || others) {
      // The stop took the caller's views with omp: a refusal gives them back to the omp that serves the chat now.
      this.#restoreViews(file, file.sessionFile, caller, own);
      // A turn that still runs blocked the stop: the person waits for it, as the sidebar's delete says.
      if (this.#options.turnOf?.(file.id) === "running") {
        return { outcome: "refused", reason: "running" };
      }
      return {
        outcome: "refused",
        reason: serverProcess && !others ? "finishing" : "open-elsewhere",
      };
    }
    const real = await this.#realPathOf(file.sessionFile);
    try {
      await fs.rm(file.sessionFile, { force: true });
    } catch (error) {
      throw appFailure("permission", "Unable to delete the omp session file", true, error);
    }
    if (real !== undefined) this.#forget(real);
    return { outcome: "removed" };
  }

  /**
   * The refusals of a delete from `caller` that change nothing: a turn that runs (for a chat the caller holds), and another
   * connection's view, whether or not the caller holds one. Returns the caller's own views, which the stop counts as its
   * own. Nothing is released here: omp's exit takes the views with it.
   */
  #checkOwnViews(file: SessionFile, caller: { readonly connectionId: string } | undefined): number {
    const views = this.#options.views;
    if (views === undefined) return 0;
    const own = caller === undefined ? 0 : views.viewsOf(file.id, caller.connectionId);
    if (own > 0 && file.turn === "running")
      throw appFailure("conflict", SESSION_DELETE_RUNNING_TURN, true);
    // Another view is checked even when the caller holds none: a second tab's delete must not remove a chat that another
    // tab still shows, including while that tab's omp is stopping.
    if (views.watcherCount(file.id) > own) throw heldFailure(this.#options, file.id, true, own);
    return own;
  }

  /** The views the caller holds on the chat now: none once the chat's omp has stopped, since its views went with it. */
  #heldViewsOf(sessionId: string, caller: { readonly connectionId: string } | undefined): number {
    const views = this.#options.views;
    if (caller === undefined || views === undefined) return 0;
    return views.viewsOf(sessionId, caller.connectionId);
  }

  /**
   * The refusals a delete makes after its stop, while the chat still exists: its turn runs, or a view or an omp holds it.
   * Nothing is awaited here, so the check and the removal that follows see the same state: a viewer that came in while the
   * lease was probed is refused.
   */
  #refuseWhileHeld(
    file: SessionFile,
    sessionFile: string,
    caller: { readonly connectionId: string } | undefined,
  ): void {
    if (file.turn === "running") throw appFailure("conflict", SESSION_DELETE_RUNNING_TURN, true);
    const held = this.#heldViewsOf(file.id, caller);
    if (file.liveness.serverProcess || file.liveness.lease === "held") {
      throw heldFailure(this.#options, file.id, file.liveness.serverProcess, held);
    }
    if (serverOwnsSession(this.#options, file.id, sessionFile)) {
      throw heldFailure(this.#options, file.id, true, held);
    }
  }

  /**
   * Gives the asking connection its views back when a refused delete leaves another tab's omp serving the chat: the stop
   * took them with omp, and the tab still shows the chat. The views join that running omp (`views.restoreViews`), so a
   * chat no omp of this server serves keeps the refusal as it was, and no omp is started.
   */
  #restoreViews(
    file: SessionFile,
    sessionFile: string,
    caller: { readonly connectionId: string } | undefined,
    ownViews: number,
  ): void {
    const views = this.#options.views;
    if (views?.restoreViews === undefined || caller === undefined || ownViews === 0) return;
    if (!serverOwnsSession(this.#options, file.id, sessionFile)) return;
    views.restoreViews(file.id, caller.connectionId, ownViews);
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
  async #deletableSessionFile(
    folder: string,
    value: string,
  ): Promise<{ readonly sessionFile: string; readonly real: string }> {
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
    return { sessionFile, real };
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

  /**
   * One chat's row, as `listSessions` lists it, from the same cached facts. A chat that did not change reads no chat bytes;
   * a chat that only grew folds the lines appended to it (`#summary`).
   */
  async readSessionRow(args: ReadSessionArgs | string): Promise<SessionFile> {
    const sessionFile = normalizeSessionFile(typeof args === "string" ? args : args.sessionFile);
    let stat: Stats;
    try {
      stat = await fs.stat(sessionFile);
    } catch (error) {
      if (isMissing(error)) throw appFailure("not_found", "Session file was not found", false);
      throw appFailure("permission", "Unable to read omp session file", true, error);
    }
    const real = await this.#realPathOf(sessionFile);
    if (real === undefined) throw appFailure("not_found", "Session file was not found", false);
    const outcome = await this.#listingEntry(await this.#candidateOf(sessionFile, real, stat));
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
    const collection = await collectSubagentTranscripts(sessionFile, this.#workerLease);
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

  /**
   * Every session file a listing may show: found by its name and size, and ordered by its update time (see `#updatedAt`),
   * then by base name and tag.
   */
  async #candidates(
    folder: string | undefined,
    warnings: ParseWarning[],
    withActivity = true,
  ): Promise<SessionCandidate[]> {
    await this.#cache.ready();
    const names: { readonly file: string; readonly real: string }[] = [];
    for (const sessionDir of await this.#sessionDirectories(folder, warnings)) {
      let entries: Dirent[];
      let realDir: string;
      try {
        entries = await fs.readdir(sessionDir, { withFileTypes: true });
        realDir = await fs.realpath(sessionDir);
      } catch (error) {
        if (isMissing(error)) continue;
        warnings.push(warningForReadFailure(sessionDir, error));
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".bak")) {
          names.push({
            file: path.join(sessionDir, entry.name),
            real: path.join(realDir, entry.name),
          });
        }
      }
    }
    const found = await inBatches(
      names,
      async ({ file, real }): Promise<SessionCandidate | undefined> => {
        try {
          return await this.#candidateOf(file, real, await fs.stat(file), withActivity);
        } catch (error) {
          // A file that vanished between listing and stat is simply not listed.
          if (!isMissing(error)) warnings.push(warningForReadFailure(file, error));
          return undefined;
        }
      },
    );
    const candidates = found.filter(
      (candidate): candidate is SessionCandidate => candidate !== undefined,
    );
    // Newest first, then by base name and tag: the order every listing cursor is a place in.
    candidates.sort(newestFirst);
    return candidates;
  }

  /** A listing's view of a stat-ed file. Its update time is read unless the caller does not need it. */
  async #candidateOf(
    file: string,
    real: string,
    stat: Stats,
    withActivity = true,
  ): Promise<SessionCandidate> {
    const updatedAt = withActivity
      ? await this.#updatedAt(file, real, stat)
      : new Date(stat.mtimeMs).toISOString();
    const activityMs = Date.parse(updatedAt);
    return {
      file,
      real,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
      updatedAt,
      activityMs: Number.isNaN(activityMs) ? stat.mtimeMs : activityMs,
      name: path.basename(file),
      tag: placeTag(file),
    };
  }

  /**
   * When the chat last had a conversation message (`activity.ts`). The cached time serves while the file is as it was when
   * the time was read. A file changed since a time loaded from the cache file is listed at that time and refreshed in the
   * background (`#refresh`); any other change is read now.
   */
  async #updatedAt(file: string, real: string, stat: Stats): Promise<string> {
    const identity = identityOf(stat);
    const cached = this.#cache.get(real);
    if (cached?.updatedAt !== undefined) {
      if (sameIdentity(cached.identity, identity)) {
        this.#cache.verify(real);
        return cached.updatedAt;
      }
      if (this.#cache.isUnverified(real)) {
        this.#refresh(file, real);
        return cached.updatedAt;
      }
    }
    const updatedAt = await this.#readUpdatedAt(file, stat, this.#budget);
    if (updatedAt === undefined) return new Date(stat.mtimeMs).toISOString();
    this.#remember(real, identity, { updatedAt });
    return updatedAt;
  }

  /**
   * The time read from the file's end and head, or undefined when the file cannot be read. The listing's own read of the file
   * reports that failure, so it is not reported here.
   */
  async #readUpdatedAt(file: string, stat: Stats, budget: ReadBudget): Promise<string | undefined> {
    try {
      return await budget.run(
        Math.min(stat.size, TAIL_CAP_BYTES),
        async () =>
          (await lastMessageTimestamp(file)) ??
          (await headerTimestamp(file)) ??
          new Date(stat.mtimeMs).toISOString(),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Stores what was read from a file in `identity`. Facts read from the same state of the file are kept with them; facts that
   * were read from another state describe a file that has since changed, so they are dropped. The resume state is kept while
   * the file keeps its inode: its own checks decide whether it still fits the bytes. A summary read passes `null` when it
   * could not check its state against the file.
   */
  #remember(
    real: string,
    identity: FileIdentity,
    read: {
      readonly updatedAt?: string;
      readonly summary?: StoredSummary;
      readonly resume?: ResumeState | null;
    },
  ): void {
    const cached = this.#cache.get(real);
    const kept = sameIdentity(cached?.identity, identity) ? cached : undefined;
    const updatedAt = read.updatedAt ?? kept?.updatedAt;
    const summary = read.summary ?? kept?.summary;
    const resume =
      read.resume === null
        ? undefined
        : (read.resume ?? (sameInode(cached?.identity, identity) ? cached?.resume : undefined));
    this.#cache.put({
      realpath: real,
      identity,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(summary === undefined ? {} : { summary }),
      ...(resume === undefined ? {} : { resume }),
    });
  }

  /**
   * A listed file's summary: its cached one while the file is as it was when the summary was read. A file changed since a
   * summary loaded from the cache file is served as cached and refreshed in the background. Any other change is read now,
   * from the state the last read kept for the file: a file that only grew folds the lines appended to it.
   */
  async #summary(candidate: SessionCandidate): Promise<SessionSummary> {
    const identity = identityOf(candidate);
    const cached = this.#cache.get(candidate.real);
    if (cached?.summary !== undefined) {
      if (sameIdentity(cached.identity, identity)) {
        this.#cache.verify(candidate.real);
        return summaryOf(cached.summary, candidate.file);
      }
      if (this.#cache.isUnverified(candidate.real)) {
        this.#refresh(candidate.file, candidate.real);
        return summaryOf(cached.summary, candidate.file);
      }
    }
    let read: SummaryRead;
    try {
      read = await this.#budget.run(candidate.size, () =>
        this.#summarize(candidate.file, candidate.size, priorOf(cached, identity)),
      );
    } catch (error) {
      if (isMissing(error)) this.#cache.delete(candidate.real);
      throw error;
    }
    const stored = storedSummaryOf(read.summary);
    this.#remember(candidate.real, identity, { summary: stored, resume: read.resume ?? null });
    return summaryOf(stored, candidate.file);
  }

  /**
   * Reads a changed chat again in the background, after a listing served its cached facts. The new facts replace the cached
   * ones, and the chat is reported as refreshed so that clients read it again. A read that fails drops the cached facts, so
   * the next listing reads the file itself and reports the failure. Each file has one refresh at a time.
   */
  #refresh(file: string, real: string): void {
    if (this.#closed || this.#refreshes.has(real)) return;
    const job = { cancelled: false };
    this.#refreshes.set(real, job);
    const running = this.#runRefresh(file, real, job);
    this.#refreshing.add(running);
    void running.finally(() => {
      this.#refreshing.delete(running);
    });
  }

  async #runRefresh(file: string, real: string, job: { cancelled: boolean }): Promise<void> {
    let report: SessionBackgroundEvent | undefined;
    try {
      const stat = await fs.stat(file);
      const identity = identityOf(stat);
      const prior = priorOf(this.#cache.get(real), identity);
      const updatedAt = await this.#readUpdatedAt(file, stat, this.#refreshBudget);
      const read = await this.#refreshBudget.run(stat.size, () =>
        this.#summarize(file, stat.size, prior),
      );
      const summary = storedSummaryOf(read.summary);
      if (!job.cancelled) {
        this.#cache.put({
          realpath: real,
          identity,
          ...(updatedAt === undefined ? {} : { updatedAt }),
          summary,
          ...(read.resume === undefined ? {} : { resume: read.resume }),
        });
        if (summary.header !== null) {
          report = {
            kind: "refreshed",
            sessionFile: file,
            id: summary.header.id,
            cwd: summary.header.cwd,
          };
        }
      }
    } catch (error) {
      if (!job.cancelled) {
        this.#cache.delete(real);
        // A chat that is gone was deleted meanwhile: there is nothing to report.
        if (!isMissing(error)) {
          report = {
            kind: "failed",
            sessionFile: file,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    } finally {
      if (this.#refreshes.get(real) === job) this.#refreshes.delete(real);
    }
    if (report !== undefined) this.#emit(report);
  }

  #emit(event: SessionBackgroundEvent): void {
    for (const listener of this.#backgroundListeners) listener(event);
  }

  /** Forgets a removed chat's cached facts, and stops a refresh of it that is under way. */
  #forget(real: string): void {
    this.#cache.delete(real);
    const job = this.#refreshes.get(real);
    if (job !== undefined) job.cancelled = true;
  }

  /**
   * The real path a listing keys a file by: its folder's real path and its name (a listed file is never a symlink). Undefined
   * when the folder is gone.
   */
  async #realPathOf(sessionFile: string): Promise<string | undefined> {
    try {
      return path.join(await fs.realpath(path.dirname(sessionFile)), path.basename(sessionFile));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
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
      if (this.#cwds.size <= CWD_CACHE_LIMIT) break;
      this.#cwds.delete(oldest);
    }
    return cwd;
  }

  /** A listing item built from a summary; `readSession` is the whole-file read. */
  async #listingEntry(
    candidate: SessionCandidate,
    leaseProbe = this.#options.leaseProbe,
  ): Promise<SessionReadOutcome> {
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
      : await detectSessionLiveness(header.id, candidate.file, leaseProbe);
    const file: SessionFile = {
      id: header.id,
      sessionFile: candidate.file,
      version: header.version ?? 1,
      title: header.title,
      cwd: header.cwd,
      createdAt: header.timestamp ?? mtimeIso,
      updatedAt: candidate.updatedAt,
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
    };
    return { file, parseWarnings: file.parseWarnings, missing: false };
  }

  async #readSessionFile(sessionFile: string): Promise<SessionReadOutcome> {
    let fileStat: Stats;
    try {
      fileStat = await fs.stat(sessionFile);
    } catch (error) {
      if (isMissing(error)) return { parseWarnings: [], missing: true };
      return { parseWarnings: [warningForReadFailure(sessionFile, error)], missing: false };
    }
    let summary: SessionSummary;
    try {
      summary = await summarizeSessionFile(sessionFile);
    } catch (error) {
      return { parseWarnings: [warningForReadFailure(sessionFile, error)], missing: false };
    }
    const header = summary.header;
    if (header === undefined) return { parseWarnings: summary.parseWarnings, missing: false };
    const serverProcess = serverOwnsSession(this.#options, header.id, sessionFile);
    const lease = serverProcess
      ? ({ lease: "held" } satisfies { lease: SessionLeaseState })
      : await detectSessionLiveness(header.id, sessionFile, this.#options.leaseProbe);
    const updatedAt =
      (await this.#readUpdatedAt(sessionFile, fileStat, this.#budget)) ??
      new Date(fileStat.mtimeMs).toISOString();
    const file: SessionFile = {
      id: header.id,
      sessionFile,
      version: header.version ?? 1,
      title: header.title,
      cwd: header.cwd,
      createdAt: header.timestamp ?? new Date(fileStat.mtimeMs).toISOString(),
      updatedAt,
      parentSession: header.parentSession,
      messageCount: summary.messageCount,
      assistantTurns: summary.assistantTurns,
      firstPrompt: summary.firstPrompt,
      sizeBytes: fileStat.size,
      status: summary.status,
      liveness: { lease: lease.lease, serverProcess },
      ...turnFields(this.#options, header.id),
      subagents: [],
      parseWarnings: summary.parseWarnings,
    };
    return { file, parseWarnings: file.parseWarnings, missing: false };
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

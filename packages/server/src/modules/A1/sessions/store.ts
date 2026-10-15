import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AppFailure,
  type SessionDeleteRefusal,
  type SessionEntryOutputArgs,
  type SessionEntryOutputResult,
  type SessionEntryWindow,
  type SessionEntryWindowArgs,
} from "@omp-app/contracts";
import { headerTimestamp, lastMessageTimestamp } from "./activity";
import { detectSessionLiveness } from "./liveness";
import { isJsonObject, parseSessionContent } from "./parser";
import {
  defaultSessionOwnersRoot,
  defaultSessionsRoot,
  sessionBucketName,
  sessionBucketPath,
} from "./paths";
import { readSubagentPage, type SubagentPage, subagentTranscriptPath } from "./subagent-read";
import { collectSubagentTranscripts, type WorkerLeaseProbe } from "./subagents";
import {
  promptLine,
  readSessionHeader,
  type SessionSummary,
  summarizeSessionFile,
} from "./summary";
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

/** The sentence a delete gives while the chat's turn runs: omp would write the chat back once its file is gone. */
const RUNNING_TURN_SENTENCE = "Wait for this chat's turn to finish, then delete it.";

/** The sentence for a chat another tab or window has open: the person closes it there, then deletes it again. */
const OTHER_VIEW_SENTENCE =
  "Another tab or window has this chat open. Close it there, then delete it again.";

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
    serverProcess ? OTHER_VIEW_SENTENCE : "Close this chat before deleting it: omp has it open.",
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

/** What the list cache remembers about a file: valid while the file's size and time are unchanged. */
interface CachedSummary {
  readonly size: number;
  readonly mtimeMs: number;
  readonly summary: SessionSummary;
}

/** A file's update time, valid while its size and modified time are unchanged. */
interface CachedActivity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly updatedAt: string;
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

/** A file a listing may show: found by its name, size and times; its update time is read by `#activityIso`. */
interface SessionCandidate extends ListingPlace {
  readonly file: string;
  readonly size: number;
  /** The file's modified time: the summary cache is valid while it is unchanged. */
  readonly mtimeMs: number;
  /** When the chat last had a message, as an ISO time: the time a listing shows. */
  readonly updatedAt: string;
}

/** A short hash of a file's full path, the last part of its place in a listing. */
function placeTag(file: string): string {
  return createHash("sha256").update(file).digest("hex").slice(0, 16);
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

/** Files whose summaries are remembered; the oldest are forgotten first. */
const SUMMARY_CACHE_LIMIT = 2_000;
/** Files whose update times are remembered; the oldest are forgotten first. */
const ACTIVITY_CACHE_LIMIT = 20_000;
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
  readonly #summaries = new Map<string, CachedSummary>();
  readonly #cwds = new Map<string, { size: number; mtimeMs: number; cwd: string | undefined }>();
  readonly #activity = new Map<string, CachedActivity>();
  /**
   * When the chat last had a conversation message, as an ISO time: the newest message's time, else the header's, else
   * the file's modified time. Read from the file's end and remembered while the file's size and time are unchanged, so
   * a listing reads each file once. A file that cannot be read is listed at its modified time; the listing reports the
   * read failure itself.
   */
  async #activityIso(file: string, size: number, mtimeMs: number): Promise<string> {
    const cached = this.#activity.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.updatedAt;
    let updatedAt: string;
    try {
      updatedAt =
        (await lastMessageTimestamp(file)) ??
        (await headerTimestamp(file)) ??
        new Date(mtimeMs).toISOString();
    } catch {
      return new Date(mtimeMs).toISOString();
    }
    this.#activity.delete(file);
    this.#activity.set(file, { size, mtimeMs, updatedAt });
    for (const oldest of this.#activity.keys()) {
      if (this.#activity.size <= ACTIVITY_CACHE_LIMIT) break;
      this.#activity.delete(oldest);
    }
    return updatedAt;
  }

  /** A worker's own session lease, read by `collectSubagentTranscripts`: `free` once no live omp holds that session. */
  readonly #workerLease: WorkerLeaseProbe = async (sessionId, sessionFile) =>
    (await detectSessionLiveness(sessionId, sessionFile, this.#options.leaseProbe)).lease;

  constructor(options: SessionFileStoreOptions = {}) {
    this.#options = options;
    this.sessionsRoot = path.resolve(
      options.sessionsRoot ?? defaultSessionsRoot({ home: options.home }),
    );
    // omp keeps its blob store beside its sessions folder: `<agent>/blobs` next to `<agent>/sessions`.
    this.blobsDir = path.join(path.dirname(this.sessionsRoot), "blobs");
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
   * Port-friendly listing. The order is each chat's update time, the time of its newest conversation message, then its
   * base name (see `activity.ts`): each file's end is read for that time, remembered while the file's size and time are
   * unchanged. Only the files of the requested page are summarized (in one streaming pass, remembered until the file
   * changes). A page is the files after the cursor's place in that order, so a file deleted
   * or added before the place does not move the rest of the list; a rename does not move a chat, since it is not a
   * message. A page counts files without a valid header too,
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
      running:
        after === undefined && args.folder !== undefined
          ? this.#runningWithoutFile(args.folder, candidates)
          : [],
    };
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
   * removed stay, and are reported as `artifactsKept`. omp's exit takes the caller's views with it, before the file is
   * removed, so a refusal after omp has exited (a viewer opened the chat while omp stopped) leaves the caller uncounted on
   * this server.
   */
  async deleteSession(
    args: { readonly folder: string; readonly sessionFile: string },
    caller?: { readonly connectionId: string },
  ): Promise<SessionDeletion> {
    const sessionFile = await this.#deletableSessionFile(args.folder, args.sessionFile);
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
    if (file.turn === "running") throw appFailure("conflict", RUNNING_TURN_SENTENCE, true);
    const held = this.#heldViewsOf(file.id, caller);
    if (file.liveness.serverProcess || file.liveness.lease === "held") {
      throw heldFailure(this.#options, file.id, file.liveness.serverProcess, held);
    }
    // No await between this check and the removal below: a viewer that came in while the lease was probed is refused.
    if (serverOwnsSession(this.#options, file.id, sessionFile)) {
      throw heldFailure(this.#options, file.id, true, held);
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

  /**
   * The checks a `/session delete` omp runs itself gets before omp runs: the chat's turn does not run, and no other view
   * holds it. omp writes a chat back once its file is gone, so a chat another view could still write must not be deleted
   * at all; the sidebar's own delete makes the same refusals (`deleteSession`). A refusal comes back with its reason, so
   * the person reads it in the header. The file is undefined when the chat has none on disk: omp's own reply says so.
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
   * leaves them as they were. The file is removed again if omp wrote it back. A stop that fails throws, and the error
   * reaches the person.
   */
  async finishOmpDelete(
    file: SessionFile,
    caller: { readonly connectionId: string },
  ): Promise<void> {
    // The caller's own views stay counted while omp stops: omp's exit takes them with the chat, and a stop that fails keeps them.
    const own = this.#options.views?.viewsOf(file.id, caller.connectionId) ?? 0;
    await this.#options.stopUnwatched?.(file.id, own);
    try {
      await fs.rm(file.sessionFile, { force: true });
    } catch (error) {
      throw appFailure("permission", "Unable to delete the omp session file", true, error);
    }
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
      throw appFailure("conflict", RUNNING_TURN_SENTENCE, true);
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
   * Every session file a listing may show: found by its name and size, and ordered by its update time (see
   * `#activityIso`), then by base name and tag.
   */
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
        const updatedAt = await this.#activityIso(file, stat.size, stat.mtimeMs);
        const activityMs = Date.parse(updatedAt);
        return {
          file,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          updatedAt,
          activityMs: Number.isNaN(activityMs) ? stat.mtimeMs : activityMs,
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
      entries: [],
    };
    return { file, parseWarnings: file.parseWarnings, missing: false };
  }

  async #readSessionFile(sessionFile: string): Promise<SessionReadOutcome> {
    let stat: SessionFileStat;
    let mtimeMs: number;
    let content: string;
    try {
      const fileStat = await fs.stat(sessionFile);
      mtimeMs = fileStat.mtimeMs;
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

    const subagents = await collectSubagentTranscripts(sessionFile, this.#workerLease);
    const header = parsed.header as SessionHeader;
    const serverProcess = serverOwnsSession(this.#options, header.id, sessionFile);
    const lease = serverProcess
      ? ({ lease: "held" } satisfies { lease: SessionLeaseState })
      : await detectSessionLiveness(header.id, sessionFile, this.#options.leaseProbe);
    const counts = messageCounts(parsed.entries);
    const updatedAt = await this.#activityIso(sessionFile, stat.size, mtimeMs);
    const file: SessionFile = {
      id: header.id,
      sessionFile,
      version: header.version ?? 1,
      title: header.title,
      cwd: header.cwd,
      createdAt: header.timestamp ?? stat.mtimeIso,
      updatedAt,
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

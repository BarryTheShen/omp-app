import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../fs/atomic-file";
import type { SessionSummary } from "./summary";
import type { SessionHeader, SessionStatus } from "./types";

/*
 * What a session listing remembers about each chat file between starts: the time the chat last had a message, and the
 * summary one pass over the file yields. A file is read again only when the cache has no fact for it, or the file changed
 * since (`SessionFileStore`). The cache holds what the listing shows and nothing else of a chat: the first prompt (at most
 * 120 characters), the title, the working folder, the counts and the statuses. The file is `session-summaries.json` in the
 * app data folder, mode 0600, and goes with that folder.
 */

/**
 * The shape of the cached facts. Bump it when a listing reads something else from a file: a cache written with another
 * number is rebuilt, not read.
 */
export const SUMMARY_SCHEMA = 1;
/** The cache file's name in the app data folder. */
export const SUMMARY_CACHE_FILE = "session-summaries.json";
/** The least time between two writes of the cache file. A change is written once this much time has passed. */
export const SUMMARY_WRITE_INTERVAL_MS = 5_000;
/** The chats remembered; the least recently listed are forgotten first. */
export const SUMMARY_CACHE_LIMIT = 20_000;

/** The longest first prompt the cache holds, in characters: the listing's own limit. */
const FIRST_PROMPT_MAX = 120;
const SESSION_STATUSES = [
  "complete",
  "interrupted",
  "aborted",
  "error",
  "pending",
  "unknown",
] as const satisfies readonly SessionStatus[];
const WARNING_CODES = [
  "malformed_line",
  "invalid_header",
  "header_not_first",
  "read_error",
  "subagent_read_error",
] as const;

/** A file's identity and state. A cached fact is valid while every one of these is unchanged. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

const FileIdentitySchema = z.strictObject({
  dev: z.number().nonnegative(),
  ino: z.number().nonnegative(),
  size: z.int().nonnegative(),
  mtimeMs: z.number(),
});

/** The header fields a listing shows. */
const StoredHeaderSchema = z.strictObject({
  id: z.string().min(1),
  cwd: z.string(),
  version: z.int().nonnegative().optional(),
  title: z.string().optional(),
  timestamp: z.string().optional(),
  parentSession: z.string().optional(),
});

/** A parse warning without its path: the path is the cache entry's key. */
const StoredWarningSchema = z.strictObject({
  code: z.enum(WARNING_CODES),
  message: z.string(),
  line: z.int().nonnegative().optional(),
  partial: z.boolean().optional(),
});

/** One summary of a file, as a listing reads it. */
const StoredSummarySchema = z.strictObject({
  header: StoredHeaderSchema.nullable(),
  messageCount: z.int().nonnegative(),
  assistantTurns: z.int().nonnegative(),
  firstPrompt: z.string().max(FIRST_PROMPT_MAX).nullable(),
  status: z.enum(SESSION_STATUSES),
  parseWarnings: z.array(StoredWarningSchema),
});

/** A hash as the cache keeps it: 32 lowercase hex digits (`hashOf` in summary-resume.ts). */
const HashSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** A fold's title slot as a summary reads it: its padding is never kept. */
const FoldTitleSlotSchema = z.strictObject({
  title: z.string(),
  source: z.enum(["auto", "user"]).optional(),
  updatedAt: z.string(),
});

/** A fold's state (`SummaryFoldState` in summary.ts): everything a summary keeps of the lines it has read. */
const FoldStateSchema = z.strictObject({
  lineIndex: z.int().nonnegative(),
  entryCount: z.int().nonnegative(),
  titleSlot: FoldTitleSlotSchema.optional(),
  header: z.record(z.string(), z.unknown()).optional(),
  messageCount: z.int().nonnegative(),
  assistantTurns: z.int().nonnegative(),
  firstPrompt: z.string().max(FIRST_PROMPT_MAX).nullable(),
  status: z.enum(SESSION_STATUSES),
  warnings: z.array(StoredWarningSchema),
});

/** The state that resumes a summary (`ResumeState` in summary-resume.ts). */
const ResumeSchema = z.strictObject({
  offset: z.int().nonnegative(),
  prefixHash: HashSchema,
  tailHash: HashSchema,
  fold: FoldStateSchema,
});

/**
 * The cached facts of one chat file, keyed by its real path. `updatedAt`, `summary` and `resume` are each optional. The
 * first two were read from the file in `identity`; `resume` is checked against the file's bytes before it is used.
 */
const SummaryCacheEntrySchema = z
  .strictObject({
    realpath: z.string().refine((value) => path.isAbsolute(value)),
    identity: FileIdentitySchema,
    updatedAt: z.string().optional(),
    summary: StoredSummarySchema.optional(),
    resume: ResumeSchema.optional(),
  })
  .refine(
    (entry) =>
      entry.updatedAt !== undefined || entry.summary !== undefined || entry.resume !== undefined,
  );

const CacheFileSchema = z.strictObject({
  summarySchema: z.literal(SUMMARY_SCHEMA),
  entries: z.array(z.unknown()),
});

export type StoredHeader = z.infer<typeof StoredHeaderSchema>;
export type StoredWarning = z.infer<typeof StoredWarningSchema>;
export type StoredSummary = z.infer<typeof StoredSummarySchema>;
export type SummaryCacheEntry = z.infer<typeof SummaryCacheEntrySchema>;

/** The identity of a file, copied so that no other field of a stat or a candidate is ever stored. */
export function identityOf(file: FileIdentity): FileIdentity {
  return { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs };
}

/** Whether a cached fact was read from the file as it is now. `false` when there is no fact. */
export function sameIdentity(cached: FileIdentity | undefined, current: FileIdentity): boolean {
  return (
    cached !== undefined &&
    cached.dev === current.dev &&
    cached.ino === current.ino &&
    cached.size === current.size &&
    cached.mtimeMs === current.mtimeMs
  );
}

/** The cached form of a fresh summary. */
export function storedSummaryOf(summary: SessionSummary): StoredSummary {
  const header = summary.header;
  return {
    header:
      header === undefined
        ? null
        : {
            id: header.id,
            cwd: header.cwd,
            ...(header.version === undefined ? {} : { version: header.version }),
            ...(header.title === undefined ? {} : { title: header.title }),
            ...(header.timestamp === undefined ? {} : { timestamp: header.timestamp }),
            ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
          },
    messageCount: summary.messageCount,
    assistantTurns: summary.assistantTurns,
    firstPrompt: summary.firstPrompt,
    status: summary.status,
    parseWarnings: summary.parseWarnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.line === undefined ? {} : { line: warning.line }),
      ...(warning.partial === undefined ? {} : { partial: warning.partial }),
    })),
  };
}

/** The summary a listing reads from its cached form. `sessionFile` is the path the warnings name. */
export function summaryOf(stored: StoredSummary, sessionFile: string): SessionSummary {
  const header = stored.header;
  return {
    header:
      header === null
        ? undefined
        : ({
            type: "session",
            id: header.id,
            cwd: header.cwd,
            ...(header.version === undefined ? {} : { version: header.version }),
            ...(header.title === undefined ? {} : { title: header.title }),
            ...(header.timestamp === undefined ? {} : { timestamp: header.timestamp }),
            ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
          } satisfies SessionHeader),
    messageCount: stored.messageCount,
    assistantTurns: stored.assistantTurns,
    firstPrompt: stored.firstPrompt,
    status: stored.status,
    parseWarnings: stored.parseWarnings.map((warning) => ({ ...warning, sessionFile })),
  };
}

export interface SummaryCacheOptions {
  /** The cache file. Without one the cache lives in memory only, and a restart reads every chat again. */
  readonly file?: string;
  readonly limit?: number;
  readonly writeIntervalMs?: number;
  readonly now?: () => number;
  /** Runs `run` after `delayMs`, and returns its cancel function. The default timer does not keep the process alive. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  /** Receives a failed read or write of the cache file. The cache carries on without the file. */
  readonly onError: (error: unknown) => void;
}

/**
 * The chats' cached facts: in memory, and in `file` when there is one. A change is written at most once per
 * `writeIntervalMs`, never once per change. A fact is either verified (read from the file as it is now) or loaded from the
 * cache file and not yet checked in this process; a listing uses that to decide what it may serve before it reads.
 */
export class SummaryCache {
  readonly #file: string | undefined;
  readonly #limit: number;
  readonly #interval: number;
  readonly #now: () => number;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #onError: (error: unknown) => void;
  readonly #entries = new Map<string, SummaryCacheEntry>();
  readonly #unverified = new Set<string>();
  #loading: Promise<void> | undefined;
  #dirty = false;
  /** Cancels the write that is armed, while one is. */
  #timer: (() => void) | undefined;
  #closed = false;
  #lastWriteAt: number;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: SummaryCacheOptions) {
    this.#file = options.file;
    this.#limit = options.limit ?? SUMMARY_CACHE_LIMIT;
    this.#interval = options.writeIntervalMs ?? SUMMARY_WRITE_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#schedule =
      options.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.#onError = options.onError;
    this.#lastWriteAt = this.#now();
  }

  /** Resolves once the cache file has been read. A file that is missing, invalid or of another schema starts it empty. */
  ready(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  /** The cached facts of a file, which become the most recently used. */
  get(realpath: string): SummaryCacheEntry | undefined {
    const entry = this.#entries.get(realpath);
    if (entry !== undefined) {
      this.#entries.delete(realpath);
      this.#entries.set(realpath, entry);
    }
    return entry;
  }

  /** Whether the facts of a file were loaded from the cache file and not yet checked against the file in this process. */
  isUnverified(realpath: string): boolean {
    return this.#unverified.has(realpath);
  }

  /** Records that the facts of a file were checked against the file in this process. */
  verify(realpath: string): void {
    this.#unverified.delete(realpath);
  }

  /** Stores facts of a file that were read in this process. Ignored once the cache is closed. */
  put(entry: SummaryCacheEntry): void {
    if (this.#closed) return;
    this.#entries.delete(entry.realpath);
    this.#entries.set(entry.realpath, entry);
    this.#unverified.delete(entry.realpath);
    this.#trim();
    this.#markDirty();
  }

  /** Forgets the facts of a file, for example once the file is deleted. Ignored once the cache is closed. */
  delete(realpath: string): void {
    if (this.#closed) return;
    this.#unverified.delete(realpath);
    if (this.#entries.delete(realpath)) this.#markDirty();
  }

  /**
   * Writes the cache file now, if it changed since it was last written. Writes run one after another, and the returned promise
   * settles once every write queued before it has finished.
   */
  flush(): Promise<void> {
    this.#writes = this.#writes.then(() => this.#write());
    return this.#writes;
  }

  /**
   * Ends the cache for shutdown: the armed write is cancelled, what changed is written once, and every later change is
   * ignored. Nothing is written to the app data folder once this resolves, not even a write that failed here.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#timer?.();
    this.#timer = undefined;
    await this.flush();
    this.#dirty = false;
  }

  async #write(): Promise<void> {
    await this.ready();
    if (this.#file === undefined || !this.#dirty) return;
    this.#dirty = false;
    this.#lastWriteAt = this.#now();
    const text = `${JSON.stringify({ summarySchema: SUMMARY_SCHEMA, entries: [...this.#entries.values()] })}\n`;
    try {
      await writeFileAtomic(this.#file, text);
    } catch (error) {
      this.#dirty = true;
      this.#onError(error);
    }
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return;
    let text: string;
    try {
      text = await fs.readFile(this.#file, "utf8");
    } catch (error) {
      if (!isMissing(error)) {
        this.#onError(error);
        this.#markDirty();
      }
      return;
    }
    const cached = parseCacheFile(text);
    if (cached === undefined) {
      // Not this schema's file, or not JSON: the cache is rebuilt from the chats. That is the designed path, not a failure.
      this.#markDirty();
      return;
    }
    if (cached.dropped > 0) this.#markDirty();
    const present = await Promise.all(
      cached.entries.map(async (entry) =>
        (await this.#exists(entry.realpath)) ? entry : undefined,
      ),
    );
    for (const entry of present) {
      if (entry === undefined) {
        // A chat whose file no longer exists is dropped, and the cache file is rewritten without it.
        this.#markDirty();
        continue;
      }
      this.#entries.set(entry.realpath, entry);
      this.#unverified.add(entry.realpath);
    }
    this.#trim();
  }

  async #exists(file: string): Promise<boolean> {
    try {
      await fs.stat(file);
      return true;
    } catch (error) {
      if (!isMissing(error)) this.#onError(error);
      return false;
    }
  }

  #trim(): void {
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) return;
      this.#entries.delete(oldest);
      this.#unverified.delete(oldest);
      this.#markDirty();
    }
  }

  #markDirty(): void {
    if (this.#file === undefined || this.#closed) return;
    this.#dirty = true;
    this.#arm();
  }

  /** Schedules the write for the time the interval allows, with one timer at a time. */
  #arm(): void {
    if (this.#timer !== undefined || !this.#dirty || this.#closed) return;
    this.#timer = this.#schedule(
      () => this.#tick(),
      Math.max(0, this.#lastWriteAt + this.#interval - this.#now()),
    );
  }

  #tick(): void {
    this.#timer = undefined;
    if (this.#closed) return;
    if (this.#now() < this.#lastWriteAt + this.#interval) {
      this.#arm();
      return;
    }
    void this.flush();
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * The entries of a cache file that validate, and how many were dropped. Undefined for a file that is not JSON or is not this
 * schema's: the cache is then rebuilt.
 */
function parseCacheFile(
  text: string,
): { readonly entries: readonly SummaryCacheEntry[]; readonly dropped: number } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const file = CacheFileSchema.safeParse(json);
  if (!file.success) return undefined;
  const results = file.data.entries.map((raw) => SummaryCacheEntrySchema.safeParse(raw));
  const entries = results.flatMap((result) => (result.success ? [result.data] : []));
  return { entries, dropped: results.length - entries.length };
}

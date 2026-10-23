import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../fs/atomic-file";
import type { RecordedOutcomeState } from "./recorded-outcomes";
import type { TranscriptFacts } from "./subagent-scanner";

/*
 * What a chat's finished-worker listing remembers between reads: each worker transcript's facts, and each parent
 * session's recorded outcomes with the offset its last scan reached. A transcript is read again only when its real path,
 * size, mtime or inode changed; a parent is scanned again only from its offset. The cache lives in memory and, when the
 * app data folder is given, in `session-subagents.json` there, written the way `session-summaries.json` is.
 */

/** The cache file's name in the app data folder, beside `session-summaries.json`. */
export const SUBAGENT_CACHE_FILE = "session-subagents.json";
/** The shape of the cached facts. A cache written with another number is rebuilt, not read. */
const SUBAGENT_CACHE_SCHEMA = 1;
/** The least time between two writes of the cache file. A change is written once this much time has passed. */
const SUBAGENT_WRITE_INTERVAL_MS = 5_000;
/** Worker transcripts remembered across all chats; the least recently used are forgotten first. */
const SUBAGENT_TRANSCRIPT_LIMIT = 20_000;
/** Parent sessions remembered; the least recently used are forgotten first. */
const SUBAGENT_PARENT_LIMIT = 5_000;

const WARNING_CODES = [
  "malformed_line",
  "invalid_header",
  "header_not_first",
  "read_error",
  "subagent_read_error",
] as const;
const OUTCOME_STATUSES = ["completed", "failed", "aborted"] as const;

/** What a cached transcript fact was read from. The fact is valid while every one of these is unchanged. */
export interface TranscriptIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SubagentScanCacheOptions {
  /** The cache file. Without one the cache lives in memory only, and a restart reads every transcript again. */
  readonly file?: string;
  readonly transcriptLimit?: number;
  readonly parentLimit?: number;
  readonly writeIntervalMs?: number;
  readonly now?: () => number;
  /** Runs `run` after `delayMs`, and returns its cancel function. The default timer does not keep the process alive. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  /** Receives a failed read or write of the cache file. The cache carries on without the file. */
  readonly onError: (error: unknown) => void;
  /** Called with a file and the byte count of each read a listing makes. Tests use it to see what a listing reads. */
  readonly onRead?: (file: string, bytes: number) => void;
}

interface TranscriptRecord {
  readonly identity: TranscriptIdentity;
  readonly facts: TranscriptFacts;
}

/**
 * The finished-worker listing's remembered facts. A change is written at most once per `writeIntervalMs`, never once per
 * change, and writes never overlap. Both maps forget their least recently used entry first.
 */
export class SubagentScanCache {
  readonly #file: string | undefined;
  readonly #interval: number;
  readonly #now: () => number;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #onError: (error: unknown) => void;
  readonly #transcripts: RecentMap<TranscriptRecord>;
  readonly #parents: RecentMap<RecordedOutcomeState>;
  /** Called with each read a listing makes, so a test can see what was read. */
  readonly onRead: ((file: string, bytes: number) => void) | undefined;
  #loading: Promise<void> | undefined;
  #dirty = false;
  /** Cancels the write that is armed, while one is. */
  #timer: (() => void) | undefined;
  #closed = false;
  #lastWriteAt: number;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: SubagentScanCacheOptions) {
    this.#file = options.file;
    this.#interval = options.writeIntervalMs ?? SUBAGENT_WRITE_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#schedule =
      options.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.#onError = options.onError;
    this.onRead = options.onRead;
    this.#transcripts = new RecentMap(options.transcriptLimit ?? SUBAGENT_TRANSCRIPT_LIMIT);
    this.#parents = new RecentMap(options.parentLimit ?? SUBAGENT_PARENT_LIMIT);
    this.#lastWriteAt = this.#now();
  }

  /** Resolves once the cache file has been read. A file that is missing, invalid or of another schema starts the cache empty. */
  ready(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  /** The facts of a transcript, when they were read from the file with this identity. */
  transcript(realFile: string, identity: TranscriptIdentity): TranscriptFacts | undefined {
    const record = this.#transcripts.get(realFile);
    return record !== undefined && sameIdentity(record.identity, identity)
      ? record.facts
      : undefined;
  }

  /** Stores the facts of a transcript read with this identity. Ignored once the cache is closed. */
  putTranscript(realFile: string, identity: TranscriptIdentity, facts: TranscriptFacts): void {
    if (this.#closed) return;
    this.#transcripts.set(realFile, { identity: { ...identity }, facts });
    this.#markDirty();
  }

  /** The recorded outcomes of a parent session, as its last scan left them. */
  parent(realFile: string): RecordedOutcomeState | undefined {
    return this.#parents.get(realFile);
  }

  /** Stores a parent's scan. A scan that found the same file as before keeps the stored state, and writes nothing. */
  putParent(realFile: string, state: RecordedOutcomeState): void {
    if (this.#closed) return;
    const known = this.#parents.get(realFile);
    if (known !== undefined && sameParentScan(known, state)) return;
    this.#parents.set(realFile, state);
    this.#markDirty();
  }

  /** Forgets a parent whose file is gone or unreadable. Ignored once the cache is closed. */
  forgetParent(realFile: string): void {
    if (this.#closed) return;
    if (this.#parents.delete(realFile)) this.#markDirty();
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
    const text = `${JSON.stringify({
      schema: SUBAGENT_CACHE_SCHEMA,
      transcripts: this.#transcripts.entries().map(([realpath, record]) => ({
        realpath,
        identity: record.identity,
        facts: record.facts,
      })),
      parents: this.#parents.entries().map(([realpath, state]) => ({
        realpath,
        dev: state.dev,
        ino: state.ino,
        size: state.size,
        prefixHash: state.prefixHash,
        offset: state.offset,
        outcomes: [...state.outcomes],
      })),
    })}\n`;
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
      // Not this schema's file, or not JSON: the cache is rebuilt from the transcripts. That is the designed path, not a failure.
      this.#markDirty();
      return;
    }
    if (cached.dropped > 0) this.#markDirty();
    const transcripts = await Promise.all(
      cached.transcripts.map(async (entry) =>
        (await this.#exists(entry.realpath)) ? entry : undefined,
      ),
    );
    for (const entry of transcripts) {
      if (entry === undefined) {
        // A transcript whose file no longer exists is dropped, and the cache file is rewritten without it.
        this.#markDirty();
        continue;
      }
      if (this.#transcripts.set(entry.realpath, { identity: entry.identity, facts: entry.facts })) {
        this.#markDirty();
      }
    }
    const parents = await Promise.all(
      cached.parents.map(async (entry) =>
        (await this.#exists(entry.realpath)) ? entry : undefined,
      ),
    );
    for (const entry of parents) {
      if (entry === undefined) {
        this.#markDirty();
        continue;
      }
      const state: RecordedOutcomeState = {
        dev: entry.dev,
        ino: entry.ino,
        size: entry.size,
        prefixHash: entry.prefixHash,
        offset: entry.offset,
        outcomes: new Map(entry.outcomes),
      };
      if (this.#parents.set(entry.realpath, state)) this.#markDirty();
    }
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

/**
 * A bounded map that forgets its least recently used entry first: `get` and `set` each make their entry the most recent.
 */
class RecentMap<V> {
  readonly #entries = new Map<string, V>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  /** Stores an entry as the most recent. Returns true when older entries had to leave to keep the limit. */
  set(key: string, value: V): boolean {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    let evicted = false;
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) break;
      this.#entries.delete(oldest);
      evicted = true;
    }
    return evicted;
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  /** The entries from the least recently used to the most recently used. */
  entries(): [string, V][] {
    return [...this.#entries.entries()];
  }
}

function sameIdentity(a: TranscriptIdentity, b: TranscriptIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Whether a new scan of a parent found the same file, with the same bytes read: nothing about the stored state changed. */
function sameParentScan(a: RecordedOutcomeState, b: RecordedOutcomeState): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.offset === b.offset &&
    a.prefixHash === b.prefixHash
  );
}

/** The cache a session store keeps: in `session-subagents.json` in the app data folder when one is given, else in memory. */
export function createSubagentScanCache(
  appDataDir: string | undefined,
  options: Omit<SubagentScanCacheOptions, "file">,
): SubagentScanCache {
  return new SubagentScanCache({
    ...options,
    ...(appDataDir === undefined
      ? {}
      : { file: path.join(path.resolve(appDataDir), SUBAGENT_CACHE_FILE) }),
  });
}

/**
 * The cache a listing uses when its caller gives none: in memory only, so repeated listings in this process read each
 * transcript once. It writes no file, so its `onError` is never reached; if it ever were, the error is thrown, not hidden.
 */
export const sharedSubagentScanCache = new SubagentScanCache({
  onError: (error) => {
    throw error;
  },
});

const HeaderSchema = z.looseObject({
  type: z.literal("session"),
  id: z.string().min(1),
  cwd: z.string(),
});
const IdentitySchema = z.strictObject({
  dev: z.number(),
  ino: z.number(),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
});
const WarningSchema = z.strictObject({
  code: z.enum(WARNING_CODES),
  message: z.string(),
  line: z.number().int().positive().optional(),
  partial: z.literal(true).optional(),
});
const FactsSchema = z.strictObject({
  header: HeaderSchema.optional(),
  entryCount: z.number().int().nonnegative(),
  leafId: z.string().nullable(),
  agent: z.string().nullable(),
  sawSuccessfulYield: z.boolean(),
  assistantStopReason: z.string().nullable(),
  assistantError: z.string().nullable(),
  endedNormally: z.boolean(),
  warnings: z.array(WarningSchema),
});
const TranscriptEntrySchema = z.strictObject({
  realpath: z.string(),
  identity: IdentitySchema,
  facts: FactsSchema,
});
const ParentEntrySchema = z
  .strictObject({
    realpath: z.string(),
    dev: z.number(),
    ino: z.number(),
    size: z.number().nonnegative(),
    prefixHash: z.string(),
    offset: z.number().nonnegative(),
    outcomes: z.array(z.tuple([z.string(), z.enum(OUTCOME_STATUSES)])),
  })
  .refine((entry) => entry.offset <= entry.size);
const CacheFileSchema = z.strictObject({
  schema: z.literal(SUBAGENT_CACHE_SCHEMA),
  transcripts: z.array(z.unknown()),
  parents: z.array(z.unknown()),
});

type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;
type ParentEntry = z.infer<typeof ParentEntrySchema>;

/**
 * The entries of a cache file that validate, and how many were dropped. Undefined for a file that is not JSON or is not this
 * schema's: the cache is then rebuilt.
 */
function parseCacheFile(text: string):
  | {
      readonly transcripts: readonly TranscriptEntry[];
      readonly parents: readonly ParentEntry[];
      readonly dropped: number;
    }
  | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const file = CacheFileSchema.safeParse(json);
  if (!file.success) return undefined;
  const transcripts = file.data.transcripts.map((raw) => TranscriptEntrySchema.safeParse(raw));
  const parents = file.data.parents.map((raw) => ParentEntrySchema.safeParse(raw));
  const validTranscripts = transcripts.flatMap((result) => (result.success ? [result.data] : []));
  const validParents = parents.flatMap((result) => (result.success ? [result.data] : []));
  return {
    transcripts: validTranscripts,
    parents: validParents,
    dropped: transcripts.length - validTranscripts.length + (parents.length - validParents.length),
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

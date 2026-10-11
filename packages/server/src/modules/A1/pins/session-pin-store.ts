import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AppError,
  AppFailure,
  type SessionPinChanged,
  type SessionPinListResult,
  type SessionPinSetArgs,
  type SessionPinSetResult,
  ThreadId,
} from "@omp-app/contracts";
import { z } from "zod";
import {
  type AtomicWriteResult,
  compareAndSwapFile,
  type FileSnapshot,
  type FileWatcher,
  type FileWatchRegistry,
  hashContent,
  readFileSnapshot,
  watchFile,
} from "../fs";

const PINS_FILENAME = "session-pins.json";

export interface SessionPinStoreOptions {
  /** Environment used when resolving the default agent directory. */
  readonly env?: Record<string, string | undefined>;
  /** Home directory used when `PI_CODING_AGENT_DIR` and `OMP_PROFILE` are absent. */
  readonly homeDir?: string;
  /** Explicit omp agent directory; useful for tests and isolated hosts. */
  readonly agentDir?: string;
  /** Receives malformed-file and watcher failures without allowing them to escape. */
  readonly onError?: (error: AppFailure) => void;
  /** Defaults to the fs watcher debounce. */
  readonly watchDebounceMs?: number;
  /** Records the watched files this store cannot watch right now, so the person can be told. */
  readonly watchRegistry?: FileWatchRegistry;
}

export type SessionPinChangeListener = (change: SessionPinChanged) => void | Promise<void>;

/** omp's own file is a bare JSON array of session ids (session-pins.ts:9-11, 21-22). */
const PinsFileContents = z.array(ThreadId);

function failure(code: AppError["code"], message: string, retryable = false): AppFailure {
  return new AppFailure({ code, message, retryable });
}

function isAppFailure(error: unknown): error is AppFailure {
  return error instanceof AppFailure;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = error.code;
  return typeof value === "string" ? value : undefined;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (isAppFailure(error)) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return failure("permission", `Cannot ${operation}: permission denied.`, false);
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return failure("not_found", `Cannot ${operation}: session pins file not found.`, false);
  }
  return failure("internal", `Cannot ${operation}.`, false);
}

function reportError(callback: ((error: AppFailure) => void) | undefined, error: unknown): void {
  if (!callback) return;
  const appError = toFailure(error, "read session pins");
  try {
    callback(appError);
  } catch {
    // An error observer must never become an uncaught watcher exception.
  }
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDirectory, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Matches omp v18.6.1's packages/utils/src/dirs.ts:618-621 (`getAgentDir`) and 311-315
 * (`getConfigAgentDirName`): `PI_CODING_AGENT_DIR` wins outright; otherwise `OMP_PROFILE` selects
 * `~/.omp/profiles/<profile>/agent`; otherwise the default is `~/.omp/agent`. Mirrors A1.4
 * ConfigStore's own `resolveAgentDirectory` — there is no shared export for it, so every A1 store
 * that reads one of omp's own directories resolves it independently.
 */
function resolveAgentDirectory(options: SessionPinStoreOptions): string {
  const environment = options.env ?? process.env;
  const homeDirectory = resolve(options.homeDir ?? homedir());
  const explicit = nonEmpty(options.agentDir) ?? nonEmpty(environment.PI_CODING_AGENT_DIR);
  if (explicit) return resolve(expandHome(explicit, homeDirectory));
  const profile = nonEmpty(environment.OMP_PROFILE);
  if (profile) return resolve(homeDirectory, ".omp", "profiles", profile, "agent");
  return resolve(homeDirectory, ".omp", "agent");
}

/**
 * Wraps the pins file's raw content hash (`null` when the file is absent) into the port's
 * non-nullable `Revision`, mirroring A1.4 ConfigStore's `revisionForSnapshots`: with a single file
 * there is nothing to aggregate, but `SessionPinListResult`/`SessionPinSetResult`/`SessionPinChanged`
 * never allow `null`, so "no file yet" still needs a concrete, comparable CAS token.
 */
function computeRevision(hash: string | null): string {
  return hashContent(JSON.stringify({ hash }));
}

/**
 * `null` is both fs/'s own absent-file sentinel (`NO_FILE`) and the port's documented "the caller
 * expects an absent pins file" value; any other string is compared against the wrapped revision
 * `list()`/`set()` last reported.
 */
function checkExpectedRevision(expected: string | null, rawHash: string | null): void {
  if (expected === null) {
    if (rawHash !== null) {
      throw failure("conflict", "Cannot write session pins: the file already exists.", true);
    }
    return;
  }
  if (expected !== computeRevision(rawHash)) {
    throw failure("conflict", "Cannot write session pins: the file changed.", true);
  }
}

/**
 * Parses the pins file's JSON array of session ids (session-pins.ts:10-30). A missing file is an
 * empty array, never an error. Anything else that fails to parse is surfaced as `invalid_args`
 * instead of degrading to empty: omp's own reader silently treats any unreadable shape as an empty
 * set (session-pins.ts `loadPinnedSessionIds`'s catch-all), which would let a `set()` built on that
 * empty reading silently overwrite a file this store could not understand.
 */
function parsePinnedIds(snapshot: FileSnapshot): ThreadId[] {
  if (!snapshot.exists) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(snapshot.content ?? "");
  } catch {
    throw failure("invalid_args", "Session pins file contains malformed JSON.");
  }
  const parsed = PinsFileContents.safeParse(raw);
  if (!parsed.success) {
    throw failure("invalid_args", "Session pins file must contain a JSON array of session ids.");
  }
  return [...new Set(parsed.data)];
}

/**
 * Reads and toggles omp's global `<agentDir>/session-pins.json` (session-pins.ts:10-73): pins are
 * keyed by session id so they survive `/move` renames. Every write is a compare-and-swap through
 * fs/'s atomic file writer, so a concurrent omp write surfaces as a retryable `conflict` instead of
 * a lost update, and change events (from fs/'s file watcher) report external edits — including a
 * real omp process toggling a pin — without echoing this store's own writes.
 */
export class SessionPinStoreService {
  readonly agentDir: string;
  readonly filePath: string;

  readonly #options: SessionPinStoreOptions;
  readonly #listeners = new Set<SessionPinChangeListener>();
  #watcher: FileWatcher | undefined;
  #ready: Promise<void> | undefined;
  #knownIds: readonly ThreadId[] = [];
  #watchGeneration = 0;
  #knownIdsInitialized = false;

  constructor(options: SessionPinStoreOptions = {}) {
    this.#options = options;
    this.agentDir = resolveAgentDirectory(options);
    this.filePath = join(this.agentDir, PINS_FILENAME);
  }

  async list(): Promise<SessionPinListResult> {
    const snapshot = await this.readSnapshot();
    const ids = parsePinnedIds(snapshot);
    this.adoptKnownIds(ids);
    return {
      pins: ids.map((sessionId) => ({ sessionId, pinned: true as const })),
      revision: computeRevision(snapshot.hash),
      readAt: new Date().toISOString(),
    };
  }

  async set(args: SessionPinSetArgs): Promise<SessionPinSetResult> {
    const snapshot = await this.readSnapshot();
    const ids = parsePinnedIds(snapshot);
    checkExpectedRevision(args.expectedRevision, snapshot.hash);

    const wasPinned = ids.includes(args.sessionId);
    if (wasPinned === args.pinned) {
      // Already in the desired state and the revision just passed CAS: a no-op, not a write.
      this.adoptKnownIds(ids);
      return {
        sessionId: args.sessionId,
        pinned: args.pinned,
        revision: computeRevision(snapshot.hash),
      };
    }

    const nextIds = args.pinned
      ? [...ids, args.sessionId]
      : ids.filter((id) => id !== args.sessionId);
    // Matches omp's own writer exactly (session-pins.ts:60): tab-indented JSON, no trailing
    // newline, so a real omp process can still read (and CAS-write) this file.
    const content = JSON.stringify(nextIds, null, "\t");
    let result: AtomicWriteResult;
    try {
      result = await compareAndSwapFile(this.filePath, content, snapshot.hash);
    } catch (error) {
      throw toFailure(error, "write session pins");
    }
    this.adoptKnownIds(nextIds);
    return {
      sessionId: args.sessionId,
      pinned: args.pinned,
      revision: computeRevision(result.hash),
    };
  }

  /** Subscribes to pin changes from outside this store (another tab, or a real omp process). */
  subscribe(listener: SessionPinChangeListener): () => void {
    this.#listeners.add(listener);
    this.ensureWatcher();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.releaseWatcher();
    };
  }

  dispose(): void {
    this.releaseWatcher();
    this.#listeners.clear();
  }

  private async readSnapshot(): Promise<FileSnapshot> {
    try {
      return await readFileSnapshot(this.filePath);
    } catch (error) {
      throw toFailure(error, "read session pins");
    }
  }

  private adoptKnownIds(ids: readonly ThreadId[]): void {
    this.#knownIds = ids;
    this.#knownIdsInitialized = true;
  }

  private ensureWatcher(): void {
    if (this.#watcher) return;
    const generation = ++this.#watchGeneration;
    this.#knownIdsInitialized = false;
    this.#ready = this.seedKnownIds(generation);
    try {
      this.#watcher = watchFile(this.filePath, () => this.handleFileChange(), {
        debounceMs: this.#options.watchDebounceMs,
        onError: (error) => reportError(this.#options.onError, error),
        registry: this.#options.watchRegistry,
      });
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  private releaseWatcher(): void {
    this.#watchGeneration += 1;
    this.#watcher?.dispose();
    this.#watcher = undefined;
    this.#ready = undefined;
    this.#knownIds = [];
    this.#knownIdsInitialized = false;
  }

  /** Seeds the diff baseline before any real change can be observed, so the first external edit
   * after a fresh subscribe never misreports pre-existing pins as newly added. A concurrent
   * `list()`/`set()` that wins the race first is not overwritten (`#knownIdsInitialized`). */
  private async seedKnownIds(generation: number): Promise<void> {
    try {
      const snapshot = await this.readSnapshot();
      const ids = parsePinnedIds(snapshot);
      if (generation === this.#watchGeneration && !this.#knownIdsInitialized) {
        this.adoptKnownIds(ids);
      }
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  private async handleFileChange(): Promise<void> {
    await this.#ready;
    let snapshot: FileSnapshot;
    try {
      snapshot = await this.readSnapshot();
    } catch (error) {
      reportError(this.#options.onError, error);
      return;
    }
    let nextIds: ThreadId[];
    try {
      nextIds = parsePinnedIds(snapshot);
    } catch (error) {
      // Never silently treat a malformed external edit as "no pins"; keep the last known-good
      // baseline so a later valid edit still diffs correctly.
      reportError(this.#options.onError, error);
      return;
    }
    const previousIds = this.#knownIds;
    this.adoptKnownIds(nextIds);
    const previousSet = new Set(previousIds);
    const nextSet = new Set(nextIds);
    const added = nextIds.filter((id) => !previousSet.has(id));
    const removed = previousIds.filter((id) => !nextSet.has(id));
    if (added.length === 0 && removed.length === 0) return;
    const revision = computeRevision(snapshot.hash);
    for (const sessionId of added) await this.emit({ sessionId, pinned: true, revision });
    for (const sessionId of removed) await this.emit({ sessionId, pinned: false, revision });
  }

  private async emit(change: SessionPinChanged): Promise<void> {
    for (const listener of this.#listeners) {
      try {
        const result = listener(change);
        if (result && typeof result === "object" && "then" in result) await result;
      } catch (error) {
        reportError(this.#options.onError, error);
      }
    }
  }
}

export function createSessionPinStore(
  options: SessionPinStoreOptions = {},
): SessionPinStoreService {
  return new SessionPinStoreService(options);
}

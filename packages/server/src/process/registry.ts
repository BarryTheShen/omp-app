import type { ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { RpcSessionTimer } from "@omp-app/omp-rpc";
import type { OmpProcess, OmpProcessOptions } from "./omp-process";
import { spawnOmpProcess } from "./omp-process";

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;

function defaultTimer(): RpcSessionTimer {
  return {
    setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number | Timer),
  };
}

export interface OmpProcessRegistryOptions {
  /** How long an unwatched, non-busy thread's process stays up before `stop()`. Default 10 minutes. */
  readonly idleCloseMs?: number;
  /** Injectable for tests; defaults to `spawnOmpProcess` (a real `omp --mode rpc-ui` child). */
  readonly createProcess?: (options: OmpProcessOptions) => OmpProcess;
  /** Injectable for deterministic idle-close tests; defaults to the global timer. */
  readonly timer?: RpcSessionTimer;
}

interface Entry {
  key: ThreadId;
  readonly process: OmpProcess;
  readonly folder: string;
  unsubscribe: () => void;
  watchers: number;
  busy: boolean;
  idleTimer: unknown;
}

/**
 * One `OmpProcess` per open thread. A thread stays up while it has a watcher or is busy; an idle,
 * unwatched thread's process is stopped after `idleCloseMs`. A process that exits on its own
 * (crash) stays registered, so `restart()` can bring the same logical thread back; a process this
 * registry (or its caller) intentionally `stop()`ped is forgotten, so the next `acquire()` for
 * that thread spawns a fresh one.
 */
export class OmpProcessRegistry {
  readonly #idleCloseMs: number;
  readonly #createProcess: (options: OmpProcessOptions) => OmpProcess;
  readonly #timer: RpcSessionTimer;
  readonly #entries = new Map<ThreadId, Entry>();

  constructor(options: OmpProcessRegistryOptions = {}) {
    this.#idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    this.#createProcess = options.createProcess ?? spawnOmpProcess;
    this.#timer = options.timer ?? defaultTimer();
  }

  /**
   * Returns the thread's process, creating it if this is the first viewer. Does not call
   * `start()`: construct any `RpcSession` around the returned duplex first, then start it,
   * so no early output is missed.
   */
  acquire(options: OmpProcessOptions): OmpProcess {
    const existing = this.#entries.get(options.threadId);
    if (existing !== undefined) {
      if (existing.folder !== options.folder) {
        throw new AppFailure({
          code: "conflict",
          message: `Thread ${options.threadId} is already open in a different folder`,
          retryable: false,
        });
      }
      existing.watchers += 1;
      this.#cancelIdle(existing);
      return existing.process;
    }
    const process = this.#createProcess(options);
    const entry: Entry = {
      key: options.threadId,
      process,
      folder: options.folder,
      watchers: 1,
      busy: false,
      idleTimer: undefined,
      unsubscribe: () => undefined,
    };
    entry.unsubscribe = process.onEvent((event) => {
      if (event.status !== "stopped") return;
      if (this.#entries.get(entry.key) !== entry) return;
      this.#entries.delete(entry.key);
      entry.unsubscribe();
    });
    this.#entries.set(options.threadId, entry);
    return process;
  }

  /** One fewer viewer of the thread; schedules idle-close once watchers reach 0 and it is not busy. */
  release(threadId: ThreadId): void {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return;
    entry.watchers = Math.max(0, entry.watchers - 1);
    this.#scheduleIdleIfNeeded(threadId, entry);
  }

  /** A busy thread is never idle-closed, even with zero watchers (for example, a running prompt). */
  setBusy(threadId: ThreadId, busy: boolean): void {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return;
    entry.busy = busy;
    if (busy) this.#cancelIdle(entry);
    else this.#scheduleIdleIfNeeded(threadId, entry);
  }

  get(threadId: ThreadId): OmpProcess | undefined {
    return this.#entries.get(threadId)?.process;
  }

  has(threadId: ThreadId): boolean {
    return this.#entries.has(threadId);
  }
  /** Move a just-started process from a provisional key to omp's authoritative session id. */
  rekey(from: ThreadId, to: ThreadId): OmpProcess {
    const entry = this.#entries.get(from);
    if (entry === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: `No process is registered for thread ${from}`,
        retryable: false,
      });
    }
    if (from === to) return entry.process;
    if (this.#entries.has(to)) {
      throw new AppFailure({
        code: "conflict",
        message: `A process is already registered for thread ${to}`,
        retryable: false,
      });
    }
    this.#entries.delete(from);
    entry.key = to;
    this.#entries.set(to, entry);
    return entry.process;
  }

  async restart(threadId: ThreadId): Promise<void> {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: `No process is registered for thread ${threadId}`,
        retryable: false,
      });
    }
    await entry.process.restart();
  }

  /** Stops every registered process; for server shutdown. */
  async closeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(
      entries.map((entry) => {
        this.#cancelIdle(entry);
        entry.unsubscribe();
        return entry.process.stop();
      }),
    );
  }

  #cancelIdle(entry: Entry): void {
    if (entry.idleTimer !== undefined) {
      this.#timer.clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  #scheduleIdleIfNeeded(threadId: ThreadId, entry: Entry): void {
    this.#cancelIdle(entry);
    if (entry.watchers > 0 || entry.busy) return;
    entry.idleTimer = this.#timer.setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.watchers > 0 || entry.busy) return;
      this.#entries.delete(threadId);
      entry.unsubscribe();
      void entry.process.stop();
    }, this.#idleCloseMs);
  }
}

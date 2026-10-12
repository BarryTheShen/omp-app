import type { ProcessStatus, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { RpcSessionTimer } from "@omp-app/omp-rpc";
import type { OmpProcess, OmpProcessOptions } from "./omp-process";
import { spawnOmpProcess } from "./omp-process";

/**
 * Each omp process holds about 380 MB while idle, so a chat nobody watches is stopped after two
 * minutes: coming back to it restarts omp and replays its history (a couple of seconds).
 */
const DEFAULT_IDLE_CLOSE_MS = 2 * 60 * 1000;

/** How long a wait for omp to stop lasts before it refuses. A stop takes at most about five seconds (SIGTERM, then SIGKILL). */
const STOP_LIMIT_MS = 10 * 1000;

/** What a wait for omp to stop is for; it names the refusal when omp does not stop in time. */
export type StopPurpose = "deleted" | "opened" | "renamed";

/** The refusal when omp did not stop in time: the chat stays as it is, since omp may still write its file. Retry later. */
function stopRefused(purpose: StopPurpose): AppFailure {
  return new AppFailure({
    code: "conflict",
    message: `omp did not stop, so this chat was not ${purpose}. Try again in a moment.`,
    retryable: true,
  });
}

function defaultTimer(): RpcSessionTimer {
  return {
    setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number | Timer),
  };
}

export interface OmpProcessRegistryOptions {
  /** How long an unwatched thread's process stays up before it is checked and stopped. Default 2 minutes. */
  readonly idleCloseMs?: number;
  /** Injectable for tests; defaults to `spawnOmpProcess` (a real `omp --mode rpc-ui` child). */
  readonly createProcess?: (options: OmpProcessOptions) => OmpProcess;
  /** Injectable for deterministic idle-close tests; defaults to the global timer. */
  readonly timer?: RpcSessionTimer;
}

/**
 * What the registry asks of whoever holds a thread's session (A0's runtime), and tells it. Set once
 * with `setIdleHooks`.
 */
export interface OmpProcessIdleHooks {
  /**
   * Asked when an unwatched thread has been quiet for `idleCloseMs`. False (omp is running a turn,
   * or has queued messages or background work that can wake it) keeps the process and asks again
   * after another period, so leaving a chat never kills work that is still going.
   */
  readonly isSettled: (threadId: ThreadId) => Promise<boolean>;
  /** The registry is stopping this thread's process because nobody watches it: forget it. */
  readonly stopping: (threadId: ThreadId, process: OmpProcess) => void;
}

interface Entry {
  key: ThreadId;
  process: OmpProcess;
  readonly folder: string;
  unsubscribe: () => void;
  watchers: number;
  busy: boolean;
  idleTimer: unknown;
}

/**
 * One `OmpProcess` per open thread. A thread stays up while it has a watcher or is busy; an
 * unwatched thread's process is stopped after `idleCloseMs`, but only once omp reports it is
 * settled (see `OmpProcessIdleHooks`). A process that exits on its own (crash) stays registered, so
 * `respawn()` can bring the same logical thread back; a process this registry (or its caller)
 * intentionally `stop()`ped is forgotten, so the next `acquire()` for that thread spawns a fresh
 * one.
 */
export class OmpProcessRegistry {
  readonly #idleCloseMs: number;
  readonly #createProcess: (options: OmpProcessOptions) => OmpProcess;
  readonly #timer: RpcSessionTimer;
  readonly #entries = new Map<ThreadId, Entry>();
  readonly #stopping = new Map<ThreadId, Promise<void>>();
  /** The process of each thread whose stop failed, until a stop of it succeeds: a wait for the thread tries it again. */
  readonly #stuck = new Map<ThreadId, OmpProcess>();
  #idleHooks: OmpProcessIdleHooks | undefined;
  readonly #busyListeners = new Set<(threadId: ThreadId, busy: boolean) => void>();

  constructor(options: OmpProcessRegistryOptions = {}) {
    this.#idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    this.#createProcess = options.createProcess ?? spawnOmpProcess;
    this.#timer = options.timer ?? defaultTimer();
  }

  /** Called once by whoever owns the threads' sessions. */
  setIdleHooks(hooks: OmpProcessIdleHooks): void {
    this.#idleHooks = hooks;
  }

  /**
   * Resolves once omp for the thread has exited, so its session file is free. A thread opened again must wait: omp holds
   * a lease on the session file until it exits, and a second omp on the same file would be refused. Resolves at once when
   * no stop is under way. A stop under way is waited for, and a stop that failed is tried again. Either refuses (a
   * retryable conflict naming `purpose`) when omp does not stop within STOP_LIMIT_MS, so no caller waits for ever.
   */
  async whenGone(threadId: ThreadId, purpose: StopPurpose): Promise<void> {
    const stopping = this.#stopping.get(threadId) ?? this.#retryStuck(threadId);
    if (stopping === undefined) return;
    await this.#finishedWithin(stopping, purpose);
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
    entry.unsubscribe = this.#forgetWhenStopped(entry);
    this.#entries.set(options.threadId, entry);
    return process;
  }

  /**
   * Replaces the process of a thread whose omp stopped on its own with a new one built from `options`
   * (the caller gives the arguments that resume the chat). The thread keeps its viewers and its idle state. A turn
   * the dead process was running ends with it; the dead process is stopped without the registry forgetting the thread.
   */
  async respawn(options: OmpProcessOptions): Promise<OmpProcess> {
    const entry = this.#entries.get(options.threadId);
    if (entry === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: `No process is registered for thread ${options.threadId}`,
        retryable: false,
      });
    }
    const dead = entry.process;
    entry.unsubscribe();
    // The old process's end is no longer heard from here, so a turn it was still running ends now.
    this.#endTurn(entry);
    const process = this.#createProcess(options);
    entry.process = process;
    entry.unsubscribe = this.#forgetWhenStopped(entry);
    await dead.stop().catch((error: unknown) => {
      console.error("[omp-app] could not stop an omp process that had already exited", error);
    });
    return process;
  }

  /** A process that is stopped on purpose is forgotten: the next `acquire()` for the thread starts a new one. */
  #forgetWhenStopped(entry: Entry): () => void {
    return entry.process.onEvent((event) => {
      // A process that exits, fails or is stopped ends the turn it was running: omp sends no more of it.
      if (event.status === "exited" || event.status === "error" || event.status === "stopped") {
        this.#endTurn(entry);
      }
      if (event.status !== "stopped") return;
      if (this.#entries.get(entry.key) !== entry) return;
      this.#entries.delete(entry.key);
      entry.unsubscribe();
    });
  }

  /** One fewer viewer of the thread; schedules idle-close once watchers reach 0 and it is not busy. */
  release(threadId: ThreadId): void {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return;
    entry.watchers = Math.max(0, entry.watchers - 1);
    this.#scheduleIdleIfNeeded(entry);
  }

  /**
   * Stops a thread's process now if nobody watches it, it is not busy, and omp reports it settled: a host started only
   * for one job (a rename of a chat nobody has open) stops as soon as the job is done, not after the idle wait. A
   * watched or busy process is left alone, and the idle timer still applies to it. Resolves once omp for the thread has
   * exited, so a caller that reads or removes the session file next does not race that exit; refuses as `whenGone`
   * does when omp does not stop in time.
   */
  async stopIfUnwatched(threadId: ThreadId, purpose: StopPurpose): Promise<void> {
    const entry = this.#entries.get(threadId);
    if (entry !== undefined && entry.watchers === 0 && !entry.busy) {
      this.#cancelIdle(entry);
      const closed = await this.#closeIfIdle(entry);
      // A stop this call started is waited for alone: when it fails, this call refuses and does not try it again.
      if (closed !== undefined) return this.#finishedWithin(closed.stopping, purpose);
    }
    return this.whenGone(threadId, purpose);
  }

  /** Waits for a stop to finish, for at most STOP_LIMIT_MS. A stop that fails, or runs past the limit, refuses. */
  async #finishedWithin(stopping: Promise<void>, purpose: StopPurpose): Promise<void> {
    let timeout: unknown;
    const limit = new Promise<never>((_resolve, reject) => {
      timeout = this.#timer.setTimeout(() => reject(stopRefused(purpose)), STOP_LIMIT_MS);
    });
    try {
      await Promise.race([stopping.catch(() => Promise.reject(stopRefused(purpose))), limit]);
    } finally {
      this.#timer.clearTimeout(timeout);
    }
  }

  /**
   * A busy thread is never idle-closed, even with zero watchers: it is in a turn (omp's `agent_start` until the
   * session settles). Listeners hear each change of the mark.
   */
  setBusy(threadId: ThreadId, busy: boolean): void {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return;
    const changed = entry.busy !== busy;
    entry.busy = busy;
    if (busy) this.#cancelIdle(entry);
    else this.#scheduleIdleIfNeeded(entry);
    if (changed) this.#notifyBusy(threadId, busy);
  }

  /** Whether the thread is busy; `undefined` when the registry holds no process for it. */
  busyOf(threadId: ThreadId): boolean | undefined {
    return this.#entries.get(threadId)?.busy;
  }

  /** Calls `listener` each time a thread's busy mark changes; the returned function stops it. */
  onBusyChange(listener: (threadId: ThreadId, busy: boolean) => void): () => void {
    this.#busyListeners.add(listener);
    return () => {
      this.#busyListeners.delete(listener);
    };
  }

  /**
   * Clears the busy mark of a process that exited or failed: its turn is lost with it. No idle close is scheduled,
   * so a crashed process stays registered for `respawn()`.
   */
  #endTurn(entry: Entry): void {
    if (!entry.busy || this.#entries.get(entry.key) !== entry) return;
    entry.busy = false;
    this.#notifyBusy(entry.key, false);
  }

  #notifyBusy(threadId: ThreadId, busy: boolean): void {
    for (const listener of this.#busyListeners) listener(threadId, busy);
  }

  get(threadId: ThreadId): OmpProcess | undefined {
    return this.#entries.get(threadId)?.process;
  }

  has(threadId: ThreadId): boolean {
    return this.#entries.has(threadId);
  }

  /** Whether a viewer holds the thread open. A process the registry keeps for omp's idle time alone is not watched. */
  watched(threadId: ThreadId): boolean {
    return (this.#entries.get(threadId)?.watchers ?? 0) > 0;
  }

  /** The processes held right now: what the debug log's periodic sample reports. */
  list(): readonly {
    readonly threadId: ThreadId;
    readonly pid: number | undefined;
    readonly status: ProcessStatus;
  }[] {
    return [...this.#entries.values()].map((entry) => ({
      threadId: entry.key,
      pid: entry.process.pid,
      status: entry.process.status,
    }));
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

  #scheduleIdleIfNeeded(entry: Entry): void {
    this.#cancelIdle(entry);
    if (entry.watchers > 0 || entry.busy) return;
    entry.idleTimer = this.#timer.setTimeout(() => {
      entry.idleTimer = undefined;
      void this.#closeIfIdle(entry);
    }, this.#idleCloseMs);
  }

  #stillUnwatched(entry: Entry): boolean {
    return this.#entries.get(entry.key) === entry && entry.watchers === 0 && !entry.busy;
  }

  async #closeIfIdle(entry: Entry): Promise<{ readonly stopping: Promise<void> } | undefined> {
    if (!this.#stillUnwatched(entry)) return undefined;
    if (this.#idleHooks !== undefined) {
      let settled: boolean;
      try {
        settled = await this.#idleHooks.isSettled(entry.key);
      } catch {
        // omp that has exited holds nothing; omp that is only slow to answer is left running.
        settled = ["exited", "error", "stopped"].includes(entry.process.status);
      }
      if (!this.#stillUnwatched(entry)) return undefined;
      if (!settled) {
        this.#scheduleIdleIfNeeded(entry);
        return undefined;
      }
    }
    const threadId = entry.key;
    this.#entries.delete(threadId);
    entry.unsubscribe();
    this.#idleHooks?.stopping(threadId, entry.process);
    return { stopping: this.#startStop(threadId, entry.process) };
  }

  /**
   * Starts a stop of a thread's process and records it while it is under way. A stop that fails leaves the process
   * recorded as stuck, so the next wait for the thread tries its stop again (see `whenGone`).
   */
  #startStop(threadId: ThreadId, process: OmpProcess): Promise<void> {
    const stopping: Promise<void> = process.stop().then(
      () => {
        if (this.#stopping.get(threadId) === stopping) this.#stopping.delete(threadId);
        if (this.#stuck.get(threadId) === process) this.#stuck.delete(threadId);
      },
      (error: unknown) => {
        console.error("[omp-app] could not stop an omp process", error);
        if (this.#stopping.get(threadId) === stopping) this.#stopping.delete(threadId);
        this.#stuck.set(threadId, process);
        throw error;
      },
    );
    // A failed stop is not an unhandled rejection: whoever waits for it hears of the failure through `#finishedWithin`.
    stopping.catch(() => undefined);
    this.#stopping.set(threadId, stopping);
    return stopping;
  }

  /** Starts another stop of a process whose stop failed; undefined when the thread has none stuck. */
  #retryStuck(threadId: ThreadId): Promise<void> | undefined {
    const process = this.#stuck.get(threadId);
    return process === undefined ? undefined : this.#startStop(threadId, process);
  }
}

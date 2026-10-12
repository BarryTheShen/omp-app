import { describe, expect, test } from "bun:test";
import {
  AppFailure,
  FolderPath,
  type OmpProcessId,
  OmpProcessId as OmpProcessIdSchema,
  ThreadId,
} from "@omp-app/contracts";
import type { RpcSessionTimer } from "@omp-app/omp-rpc";
import {
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessOptions,
  OmpProcessRegistry,
} from "./index";

class ManualTimer implements RpcSessionTimer {
  #nextId = 0;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(handler: () => void, _delayMs: number): number {
    const id = ++this.#nextId;
    this.callbacks.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

class StubProcess implements OmpProcess {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly processId: OmpProcessId = OmpProcessIdSchema.parse("process-stub");
  readonly writes: string[] = [];
  status: OmpProcessEvent["status"] = "running";
  pid = 1234;
  stderrTail = "";
  startCalls = 0;
  restartCalls = 0;
  stopCalls = 0;
  #eventListeners = new Set<(event: OmpProcessEvent) => void>();
  #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  #closeListeners = new Set<(cause?: unknown) => void>();

  constructor(options: OmpProcessOptions) {
    this.threadId = options.threadId;
    this.folder = options.folder;
  }

  start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  restart(): Promise<void> {
    this.restartCalls += 1;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    this.status = "stopped";
    this.emit({ status: "stopped", processId: this.processId });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.stop();
  }

  writeLine(line: string): Promise<void> {
    this.writes.push(line);
    return Promise.resolve();
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    return () => this.#chunkListeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onEvent(listener: (event: OmpProcessEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  emit(event: OmpProcessEvent): void {
    this.status = event.status;
    for (const listener of [...this.#eventListeners]) listener(event);
  }

  emitClose(cause?: unknown): void {
    for (const listener of [...this.#closeListeners]) listener(cause);
  }
}

function options(thread: string, folder: string): OmpProcessOptions {
  return {
    threadId: ThreadId.parse(thread),
    folder: FolderPath.parse(folder),
    ompBin: "stub",
  };
}
function createdAt(created: StubProcess[], index: number): StubProcess {
  const process = created[index];
  if (process === undefined) throw new Error(`missing stub ${index}`);
  return process;
}

describe("OmpProcessRegistry", () => {
  test("keeps one process per thread and rejects a folder conflict", () => {
    const timer = new ManualTimer();
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      timer,
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const firstOptions = options("thread-1", "/workspace/one");
    const first = registry.acquire(firstOptions);
    const second = registry.acquire(firstOptions);

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(() => registry.acquire(options("thread-1", "/workspace/two"))).toThrow();
    registry.release(firstOptions.threadId);
    registry.release(firstOptions.threadId);
    expect(timer.callbacks.size).toBe(1);
  });

  test("busy threads survive idle close and are closed after becoming idle", async () => {
    const timer = new ManualTimer();
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      timer,
      idleCloseMs: 10,
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-2");
    registry.acquire(options(thread, "/workspace/two"));
    const process = createdAt(created, 0);
    registry.release(thread);
    registry.setBusy(thread, true);
    timer.fireAll();
    expect(process.stopCalls).toBe(0);
    expect(registry.has(thread)).toBe(true);

    registry.setBusy(thread, false);
    timer.fireAll();
    await Promise.resolve();
    expect(process.stopCalls).toBe(1);
    expect(registry.has(thread)).toBe(false);
    expect(created).toHaveLength(1);
  });

  test("reports each change of the busy mark once, and an exit ends the turn without an idle close", () => {
    const timer = new ManualTimer();
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      timer,
      idleCloseMs: 10,
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-5");
    expect(registry.busyOf(thread)).toBeUndefined();
    registry.acquire(options(thread, "/workspace/five"));
    const process = createdAt(created, 0);
    const heard: boolean[] = [];
    const stop = registry.onBusyChange((_threadId, busy) => heard.push(busy));

    expect(registry.busyOf(thread)).toBe(false);
    registry.setBusy(thread, true);
    registry.setBusy(thread, true);
    expect(registry.busyOf(thread)).toBe(true);
    expect(heard).toEqual([true]);

    process.emit({ status: "exited", processId: process.processId });
    expect(registry.busyOf(thread)).toBe(false);
    expect(heard).toEqual([true, false]);
    // The crashed process stays registered for a restart, and no idle close is scheduled for it.
    expect(registry.has(thread)).toBe(true);
    timer.fireAll();
    expect(process.stopCalls).toBe(0);

    stop();
    registry.setBusy(thread, true);
    expect(heard).toEqual([true, false]);
  });

  test("forgets an intentionally stopped process but retains a crashed one for restart", async () => {
    const timer = new ManualTimer();
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      timer,
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-3");
    registry.acquire(options(thread, "/workspace/three"));
    const process = createdAt(created, 0);
    expect(registry.has(thread)).toBe(true);
    await registry.restart(thread);
    expect(process.restartCalls).toBe(1);

    process.emit({ status: "stopped", processId: process.processId });
    expect(registry.has(thread)).toBe(false);
    const replacement = registry.acquire(options(thread, "/workspace/three"));
    expect(replacement).not.toBe(process);
    expect(created).toHaveLength(2);
  });

  test("respawn replaces a crashed process with one built from new arguments and keeps the thread's viewers", async () => {
    const created: StubProcess[] = [];
    const requested: OmpProcessOptions[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => {
        requested.push(processOptions);
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-respawn");
    registry.acquire(options(thread, "/workspace/respawn"));
    registry.acquire(options(thread, "/workspace/respawn"));
    const dead = createdAt(created, 0);
    dead.emit({ status: "exited", processId: dead.processId });
    expect(registry.has(thread)).toBe(true);

    const replacement = await registry.respawn({
      ...options(thread, "/workspace/respawn"),
      args: ["--resume", "/workspace/respawn/.omp/chat.jsonl"],
    });

    expect(replacement).not.toBe(dead);
    expect(requested.at(-1)?.args).toEqual(["--resume", "/workspace/respawn/.omp/chat.jsonl"]);
    expect(dead.stopCalls).toBe(1);
    // Stopping the dead process did not make the registry forget the thread.
    expect(registry.has(thread)).toBe(true);
    expect(registry.get(thread)).toBe(replacement);
    // Both viewers are still counted: one release does not start the idle timer.
    registry.release(thread);
    expect(registry.has(thread)).toBe(true);
  });

  test("respawn ends a turn the replaced process was still running", async () => {
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-respawn-busy");
    registry.acquire(options(thread, "/workspace/respawn-busy"));
    const heard: boolean[] = [];
    registry.onBusyChange((_threadId, busy) => heard.push(busy));
    registry.setBusy(thread, true);

    await registry.respawn(options(thread, "/workspace/respawn-busy"));

    expect(registry.busyOf(thread)).toBe(false);
    expect(heard).toEqual([true, false]);
  });

  test("a respawned process that is stopped on purpose is forgotten like any other", async () => {
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-respawn-stop");
    registry.acquire(options(thread, "/workspace/respawn-stop"));
    await registry.respawn(options(thread, "/workspace/respawn-stop"));
    const replacement = createdAt(created, 1);

    replacement.emit({ status: "stopped", processId: replacement.processId });

    expect(registry.has(thread)).toBe(false);
  });

  test("respawn refuses a thread nobody registered", async () => {
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => new StubProcess(processOptions),
    });

    await expect(
      registry.respawn(options("thread-unknown", "/workspace/unknown")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
  });

  test("rekeys a provisional process to omp's authoritative ThreadId", () => {
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const provisional = ThreadId.parse("provisional");
    const authoritative = ThreadId.parse("omp-session-1");
    registry.acquire(options(provisional, "/workspace/rekey"));
    const process = createdAt(created, 0);

    expect(registry.rekey(provisional, authoritative)).toBe(process);
    expect(registry.get(provisional)).toBeUndefined();
    expect(registry.get(authoritative)).toBe(process);
    process.emit({ status: "stopped", processId: process.processId });
    expect(registry.has(authoritative)).toBe(false);
  });

  test("closeAll stops every process and clears the registry", async () => {
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    registry.acquire(options("thread-4", "/workspace/four"));
    registry.acquire(options("thread-5", "/workspace/five"));
    await registry.closeAll();

    expect(createdAt(created, 0).stopCalls).toBe(1);
    expect(createdAt(created, 1).stopCalls).toBe(1);
    expect(created).toHaveLength(2);
    expect(registry.has(ThreadId.parse("thread-4"))).toBe(false);
    expect(registry.has(ThreadId.parse("thread-5"))).toBe(false);
  });

  describe("idle hooks", () => {
    function registryWith(timer: ManualTimer, created: StubProcess[]): OmpProcessRegistry {
      return new OmpProcessRegistry({
        timer,
        idleCloseMs: 10,
        createProcess: (processOptions) => {
          const process = new StubProcess(processOptions);
          created.push(process);
          return process;
        },
      });
    }

    test("stops an unwatched thread only once the owner says it is settled, and tells the owner", async () => {
      const timer = new ManualTimer();
      const created: StubProcess[] = [];
      const registry = registryWith(timer, created);
      let settled = false;
      const asked: ThreadId[] = [];
      const told: Array<{ thread: ThreadId; process: OmpProcess }> = [];
      registry.setIdleHooks({
        isSettled: async (thread) => {
          asked.push(thread);
          return settled;
        },
        stopping: (thread, process) => {
          told.push({ thread, process });
        },
      });
      const thread = ThreadId.parse("thread-working");
      registry.acquire(options(thread, "/workspace/working"));
      const process = createdAt(created, 0);
      registry.release(thread);

      timer.fireAll();
      await Bun.sleep(0);
      expect(asked).toEqual([thread]);
      expect(process.stopCalls).toBe(0);
      expect(registry.has(thread)).toBe(true);
      // It asks again after another idle period instead of giving up on the thread.
      expect(timer.callbacks.size).toBe(1);

      settled = true;
      timer.fireAll();
      await Bun.sleep(0);
      expect(process.stopCalls).toBe(1);
      expect(registry.has(thread)).toBe(false);
      expect(told).toEqual([{ thread, process }]);
    });

    test("a viewer who arrives while omp is being asked keeps the process", async () => {
      const timer = new ManualTimer();
      const created: StubProcess[] = [];
      const registry = registryWith(timer, created);
      const answer = Promise.withResolvers<boolean>();
      const told: ThreadId[] = [];
      registry.setIdleHooks({
        isSettled: () => answer.promise,
        stopping: (thread) => {
          told.push(thread);
        },
      });
      const thread = ThreadId.parse("thread-returns");
      registry.acquire(options(thread, "/workspace/returns"));
      registry.release(thread);
      timer.fireAll();

      registry.acquire(options(thread, "/workspace/returns"));
      answer.resolve(true);
      await Bun.sleep(0);
      expect(createdAt(created, 0).stopCalls).toBe(0);
      expect(registry.has(thread)).toBe(true);
      expect(told).toEqual([]);
    });

    test("an unanswered check keeps a running process but not one that already exited", async () => {
      const timer = new ManualTimer();
      const created: StubProcess[] = [];
      const registry = registryWith(timer, created);
      registry.setIdleHooks({
        isSettled: async () => {
          throw new Error("omp did not answer");
        },
        stopping: () => undefined,
      });
      const thread = ThreadId.parse("thread-silent");
      registry.acquire(options(thread, "/workspace/silent"));
      const process = createdAt(created, 0);
      registry.release(thread);

      timer.fireAll();
      await Bun.sleep(0);
      expect(process.stopCalls).toBe(0);
      expect(timer.callbacks.size).toBe(1);

      process.emit({ status: "exited", processId: process.processId });
      timer.fireAll();
      await Bun.sleep(0);
      expect(process.stopCalls).toBe(1);
      expect(registry.has(thread)).toBe(false);
    });

    test("whenGone resolves only after the process the registry stopped has exited", async () => {
      const timer = new ManualTimer();
      const created: StubProcess[] = [];
      const registry = registryWith(timer, created);
      registry.setIdleHooks({ isSettled: async () => true, stopping: () => undefined });
      const thread = ThreadId.parse("thread-exiting");
      expect(await registry.whenGone(thread, "opened")).toBeUndefined();

      registry.acquire(options(thread, "/workspace/exiting"));
      const process = createdAt(created, 0);
      const exit = Promise.withResolvers<void>();
      process.stop = () => exit.promise;
      registry.release(thread);
      timer.fireAll();
      await Bun.sleep(0);

      let waited = false;
      const waiting = registry.whenGone(thread, "opened").then(() => {
        waited = true;
      });
      await Bun.sleep(0);
      expect(waited).toBe(false);
      exit.resolve();
      await waiting;
      expect(waited).toBe(true);
    });
  });

  test("stopIfUnwatched stops an unwatched process at once and leaves a watched one running", async () => {
    const timer = new ManualTimer();
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      timer,
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const watchedOptions = options("thread-watched", "/workspace/one");
    const hostOptions = options("thread-host", "/workspace/one");
    registry.acquire(watchedOptions);
    registry.acquire(hostOptions);
    registry.release(hostOptions.threadId);

    await registry.stopIfUnwatched(watchedOptions.threadId, "renamed");
    expect(createdAt(created, 0).stopCalls).toBe(0);
    expect(registry.has(watchedOptions.threadId)).toBe(true);

    await registry.stopIfUnwatched(hostOptions.threadId, "renamed");
    expect(createdAt(created, 1).stopCalls).toBe(1);
    expect(registry.has(hostOptions.threadId)).toBe(false);
    expect(timer.callbacks.size).toBe(0);
  });

  test("stopIfUnwatched waits for an exit already under way, even when the registry has forgotten the thread", async () => {
    const timer = new ManualTimer();
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      timer,
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const thread = ThreadId.parse("thread-exit-under-way");
    registry.acquire(options(thread, "/workspace/exit-under-way"));
    const process = createdAt(created, 0);
    const exit = Promise.withResolvers<void>();
    process.stop = () => exit.promise;
    registry.release(thread);

    // The first call starts the stop: the registry forgets the thread at once, and omp exits later.
    const earlier = registry.stopIfUnwatched(thread, "renamed");
    let waited = false;
    const waiting = registry.stopIfUnwatched(thread, "renamed").then(() => {
      waited = true;
    });
    // Queued promise callbacks run before the exit; no clock is involved.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(waited).toBe(false);

    exit.resolve();
    await earlier;
    await waiting;
    expect(waited).toBe(true);
  });

  describe("stopIfUnwatched for a delete", () => {
    /** A timer that also keeps the delay of each timeout it is given, so a test can check how long a wait may last. */
    class DelayTimer extends ManualTimer {
      readonly delays: number[] = [];

      override setTimeout(handler: () => void, delayMs: number): number {
        this.delays.push(delayMs);
        return super.setTimeout(handler, delayMs);
      }
    }

    function registryFor(timer: DelayTimer, created: StubProcess[]): OmpProcessRegistry {
      return new OmpProcessRegistry({
        timer,
        idleCloseMs: 60_000,
        createProcess: (processOptions) => {
          const process = new StubProcess(processOptions);
          created.push(process);
          return process;
        },
      });
    }

    /** What the call refused with, or undefined when it resolved. */
    function refusalOf(promise: Promise<void>): Promise<unknown> {
      return promise.then(
        () => undefined,
        (failure: unknown) => failure,
      );
    }

    test("refuses when the stop fails, and keeps refusing until a stop shows omp gone", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-stop-fails");
      registry.acquire(options(thread, "/workspace/stop-fails"));
      createdAt(created, 0).stop = () => Promise.reject(new Error("omp could not be signalled"));
      registry.release(thread);

      const failure = await refusalOf(registry.stopIfUnwatched(thread, "deleted"));

      expect(failure).toBeInstanceOf(AppFailure);
      expect(failure).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
        },
      });
      // The next attempt tries the stop again; it fails too, so it refuses as well.
      expect(await refusalOf(registry.stopIfUnwatched(thread, "deleted"))).toMatchObject({
        appError: { code: "conflict" },
      });
    });

    test("refuses a stop that does not finish within about ten seconds", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-stop-hangs");
      registry.acquire(options(thread, "/workspace/stop-hangs"));
      createdAt(created, 0).stop = () => new Promise<void>(() => undefined);
      registry.release(thread);

      let outcome: unknown = "waiting";
      const stopping = refusalOf(registry.stopIfUnwatched(thread, "deleted")).then((failure) => {
        outcome = failure ?? "stopped";
      });
      await Bun.sleep(0);
      expect(outcome).toBe("waiting");
      // The wait is bounded by its own timeout: the last timeout set is the limit, about ten seconds.
      expect(timer.delays.at(-1)).toBe(10_000);

      timer.fireAll();
      await stopping;
      expect(outcome).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
        },
      });
      // The refusal holds until a stop shows omp gone: a second wait is refused too, once its limit passes.
      const again = refusalOf(registry.stopIfUnwatched(thread, "deleted"));
      timer.fireAll();
      expect(await again).toMatchObject({ appError: { code: "conflict" } });
    });

    test("resolves once a stop that finishes in time has finished, and forgets the process", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-stop-in-time");
      registry.acquire(options(thread, "/workspace/stop-in-time"));
      registry.release(thread);

      await registry.stopIfUnwatched(thread, "deleted");

      expect(createdAt(created, 0).stopCalls).toBe(1);
      expect(registry.has(thread)).toBe(false);
      expect(timer.callbacks.size).toBe(0);
    });

    test("a stop that failed is tried again by the next attempt, and clears once a stop works", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-stop-retried");
      registry.acquire(options(thread, "/workspace/stop-retried"));
      let attempts = 0;
      createdAt(created, 0).stop = () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("omp could not be signalled"))
          : Promise.resolve();
      };
      registry.release(thread);

      expect(await refusalOf(registry.stopIfUnwatched(thread, "deleted"))).toMatchObject({
        appError: { code: "conflict" },
      });
      expect(attempts).toBe(1);

      // The next attempt tries the stop again, and this time omp is gone.
      await registry.stopIfUnwatched(thread, "deleted");
      expect(attempts).toBe(2);
    });

    test("opening a chat whose old omp does not stop in time is refused, and nothing waits for ever", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-open-hangs");
      registry.acquire(options(thread, "/workspace/open-hangs"));
      createdAt(created, 0).stop = () => new Promise<void>(() => undefined);
      registry.release(thread);
      void registry.stopIfUnwatched(thread, "deleted").catch(() => undefined);
      await Bun.sleep(0);
      // Opening waits for the stop, up to the same limit, and then refuses.
      const opening = refusalOf(registry.whenGone(thread, "opened"));
      expect(timer.delays.at(-1)).toBe(10_000);
      timer.fireAll();
      expect(await opening).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not opened. Try again in a moment.",
        },
      });
    });
  });
  test("watched reports whether a viewer holds the thread, not whether the registry holds its process", () => {
    const registry = new OmpProcessRegistry({
      timer: new ManualTimer(),
      createProcess: (processOptions) => new StubProcess(processOptions),
    });
    const thread = ThreadId.parse("thread-watched-flag");
    expect(registry.watched(thread)).toBe(false);

    registry.acquire(options(thread, "/workspace/watched-flag"));
    expect(registry.watched(thread)).toBe(true);

    registry.release(thread);
    expect(registry.has(thread)).toBe(true);
    expect(registry.watched(thread)).toBe(false);
  });
});

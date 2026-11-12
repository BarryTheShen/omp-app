import { describe, expect, test } from "bun:test";
import {
  AppFailure,
  FolderPath,
  type OmpProcessId,
  OmpProcessId as OmpProcessIdSchema,
  ThreadId,
} from "@omp-app/contracts";
import type { ProcessTimer } from "./index";
import {
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessOptions,
  OmpProcessRegistry,
} from "./index";

class ManualTimer implements ProcessTimer {
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

/** A timer on a clock the test moves: a callback runs once the clock reaches the time it was set for. */
class ClockTimer implements ProcessTimer {
  #nextId = 0;
  #now = 0;
  readonly #due = new Map<number, { readonly at: number; readonly handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): number {
    const id = ++this.#nextId;
    this.#due.set(id, { at: this.#now + delayMs, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#due.delete(handle);
  }

  advance(ms: number): void {
    this.#now += ms;
    for (const [id, { at, handler }] of [...this.#due]) {
      if (at > this.#now) continue;
      this.#due.delete(id);
      handler();
    }
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

  test("reports busy changes after the registry updates state and exposes the process folder", () => {
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
    const thread = ThreadId.parse("thread-folder");
    expect(registry.folderOf(thread)).toBeUndefined();
    registry.acquire(options(thread, "/workspace/folder"));
    expect(registry.folderOf(thread)).toBe("/workspace/folder");
    const statesAtNotification: Array<boolean | undefined> = [];
    registry.onBusyChange((id, _busy) => statesAtNotification.push(registry.busyOf(id)));

    registry.setBusy(thread, true);

    expect(statesAtNotification).toEqual([true]);
  });

  test("says each time a thread's process is held or let go, and lists the held ones in every folder with what each does (D1)", async () => {
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
    let heard = 0;
    registry.onHeldChange(() => {
      heard += 1;
    });
    const one = ThreadId.parse("thread-held-1");
    const two = ThreadId.parse("thread-held-2");
    registry.acquire(options(one, "/workspace/one"));
    // A second viewer holds no second process.
    registry.acquire(options(one, "/workspace/one"));
    expect(heard).toBe(1);
    registry.acquire(options(two, "/workspace/two"));
    registry.setBusy(two, true);
    registry.setPaused(one, 1_700_000_000_000);
    expect(registry.held()).toEqual([
      { threadId: one, folder: "/workspace/one", busy: false, pausedAt: 1_700_000_000_000 },
      { threadId: two, folder: "/workspace/two", busy: true, pausedAt: null },
    ]);
    expect(heard).toBe(2);

    // A process that stops is let go.
    await createdAt(created, 0).stop();
    expect(registry.held().map((chat) => chat.threadId)).toEqual([two]);
    expect(heard).toBe(3);
    // A rekey lets the thread go under its first id and holds it under omp's own.
    const moved = ThreadId.parse("thread-held-3");
    registry.rekey(two, moved);
    expect(registry.held().map((chat) => chat.threadId)).toEqual([moved]);
    expect(heard).toBe(5);
    await registry.closeAll();
    expect(registry.held()).toEqual([]);
    expect(heard).toBe(6);
  });

  test("a stop on request ends a process only its asker watches, without waiting for omp to settle; another watcher or a command refuses it, and a turn ends with it (D1)", async () => {
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
    // omp never says it is settled: an idle stop would never come.
    registry.setIdleHooks({ isSettled: async () => false, stopped: () => undefined });
    const thread = ThreadId.parse("thread-stop");
    registry.acquire(options(thread, "/workspace/stop"));
    registry.acquire(options(thread, "/workspace/stop"));
    // The asker has one view; the other is another tab's.
    await expect(registry.stop(thread, 1)).rejects.toThrow("busy");
    registry.release(thread);
    // A command under way (a rename) holds it too.
    const done = registry.holdCommand(thread);
    await expect(registry.stop(thread, 1)).rejects.toThrow("busy");
    done();
    expect(createdAt(created, 0).stopCalls).toBe(0);

    const turns: boolean[] = [];
    registry.onBusyChange((_id, busy) => turns.push(busy));
    registry.setBusy(thread, true);
    await registry.stop(thread, 1);
    expect(turns).toEqual([true, false]);
    expect(createdAt(created, 0).stopCalls).toBe(1);
    expect(registry.has(thread)).toBe(false);
    // A thread with no process here has nothing to stop.
    await registry.stop(ThreadId.parse("thread-none"));
  });

  test("a throwing busy listener cannot prevent other listeners or change the registry state", () => {
    const timer = new ManualTimer();
    const registry = new OmpProcessRegistry({
      timer,
      idleCloseMs: 10,
      createProcess: (processOptions) => new StubProcess(processOptions),
    });
    const thread = ThreadId.parse("thread-listener-throws");
    registry.acquire(options(thread, "/workspace/listener"));
    const heard: boolean[] = [];
    registry.onBusyChange(() => {
      throw new Error("listener failed");
    });
    registry.onBusyChange((_id, busy) => heard.push(busy));

    expect(() => registry.setBusy(thread, true)).not.toThrow();
    expect(registry.busyOf(thread)).toBe(true);
    expect(heard).toEqual([true]);
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

  test("lists the busy threads of one folder, and no idle thread or thread of another folder", () => {
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
    const busy = ThreadId.parse("thread-busy");
    const idle = ThreadId.parse("thread-idle");
    const elsewhere = ThreadId.parse("thread-elsewhere");
    registry.acquire(options(busy, "/workspace/one"));
    registry.acquire(options(idle, "/workspace/one"));
    registry.acquire(options(elsewhere, "/workspace/two"));
    registry.setBusy(busy, true);
    registry.setBusy(elsewhere, true);

    expect(registry.busyIn("/workspace/one")).toEqual([busy]);
    expect(registry.busyIn("/workspace/two")).toEqual([elsewhere]);
    expect(registry.busyIn("/workspace/three")).toEqual([]);
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

  test("keeps each thread's pause with its folder, lists the paused ones by folder, and an exit clears it", () => {
    const created: StubProcess[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => {
        const process = new StubProcess(processOptions);
        created.push(process);
        return process;
      },
    });
    const one = ThreadId.parse("thread-paused-one");
    const two = ThreadId.parse("thread-paused-two");
    registry.acquire(options(one, "/workspace/paused"));
    registry.acquire(options(two, "/workspace/paused"));
    const heard: string[] = [];
    registry.onPauseChange((id, folder, pausedAt) => heard.push(`${id} ${folder} ${pausedAt}`));

    registry.setPaused(one, 1_000);
    registry.setPaused(one, 1_000);
    registry.setPaused(two, 2_000);
    expect(registry.pausedIn("/workspace/paused")).toEqual([
      { id: one, pausedAt: 1_000 },
      { id: two, pausedAt: 2_000 },
    ]);
    expect(registry.pausedIn("/workspace/other")).toEqual([]);

    registry.setPaused(two, null);
    // omp's pause gate lives in its process: one that exits is no longer paused.
    const process = createdAt(created, 0);
    process.emit({ status: "exited", processId: process.processId });
    expect(registry.pausedIn("/workspace/paused")).toEqual([]);
    expect(heard).toEqual([
      `${one} /workspace/paused 1000`,
      `${two} /workspace/paused 2000`,
      `${two} /workspace/paused null`,
      `${one} /workspace/paused null`,
    ]);
  });

  test("a paused thread that is stopped is heard as no longer paused, with its folder", async () => {
    const registry = new OmpProcessRegistry({
      timer: new ManualTimer(),
      createProcess: (processOptions) => new StubProcess(processOptions),
    });
    const thread = ThreadId.parse("thread-paused-stop");
    registry.acquire(options(thread, "/workspace/paused-stop"));
    registry.setPaused(thread, 3_000);
    const heard: Array<[string, number | null]> = [];
    registry.onPauseChange((_threadId, folder, pausedAt) => heard.push([folder, pausedAt]));

    registry.release(thread);
    await registry.stopIfUnwatched(thread, "deleted");

    expect(registry.has(thread)).toBe(false);
    expect(heard).toEqual([["/workspace/paused-stop", null]]);
  });

  test("respawn ends a pause: the new process starts unpaused", async () => {
    const registry = new OmpProcessRegistry({
      createProcess: (processOptions) => new StubProcess(processOptions),
    });
    const thread = ThreadId.parse("thread-respawn-paused");
    registry.acquire(options(thread, "/workspace/respawn-paused"));
    registry.setPaused(thread, 4_000);

    await registry.respawn(options(thread, "/workspace/respawn-paused"));

    expect(registry.pausedIn("/workspace/respawn-paused")).toEqual([]);
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

  test("a running `!` command keeps its process up with no viewer, and the idle close waits for the command to end", async () => {
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
    registry.acquire(options("thread-5", "/workspace/five"));
    const process = createdAt(created, 0);
    registry.release(thread);
    const endCommand = registry.holdCommand(thread);
    timer.fireAll();
    await Promise.resolve();
    expect(process.stopCalls).toBe(0);
    expect(registry.has(thread)).toBe(true);

    endCommand();
    timer.fireAll();
    await Promise.resolve();
    expect(process.stopCalls).toBe(1);
    expect(registry.has(thread)).toBe(false);
  });

  test("a command's hold still ends its process after a rekey to omp's session id, and a second release changes nothing", async () => {
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
    registry.acquire(options("thread-6", "/workspace/six"));
    const process = createdAt(created, 0);
    const provisional = ThreadId.parse("thread-6");
    registry.release(provisional);
    const endCommand = registry.holdCommand(provisional);
    registry.rekey(provisional, ThreadId.parse("thread-7"));
    endCommand();
    endCommand();
    timer.fireAll();
    await Promise.resolve();
    expect(process.stopCalls).toBe(1);
    expect(registry.has(ThreadId.parse("thread-7"))).toBe(false);
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
        stopped: (thread, process) => {
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
        stopped: (thread) => {
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
        stopped: () => undefined,
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
      registry.setIdleHooks({ isSettled: async () => true, stopped: () => undefined });
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

  test("a chat nobody views keeps its omp for a day, not an hour, so coming back to it starts nothing (#2768)", async () => {
    const timer = new ClockTimer();
    const registry = new OmpProcessRegistry({
      timer,
      createProcess: (processOptions) => new StubProcess(processOptions),
    });
    registry.setIdleHooks({ isSettled: async () => true, stopped: () => undefined });
    const thread = ThreadId.parse("thread-left");
    registry.acquire(options(thread, "/workspace/left"));
    registry.release(thread);
    const hour = 60 * 60 * 1000;

    timer.advance(2 * hour);
    await Bun.sleep(0);
    expect(registry.has(thread)).toBe(true);

    timer.advance(22 * hour);
    await Bun.sleep(0);
    expect(registry.has(thread)).toBe(false);
  });

  describe("a chat that never got a message", () => {
    const second = 1000;
    const minute = 60 * second;
    /** The chats that have history; a thread kept ready (`provisional-…`) is never named unused, as the server wires it. */
    function viewed(idleCloseMs: number, withFile: readonly string[] = []) {
      const timer = new ClockTimer();
      const registry = new OmpProcessRegistry({
        timer,
        idleCloseMs,
        isUnused: (thread) => !thread.startsWith("provisional-") && !withFile.includes(thread),
        createProcess: (processOptions) => new StubProcess(processOptions),
      });
      registry.setIdleHooks({ isSettled: async () => true, stopped: () => undefined });
      return { timer, registry };
    }
    const leave = (registry: OmpProcessRegistry, name: string): ThreadId => {
      const thread = ThreadId.parse(name);
      registry.acquire(options(name, "/workspace/passing"));
      registry.release(thread);
      return thread;
    };

    test("is stopped 30 seconds after it was left, not after a day", async () => {
      const { timer, registry } = viewed(24 * 60 * minute);
      const thread = leave(registry, "thread-never-written");

      timer.advance(29 * second);
      await Bun.sleep(0);
      expect(registry.has(thread)).toBe(true);

      timer.advance(second);
      await Bun.sleep(0);
      expect(registry.has(thread)).toBe(false);
    });

    test("one with history waits the idle close, and one kept ready is never stopped by this rule", async () => {
      const { timer, registry } = viewed(60 * minute, ["thread-with-history"]);
      const written = leave(registry, "thread-with-history");
      const spare = leave(registry, "provisional-spare");

      timer.advance(59 * minute);
      await Bun.sleep(0);
      expect(registry.has(written)).toBe(true);
      expect(registry.has(spare)).toBe(true);

      timer.advance(minute);
      await Bun.sleep(0);
      expect(registry.has(written)).toBe(false);
      expect(registry.has(spare)).toBe(false);
    });

    test("is not stopped while it is watched, and its 30 seconds start when it is left again", async () => {
      const { timer, registry } = viewed(24 * 60 * minute);
      const thread = leave(registry, "thread-came-back");

      timer.advance(20 * second);
      registry.acquire(options("thread-came-back", "/workspace/passing"));
      timer.advance(10 * minute);
      await Bun.sleep(0);
      expect(registry.has(thread)).toBe(true);

      registry.release(thread);
      timer.advance(29 * second);
      await Bun.sleep(0);
      expect(registry.has(thread)).toBe(true);
      timer.advance(second);
      await Bun.sleep(0);
      expect(registry.has(thread)).toBe(false);
    });

    test("waits no longer than the idle close when that is shorter than 30 seconds", async () => {
      const { timer, registry } = viewed(10 * second);
      const thread = leave(registry, "thread-short-close");

      timer.advance(10 * second);
      await Bun.sleep(0);
      expect(registry.has(thread)).toBe(false);
    });
  });

  describe("the cap on unwatched threads", () => {
    function capped(timer: ManualTimer, created: StubProcess[]): OmpProcessRegistry {
      return new OmpProcessRegistry({
        timer,
        idleCloseMs: 60_000,
        maxIdle: 2,
        createProcess: (processOptions) => {
          const process = new StubProcess(processOptions);
          created.push(process);
          return process;
        },
      });
    }
    const threads = ["thread-a", "thread-b", "thread-c"].map((id) => ThreadId.parse(id));

    test("past the cap the thread left unwatched longest stops at once; one viewed again loses its place", async () => {
      const timer = new ManualTimer();
      const created: StubProcess[] = [];
      const registry = capped(timer, created);
      const [a, b, c] = threads as [ThreadId, ThreadId, ThreadId];
      for (const thread of threads) registry.acquire(options(thread, "/workspace/cap"));
      registry.release(a);
      registry.release(b);
      // a is viewed again and left again, so b is now the one left unwatched longest.
      registry.acquire(options(a, "/workspace/cap"));
      registry.release(a);
      registry.release(c);
      // With no idle hooks the stop starts at once, inside the release.

      expect(created.map((process) => process.stopCalls)).toEqual([0, 1, 0]);
      expect(threads.map((thread) => registry.has(thread))).toEqual([true, false, true]);
    });

    test("a thread omp says is not settled stays past the cap, and that trim asks it only once", async () => {
      const timer = new ManualTimer();
      const created: StubProcess[] = [];
      const registry = capped(timer, created);
      const [a] = threads as [ThreadId, ThreadId, ThreadId];
      const asked: ThreadId[] = [];
      registry.setIdleHooks({
        isSettled: async (thread) => {
          asked.push(thread);
          return thread !== a;
        },
        stopped: () => undefined,
      });
      for (const thread of threads) registry.acquire(options(thread, "/workspace/cap"));
      for (const thread of threads) registry.release(thread);
      await Bun.sleep(0);

      expect(asked).toEqual([a]);
      expect(created.map((process) => process.stopCalls)).toEqual([0, 0, 0]);
      // It keeps an idle timer of its own, so the hour still applies to it.
      expect(timer.callbacks.size).toBe(3);
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

    test("a viewer that lets go while omp stops does not come back as a watcher when that stop fails", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-release-mid-stop");
      registry.acquire(options(thread, "/workspace/release-mid-stop"));
      const stopping = Promise.withResolvers<void>();
      createdAt(created, 0).stop = () => stopping.promise;

      const outcome = refusalOf(registry.stopIfUnwatched(thread, "deleted", 1));
      for (let turn = 0; turn < 20 && !registry.isStopping(thread); turn += 1) await Bun.sleep(0);
      expect(registry.isStopping(thread)).toBe(true);

      // The viewer that asked the delete lets go while omp is still stopping, then the stop fails.
      registry.release(thread);
      stopping.reject(new Error("omp could not be signalled"));

      expect(await outcome).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
        },
      });
      // Nobody watches the chat now, so the failed stop does not register it again with the watcher that let go.
      expect(registry.has(thread)).toBe(false);
      expect(registry.watcherCount(thread)).toBe(0);
      expect(registry.isStopping(thread)).toBe(true);
      expect(timer.callbacks.size).toBe(0);
    });

    test("the stopped hook is told once the stop has cleared its records, so the thread is no longer stopping then", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const seen: boolean[] = [];
      registry.setIdleHooks({
        isSettled: async () => true,
        stopped: (threadId) => {
          seen.push(registry.isStopping(threadId));
        },
      });
      const thread = ThreadId.parse("thread-stopped-hook");
      registry.acquire(options(thread, "/workspace/stopped-hook"));
      registry.release(thread);

      await registry.stopIfUnwatched(thread, "deleted");

      expect(seen).toEqual([false]);
      expect(registry.isStopping(thread)).toBe(false);
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

    test("counts the asking connection's own watcher as its own, so a chat only that connection watches is stopped", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-own-watcher");
      registry.acquire(options(thread, "/workspace/own-watcher"));

      await registry.stopIfUnwatched(thread, "deleted", 1);

      expect(createdAt(created, 0).stopCalls).toBe(1);
      expect(registry.has(thread)).toBe(false);
    });

    test("leaves a chat another watcher holds running, and keeps every watcher counted", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-other-watcher");
      registry.acquire(options(thread, "/workspace/other-watcher"));
      registry.acquire(options(thread, "/workspace/other-watcher"));

      await registry.stopIfUnwatched(thread, "deleted", 1);

      expect(createdAt(created, 0).stopCalls).toBe(0);
      expect(registry.has(thread)).toBe(true);
      expect(registry.watcherCount(thread)).toBe(2);
    });

    test("a stop that fails keeps a chat the asking connection still watches registered, with its process", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const thread = ThreadId.parse("thread-stop-keeps");
      const process = registry.acquire(options(thread, "/workspace/stop-keeps"));
      createdAt(created, 0).stop = () => Promise.reject(new Error("omp could not be signalled"));

      expect(await refusalOf(registry.stopIfUnwatched(thread, "deleted", 1))).toMatchObject({
        appError: { code: "conflict" },
      });
      expect(registry.has(thread)).toBe(true);
      expect(registry.watcherCount(thread)).toBe(1);
      // The watcher still has its chat: a later acquire shares the same process.
      expect(registry.acquire(options(thread, "/workspace/stop-keeps"))).toBe(process);
      expect(created).toHaveLength(1);
    });

    test("tells the holders of a thread only once omp has exited, not when its stop starts", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const told: ThreadId[] = [];
      registry.setIdleHooks({
        isSettled: async () => true,
        stopped: (thread) => {
          told.push(thread);
        },
      });
      const thread = ThreadId.parse("thread-told-late");
      registry.acquire(options(thread, "/workspace/told-late"));
      const exit = Promise.withResolvers<void>();
      const stopStarted = Promise.withResolvers<void>();
      createdAt(created, 0).stop = () => {
        stopStarted.resolve();
        return exit.promise;
      };
      registry.release(thread);

      const stopping = registry.stopIfUnwatched(thread, "deleted");
      await stopStarted.promise;
      expect(told).toEqual([]);

      exit.resolve();
      await stopping;
      expect(told).toEqual([thread]);
    });

    test("does not tell the holders of a thread that its stop failed to stop", async () => {
      const timer = new DelayTimer();
      const created: StubProcess[] = [];
      const registry = registryFor(timer, created);
      const told: ThreadId[] = [];
      registry.setIdleHooks({
        isSettled: async () => true,
        stopped: (thread) => {
          told.push(thread);
        },
      });
      const thread = ThreadId.parse("thread-stop-untold");
      registry.acquire(options(thread, "/workspace/stop-untold"));
      createdAt(created, 0).stop = () => Promise.reject(new Error("omp could not be signalled"));
      registry.release(thread);

      expect(await refusalOf(registry.stopIfUnwatched(thread, "deleted"))).toMatchObject({
        appError: { code: "conflict" },
      });
      expect(told).toEqual([]);
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
  test("watcherCount counts every viewer that holds the thread, and watched is that count above zero", () => {
    const registry = new OmpProcessRegistry({
      timer: new ManualTimer(),
      createProcess: (processOptions) => new StubProcess(processOptions),
    });
    const thread = ThreadId.parse("thread-watcher-count");
    expect(registry.watcherCount(thread)).toBe(0);

    registry.acquire(options(thread, "/workspace/watcher-count"));
    registry.acquire(options(thread, "/workspace/watcher-count"));
    expect(registry.watcherCount(thread)).toBe(2);
    expect(registry.watched(thread)).toBe(true);

    registry.release(thread);
    expect(registry.watcherCount(thread)).toBe(1);
    registry.release(thread);
    expect(registry.watcherCount(thread)).toBe(0);
    expect(registry.watched(thread)).toBe(false);
  });
});

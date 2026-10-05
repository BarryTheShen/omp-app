import { describe, expect, test } from "bun:test";
import {
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
});

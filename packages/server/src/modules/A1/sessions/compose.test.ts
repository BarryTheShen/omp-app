import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { FolderPath, OmpProcessId, ThreadId } from "@omp-app/contracts";
import {
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessOptions,
  OmpProcessRegistry,
} from "../../../process";
import type { A1PortContext } from "../ports/context";
import { createSessionFileStoreRegistration } from "../ports/session-file-store";
import { createServerSessionFileStore } from "./compose";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

/** A process that never spawns: the registry only needs its events and its stop. */
class StubProcess implements OmpProcess {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly processId = OmpProcessId.parse("process-stub");
  readonly writes: string[] = [];
  status: OmpProcessEvent["status"] = "running";
  pid = 1234;
  stderrTail = "";
  #eventListeners = new Set<(event: OmpProcessEvent) => void>();
  #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  #closeListeners = new Set<(cause?: unknown) => void>();

  constructor(options: OmpProcessOptions) {
    this.threadId = options.threadId;
    this.folder = options.folder;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  restart(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
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
}

async function makeTempRoot(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  return mkdtemp(path.join(WORKTREE_DATA, "session-compose-"));
}

async function writeSession(sessionFile: string, id: string, cwd: string): Promise<void> {
  const header = { type: "session", version: 3, id, timestamp: "2026-10-10T12:00:00.000Z", cwd };
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** A value a test settles later, so the order of two async steps is the test's choice. */
function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A timer that never fires: the idle close is not what these tests are about. */
function quietTimer() {
  return { setTimeout: () => undefined, clearTimeout: () => undefined };
}

/** The error a promise rejects with, or undefined when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
}

/** The first item of a list the test has already filled. */
function firstOf<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("the test expected a first item");
  return item;
}

/** A stub whose stop waits until the test lets it finish, so a viewer can arrive while omp is stopping. */
class SlowStopProcess extends StubProcess {
  readonly stopping = deferred();
  readonly finish = deferred();

  override stop(): Promise<void> {
    this.stopping.resolve();
    return this.finish.promise.then(() => super.stop());
  }
}

/** A registry whose processes are stubs, kept in the order they were created. */
function recordingRegistry(): {
  readonly chats: OmpProcessRegistry;
  readonly processes: StubProcess[];
} {
  const processes: StubProcess[] = [];
  const chats = new OmpProcessRegistry({
    timer: quietTimer(),
    createProcess: (options) => {
      const process = new StubProcess(options);
      processes.push(process);
      return process;
    },
  });
  return { chats, processes };
}

/** A registry whose processes stop only when the test lets them. */
function slowStopRegistry(): {
  readonly chats: OmpProcessRegistry;
  readonly processes: SlowStopProcess[];
} {
  const processes: SlowStopProcess[] = [];
  const chats = new OmpProcessRegistry({
    timer: quietTimer(),
    createProcess: (options) => {
      const process = new SlowStopProcess(options);
      processes.push(process);
      return process;
    },
  });
  return { chats, processes };
}

/** A chat in a store composed over `chats`: the store, the chat's file and the options that open it. */
async function chatFor(root: string, chats: OmpProcessRegistry, name: string) {
  const cwd = "/workspace/app";
  const store = createServerSessionFileStore({
    sessionsRoot: path.join(root, "sessions"),
    home: root,
    chats,
  });
  const file = path.join(store.bucketPath(cwd), `${name}.jsonl`);
  await writeSession(file, name, cwd);
  const threadId = ThreadId.parse(name);
  return {
    store,
    cwd,
    file,
    threadId,
    options: { threadId, folder: FolderPath.parse(cwd), ompBin: "stub" },
  };
}

/**
 * The store the server composes, with the server's real process registry as its chats. These tests go through the
 * composition, not an injected option, so they fail if `serverOwnsSession` is not wired.
 */
describe("the session store the server composes", () => {
  test("a chat a viewer still watches is refused with conflict, and its file stays", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const chats = new OmpProcessRegistry({
        createProcess: (options) => new StubProcess(options),
      });
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
      });
      const file = path.join(store.bucketPath(cwd), "open-idle.jsonl");
      await writeSession(file, "open-idle", cwd);
      chats.acquire({
        threadId: ThreadId.parse("open-idle"),
        folder: FolderPath.parse(cwd),
        ompBin: "stub",
      });

      const error = await store.deleteSession({ folder: cwd, sessionFile: file }).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(error).toMatchObject({ appError: { code: "conflict" } });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat the server does not hold is deleted through the same composition", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats: new OmpProcessRegistry({ createProcess: (options) => new StubProcess(options) }),
      });
      const file = path.join(store.bucketPath(cwd), "closed.jsonl");
      await writeSession(file, "closed", cwd);

      const result = await store.deleteSession({ folder: cwd, sessionFile: file });

      expect(result).toEqual({ id: "closed", sessionFile: file });
      expect(await exists(file)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the port refuses a chat the server holds open with the same conflict, and publishes nothing", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const chats = new OmpProcessRegistry({
        createProcess: (options) => new StubProcess(options),
      });
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
      });
      const file = path.join(store.bucketPath(cwd), "open-port.jsonl");
      await writeSession(file, "open-port", cwd);
      chats.acquire({
        threadId: ThreadId.parse("open-port"),
        folder: FolderPath.parse(cwd),
        ompBin: "stub",
      });
      const published: unknown[] = [];
      const context = {
        sessionFileStore: store,
        publish: (_stream: unknown, payload: unknown) => {
          published.push(payload);
          return undefined;
        },
        watchStreamActivity: () => () => undefined,
      } as unknown as A1PortContext;
      const handler = createSessionFileStoreRegistration(context).handlers.deleteSession;
      if (handler === undefined) throw new Error("the port has no deleteSession handler");

      await expect(
        handler({ folder: cwd, sessionFile: file }, {
          signal: new AbortController().signal,
        } as never),
      ).rejects.toMatchObject({ appError: { code: "conflict" } });

      expect(published).toEqual([]);
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat nobody watches is stopped first, then its file is deleted", async () => {
    const root = await makeTempRoot();
    try {
      const { chats, processes } = recordingRegistry();
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "unwatched");
      chats.acquire(options);
      chats.release(threadId);

      const result = await store.deleteSession({ folder: cwd, sessionFile: file });

      expect(result).toEqual({ id: "unwatched", sessionFile: file });
      expect(await exists(file)).toBe(false);
      expect(firstOf(processes).status).toBe("stopped");
      expect(chats.has(threadId)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat a second viewer still watches is refused with its sentence, and its omp is kept", async () => {
    const root = await makeTempRoot();
    try {
      const { chats, processes } = recordingRegistry();
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "two-viewers");
      chats.acquire(options);
      chats.acquire(options); // a second tab
      chats.release(threadId); // the first tab lets go; the second still watches

      const error = await rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(firstOf(processes).status).toBe("running");
      expect(chats.has(threadId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose turn is running is refused with its sentence, and its omp is kept", async () => {
    const root = await makeTempRoot();
    try {
      const { chats, processes } = recordingRegistry();
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "turn-running");
      chats.acquire(options);
      chats.release(threadId);
      chats.setBusy(threadId, true);

      const error = await rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "Wait for this chat's turn to finish, then delete it.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(firstOf(processes).status).toBe("running");
      expect(chats.has(threadId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a viewer that arrives while omp is asked whether it has settled keeps the chat", async () => {
    const root = await makeTempRoot();
    try {
      const chats = new OmpProcessRegistry({
        timer: quietTimer(),
        createProcess: (options) => new StubProcess(options),
      });
      const asked = deferred();
      const settled = deferred<boolean>();
      chats.setIdleHooks({
        isSettled: () => {
          asked.resolve();
          return settled.promise;
        },
        stopping: () => undefined,
      });
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "asked");
      chats.acquire(options);
      chats.release(threadId);

      const refused = rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file }));
      await asked.promise; // the stop waits for omp's answer
      chats.acquire(options); // a second tab opens the chat meanwhile
      settled.resolve(true);

      expect(await refused).toMatchObject({
        appError: {
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(chats.has(threadId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a viewer that arrives while omp is stopping keeps the chat", async () => {
    const root = await makeTempRoot();
    try {
      const { chats, processes } = slowStopRegistry();
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "stopping");
      chats.acquire(options);
      chats.release(threadId);

      const refused = rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file }));
      const first = firstOf(processes);
      await first.stopping.promise; // omp has been asked to stop
      chats.acquire(options); // a second tab opens the chat while omp exits
      first.finish.resolve();

      expect(await refused).toMatchObject({
        appError: {
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(chats.has(threadId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
import { createServerSessionFileStore, type ServerViews } from "./compose";

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

/** A stub whose stop fails, as a signal that cannot reach omp does: omp is still running afterwards. */
class FailingStopProcess extends StubProcess {
  override stop(): Promise<void> {
    return Promise.reject(new Error("omp could not be signalled"));
  }
}

/** A timer whose timeouts fire only when the test calls `fireAll()`, so a test controls the wait's limit. */
function firingTimer() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    setTimeout: (handler: () => void): number => {
      nextHandle += 1;
      callbacks.set(nextHandle, handler);
      return nextHandle;
    },
    clearTimeout: (handle: unknown): void => {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    fireAll: (): void => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
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
    views: anonymousViews(chats),
    leaseProbe: () => "inactive",
  });
  const file = path.join(store.bucketPath(cwd), `${name}.jsonl`);
  await writeSession(file, name, cwd);
  const threadId = ThreadId.parse(name);
  return {
    store,
    cwd,
    file,
    threadId,
    options: { threadId, folder: FolderPath.parse(cwd) },
  };
}

/** No connection holds a view: a delete from any connection keeps its views as they are. */
const NO_VIEWS: ServerViews = {
  viewsOf: () => 0,
  watcherCount: () => 0,
  releaseViews: async () => undefined,
};

/**
 * Views no connection is named for: every watcher the registry counts is one view, and a delete from any connection holds
 * none of them. The helpers that open chats through the registry use this, as A0 counts each view as a watcher.
 */
function anonymousViews(chats: OmpProcessRegistry): ServerViews {
  return {
    viewsOf: () => 0,
    watcherCount: (threadId) => chats.watcherCount(threadId),
    releaseViews: async () => undefined,
  };
}

/**
 * A stand-in for the app's A0 runtime over one chat: `holds` counts each connection's views. A release lets those views
 * go once per view, as A0 does. A0 keeps a chat's views on its entry until omp has exited, and the registry forgets the
 * chat then, so a view read after the exit finds none. This fake emulates that exit rule; the rule itself is proven in
 * `a0.test.ts`, where the A0 runtime is real.
 */
function viewsOver(
  chats: OmpProcessRegistry,
  threadId: ThreadId,
  holds: Map<string, number>,
): ServerViews {
  const dropIfExited = (): void => {
    if (!chats.has(threadId) && !chats.isStopping(threadId)) holds.clear();
  };
  return {
    viewsOf: (id, connectionId) => {
      if (id !== threadId) return 0;
      dropIfExited();
      return holds.get(connectionId) ?? 0;
    },
    watcherCount: (id) => {
      if (id !== threadId) return 0;
      dropIfExited();
      let total = 0;
      for (const count of holds.values()) total += count;
      return total;
    },
    releaseViews: async (id, connectionId) => {
      const count = holds.get(connectionId) ?? 0;
      holds.delete(connectionId);
      for (let released = 0; released < count; released += 1) chats.release(id);
    },
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
        views: NO_VIEWS,
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "open-idle.jsonl");
      await writeSession(file, "open-idle", cwd);
      chats.acquire({
        threadId: ThreadId.parse("open-idle"),
        folder: FolderPath.parse(cwd),
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
        views: NO_VIEWS,
        leaseProbe: () => "inactive",
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

  test("a chat another omp holds open is refused with the same sentence, and its file stays", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats: new OmpProcessRegistry({ createProcess: (options) => new StubProcess(options) }),
        views: NO_VIEWS,
        // Another omp holds the chat's lease, as the composed app's probe reports it.
        leaseProbe: () => "active",
      });
      const file = path.join(store.bucketPath(cwd), "held-elsewhere.jsonl");
      await writeSession(file, "held-elsewhere", cwd);

      const error = await store.deleteSession({ folder: cwd, sessionFile: file }).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
        },
      });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the chat list reports a chat another omp holds as held", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats: new OmpProcessRegistry({ createProcess: (options) => new StubProcess(options) }),
        views: NO_VIEWS,
        // Another omp holds the chat's lease, as the composed app's probe reports it.
        leaseProbe: () => "active",
      });
      const file = path.join(store.bucketPath(cwd), "held-listed.jsonl");
      await writeSession(file, "held-listed", cwd);

      const listed = await store.listSessions({ folder: cwd });

      expect(listed.sessions.map((session) => [session.id, session.liveness])).toEqual([
        ["held-listed", { lease: "held", serverProcess: false }],
      ]);
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
        views: NO_VIEWS,
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "open-port.jsonl");
      await writeSession(file, "open-port", cwd);
      chats.acquire({
        threadId: ThreadId.parse("open-port"),
        folder: FolderPath.parse(cwd),
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
          message:
            "Another tab or window has this chat open. Close it there, then delete it again.",
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
        stopped: () => undefined,
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
          message:
            "Another tab or window has this chat open. Close it there, then delete it again.",
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
          message:
            "Another tab or window has this chat open. Close it there, then delete it again.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(chats.has(threadId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose omp fails to stop is refused with a plain sentence, and its file and omp stay", async () => {
    const root = await makeTempRoot();
    try {
      const processes: StubProcess[] = [];
      const chats = new OmpProcessRegistry({
        timer: quietTimer(),
        createProcess: (options) => {
          const process = new FailingStopProcess(options);
          processes.push(process);
          return process;
        },
      });
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "stop-fails");
      chats.acquire(options);
      chats.release(threadId);

      const error = await rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(firstOf(processes).status).toBe("running");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose omp does not stop within about ten seconds is refused, and its file stays", async () => {
    const root = await makeTempRoot();
    try {
      const timer = firingTimer();
      const processes: SlowStopProcess[] = [];
      const chats = new OmpProcessRegistry({
        timer,
        createProcess: (options) => {
          const process = new SlowStopProcess(options);
          processes.push(process);
          return process;
        },
      });
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "stop-hangs");
      chats.acquire(options);
      chats.release(threadId);

      let answered = false;
      const refused = rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file })).then(
        (failure) => {
          answered = true;
          return failure;
        },
      );
      await firstOf(processes).stopping.promise; // omp has been asked to stop, and does not finish
      await Bun.sleep(0);
      expect(answered).toBe(false); // the delete waits for the stop, up to the limit

      timer.fireAll(); // the limit passes
      expect(await refused).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
        },
      });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose omp is still settling after its viewer let go is refused as still finishing, and its omp is kept", async () => {
    const root = await makeTempRoot();
    try {
      const { chats, processes } = recordingRegistry();
      chats.setIdleHooks({ isSettled: async () => false, stopped: () => undefined });
      const { store, cwd, file, threadId, options } = await chatFor(root, chats, "still-settling");
      chats.acquire(options);
      chats.release(threadId);

      const error = await rejectionOf(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp is still finishing this chat. Try again in a moment.",
        },
      });
      expect(await exists(file)).toBe(true);
      expect(firstOf(processes).status).toBe("running");
      expect(chats.has(threadId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose omp is still settling is refused as still finishing while the asking tab's view stays counted", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const { chats } = recordingRegistry();
      chats.setIdleHooks({ isSettled: async () => false, stopped: () => undefined });
      const threadId = ThreadId.parse("settling-view");
      const holds = new Map([["tab-one", 1]]);
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
        views: viewsOver(chats, threadId, holds),
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "settling-view.jsonl");
      await writeSession(file, "settling-view", cwd);
      chats.acquire({ threadId, folder: FolderPath.parse(cwd) }); // tab one's view

      const error = await rejectionOf(
        store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
      );

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp is still finishing this chat. Try again in a moment.",
        },
      });
      expect(holds.get("tab-one")).toBe(1);
      expect(chats.has(threadId)).toBe(true);
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a delete from the tab that holds an idle chat deletes it, and that tab's view goes with it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const { chats } = recordingRegistry();
      const threadId = ThreadId.parse("tab-held");
      const holds = new Map([["tab-one", 1]]);
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
        views: viewsOver(chats, threadId, holds),
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "tab-held.jsonl");
      await writeSession(file, "tab-held", cwd);
      chats.acquire({ threadId, folder: FolderPath.parse(cwd) });

      const result = await store.deleteSession(
        { folder: cwd, sessionFile: file },
        { connectionId: "tab-one" },
      );

      expect(result).toEqual({ id: "tab-held", sessionFile: file });
      expect(await exists(file)).toBe(false);
      expect(chats.has(threadId)).toBe(false);
      expect(holds.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat another tab also holds is refused, and the tab asking keeps its view", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const { chats } = recordingRegistry();
      const threadId = ThreadId.parse("two-tabs");
      const holds = new Map([
        ["tab-one", 1],
        ["tab-two", 1],
      ]);
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
        views: viewsOver(chats, threadId, holds),
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "two-tabs.jsonl");
      await writeSession(file, "two-tabs", cwd);
      const options = { threadId, folder: FolderPath.parse(cwd) };
      chats.acquire(options); // tab one
      chats.acquire(options); // tab two

      const error = await rejectionOf(
        store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
      );

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message:
            "Another tab or window has this chat open. Close it there, then delete it again.",
        },
      });
      expect(holds.get("tab-one")).toBe(1);
      expect(chats.watcherCount(threadId)).toBe(2);
      expect(chats.has(threadId)).toBe(true);
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a tab with no view of its own is refused while another tab's view holds the chat, even while omp is still stopping", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const timer = firingTimer();
      const processes: SlowStopProcess[] = [];
      const chats = new OmpProcessRegistry({
        timer,
        createProcess: (options) => {
          const process = new SlowStopProcess(options);
          processes.push(process);
          return process;
        },
      });
      const threadId = ThreadId.parse("window-chat");
      const holds = new Map([["tab-one", 1]]);
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
        views: viewsOver(chats, threadId, holds),
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "window-chat.jsonl");
      await writeSession(file, "window-chat", cwd);
      chats.acquire({ threadId, folder: FolderPath.parse(cwd) }); // tab one's view

      // Tab one asks for the delete. omp is asked to stop and does not finish within the limit.
      const refusedToTabOne = rejectionOf(
        store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
      );
      await firstOf(processes).stopping.promise;
      await Bun.sleep(0); // the stop's limit is registered once the stop has started: let that happen before it fires
      timer.fireAll();
      expect(await refusedToTabOne).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
        },
      });

      // Tab two holds no view of its own and asks while omp is still stopping: tab one still shows the chat.
      const refusedToTabTwo = await rejectionOf(
        store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-two" }),
      );
      expect(refusedToTabTwo).toMatchObject({
        appError: {
          code: "conflict",
          message:
            "Another tab or window has this chat open. Close it there, then delete it again.",
        },
      });
      expect(holds.get("tab-one")).toBe(1);
      expect(await exists(file)).toBe(true);

      firstOf(processes).finish.resolve(); // omp may now finish its stop
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose turn runs is refused, and the tab asking keeps its view and its omp", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const { chats } = recordingRegistry();
      const threadId = ThreadId.parse("busy-tab");
      const holds = new Map([["tab-one", 1]]);
      const store = createServerSessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        chats,
        views: viewsOver(chats, threadId, holds),
        leaseProbe: () => "inactive",
      });
      const file = path.join(store.bucketPath(cwd), "busy-tab.jsonl");
      await writeSession(file, "busy-tab", cwd);
      chats.acquire({ threadId, folder: FolderPath.parse(cwd) });
      chats.setBusy(threadId, true);

      const error = await rejectionOf(
        store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
      );

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "Wait for this chat's turn to finish, then delete it.",
        },
      });
      expect(holds.get("tab-one")).toBe(1);
      expect(chats.has(threadId)).toBe(true);
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

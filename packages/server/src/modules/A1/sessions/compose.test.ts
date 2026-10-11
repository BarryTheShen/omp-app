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

/**
 * The store the server composes, with the server's real process registry as its chats. These tests go through the
 * composition, not an injected option, so they fail if `serverOwnsSession` is not wired.
 */
describe("the session store the server composes", () => {
  test("a chat the server holds open and idle is refused with conflict, and its file stays", async () => {
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
});

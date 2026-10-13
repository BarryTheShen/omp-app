import { describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore } from "../sessions";
import type { A1PortContext } from "./context";
import { createSessionFileStoreRegistration } from "./session-file-store";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

describe("the session file port deletes a chat and publishes it as removed", () => {
  test("one delete publishes one removed change, and leaves no file behind", async () => {
    await mkdir(WORKTREE_DATA, { recursive: true });
    const root = await mkdtemp(path.join(WORKTREE_DATA, "session-port-delete-"));
    try {
      const cwd = "/workspace/app";
      const store = new SessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        tempRoot: path.join(root, "tmp"),
      });
      const file = path.join(store.bucketPath(cwd), "chat-port.jsonl");
      await mkdir(path.dirname(file), { recursive: true });
      const header = {
        type: "session",
        version: 3,
        id: "chat-port",
        timestamp: "2026-10-10T12:00:00.000Z",
        cwd,
      };
      await writeFile(file, `${JSON.stringify(header)}\n`, "utf8");

      const published: unknown[] = [];
      const context = {
        sessionFileStore: store,
        publish: (_stream: unknown, payload: unknown) => {
          published.push(payload);
          return undefined;
        },
        watchStreamActivity: () => () => undefined,
      } as unknown as A1PortContext;
      const registration = createSessionFileStoreRegistration(context);
      const handler = registration.handlers.deleteSession;
      if (handler === undefined) throw new Error("the port has no deleteSession handler");

      const result = await handler({ folder: cwd, sessionFile: file }, {
        signal: new AbortController().signal,
      } as never);

      expect(result).toEqual({ id: "chat-port", sessionFile: file, removed: true });
      expect(published).toEqual([
        { folder: cwd, sessionFile: file, id: "chat-port", kind: "removed" },
      ]);
      await expect(access(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "a delete whose artifacts cannot be removed still succeeds, and publishes one removed change",
    async () => {
      await mkdir(WORKTREE_DATA, { recursive: true });
      const root = await mkdtemp(path.join(WORKTREE_DATA, "session-port-delete-locked-"));
      let locked: string | undefined;
      try {
        const cwd = "/workspace/app";
        const store = new SessionFileStore({
          sessionsRoot: path.join(root, "sessions"),
          home: root,
          tempRoot: path.join(root, "tmp"),
        });
        const file = path.join(store.bucketPath(cwd), "chat-locked-port.jsonl");
        await mkdir(path.dirname(file), { recursive: true });
        const header = {
          type: "session",
          version: 3,
          id: "chat-locked-port",
          timestamp: "2026-10-10T12:00:00.000Z",
          cwd,
        };
        await writeFile(file, `${JSON.stringify(header)}\n`, "utf8");
        locked = path.join(path.dirname(file), "chat-locked-port", "sub");
        await mkdir(locked, { recursive: true });
        await writeFile(path.join(locked, "out.md"), "result", "utf8");
        await chmod(locked, 0o555);

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

        const result = await handler({ folder: cwd, sessionFile: file }, {
          signal: new AbortController().signal,
        } as never);

        expect(result).toEqual({ id: "chat-locked-port", sessionFile: file, removed: true });
        expect(published).toEqual([
          { folder: cwd, sessionFile: file, id: "chat-locked-port", kind: "removed" },
        ]);
        await expect(access(file)).rejects.toThrow();
      } finally {
        if (locked !== undefined) await chmod(locked, 0o755);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("the connection that asks reaches the store, so the views it holds go with its delete", async () => {
    await mkdir(WORKTREE_DATA, { recursive: true });
    const root = await mkdtemp(path.join(WORKTREE_DATA, "session-port-delete-views-"));
    try {
      const cwd = "/workspace/app";
      const released: string[] = [];
      const store = new SessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        tempRoot: path.join(root, "tmp"),
        views: {
          viewsOf: (_sessionId, connectionId) => (connectionId === "tab-one" ? 1 : 0),
          watcherCount: () => 1,
          releaseViews: async (_sessionId, connectionId) => {
            released.push(connectionId);
          },
        },
      });
      const file = path.join(store.bucketPath(cwd), "chat-views.jsonl");
      await mkdir(path.dirname(file), { recursive: true });
      const header = {
        type: "session",
        version: 3,
        id: "chat-views",
        timestamp: "2026-10-10T12:00:00.000Z",
        cwd,
      };
      await writeFile(file, `${JSON.stringify(header)}\n`, "utf8");

      const context = {
        sessionFileStore: store,
        publish: () => undefined,
        watchStreamActivity: () => () => undefined,
      } as unknown as A1PortContext;
      const handler = createSessionFileStoreRegistration(context).handlers.deleteSession;
      if (handler === undefined) throw new Error("the port has no deleteSession handler");

      await handler({ folder: cwd, sessionFile: file }, {
        signal: new AbortController().signal,
        connectionId: "tab-one",
      } as never);

      expect(released).toEqual(["tab-one"]);
      await expect(access(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

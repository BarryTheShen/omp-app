import { describe, expect, test } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore } from "./index";
import type { SessionFileStoreOptions } from "./types";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

async function makeTempRoot(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  return mkdtemp(path.join(WORKTREE_DATA, "session-delete-"));
}

function storeFor(root: string, options: SessionFileStoreOptions = {}): SessionFileStore {
  return new SessionFileStore({
    sessionsRoot: path.join(root, "sessions"),
    home: root,
    tempRoot: path.join(root, "tmp"),
    ...options,
  });
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

/** The error a refused delete raises; the test fails if the delete goes through. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the delete was not refused");
}

describe("SessionFileStore.deleteSession", () => {
  test("deletes a listed chat and the artifacts directory beside it, and nothing else", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root);
      const bucket = store.bucketPath(cwd);
      const file = path.join(bucket, "2026-10-10_chat-one.jsonl");
      const other = path.join(bucket, "2026-10-09_chat-two.jsonl");
      await writeSession(file, "chat-one", cwd);
      await writeSession(other, "chat-two", cwd);
      const artifacts = path.join(bucket, "2026-10-10_chat-one");
      await mkdir(path.join(artifacts, "sub"), { recursive: true });
      await writeFile(path.join(artifacts, "sub", "out.md"), "result", "utf8");

      const result = await store.deleteSession({ folder: cwd, sessionFile: file });

      expect(result).toEqual({ id: "chat-one", sessionFile: file });
      expect(await exists(file)).toBe(false);
      expect(await exists(artifacts)).toBe(false);
      expect(await exists(other)).toBe(true);
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id)).toEqual(["chat-two"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a ../ path that leaves the folder for another folder's chat, and deletes nothing", async () => {
    const root = await makeTempRoot();
    try {
      const store = storeFor(root);
      const cwd = "/workspace/app";
      const otherCwd = "/workspace/other";
      const theirs = path.join(store.bucketPath(otherCwd), "theirs.jsonl");
      await writeSession(theirs, "theirs", otherCwd);
      const climbing = path.join(
        store.bucketPath(cwd),
        "..",
        path.basename(store.bucketPath(otherCwd)),
        "theirs.jsonl",
      );

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: climbing }));

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(theirs)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a ../ path that climbs out of the sessions root, and deletes nothing", async () => {
    const root = await makeTempRoot();
    try {
      const store = storeFor(root);
      const cwd = "/workspace/app";
      const outside = path.join(root, "outside.jsonl");
      await writeSession(outside, "outside", cwd);
      const climbing = path.join(store.bucketPath(cwd), "..", "..", "outside.jsonl");

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: climbing }));

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(outside)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a session file outside the sessions root, and leaves it", async () => {
    const root = await makeTempRoot();
    try {
      const store = storeFor(root);
      const cwd = "/workspace/app";
      const elsewhere = path.join(root, "elsewhere", "chat.jsonl");
      await writeSession(elsewhere, "elsewhere", cwd);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: elsewhere }));

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(elsewhere)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a symlink, and leaves both the link and its target alone", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root);
      const target = path.join(store.bucketPath(cwd), "real.jsonl");
      await writeSession(target, "real", cwd);
      const link = path.join(store.bucketPath(cwd), "linked.jsonl");
      await symlink(target, link);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: link }));

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(target)).toBe(true);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a file that is not a chat, and leaves it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root);
      const notes = path.join(store.bucketPath(cwd), "notes.jsonl");
      await mkdir(path.dirname(notes), { recursive: true });
      await writeFile(notes, "not a session at all\n", "utf8");

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: notes }));

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(notes)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a chat that another folder's listing returns, and leaves it", async () => {
    const root = await makeTempRoot();
    try {
      const store = storeFor(root);
      const cwd = "/workspace/app";
      const file = path.join(store.bucketPath(cwd), "mine.jsonl");
      await writeSession(file, "mine", cwd);

      const error = await refusal(
        store.deleteSession({ folder: "/workspace/other", sessionFile: file }),
      );

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses an artifacts directory that is a symlink, before removing the chat", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root);
      const file = path.join(store.bucketPath(cwd), "chat-art.jsonl");
      await writeSession(file, "chat-art", cwd);
      const elsewhere = path.join(root, "elsewhere-dir");
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, path.join(store.bucketPath(cwd), "chat-art"));

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({ appError: { code: "not_found" } });
      expect(await exists(file)).toBe(true);
      expect(await exists(elsewhere)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a chat omp holds open in this server, and keeps it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root, { serverSessionIds: new Set(["open-here"]) });
      const file = path.join(store.bucketPath(cwd), "open-here.jsonl");
      await writeSession(file, "open-here", cwd);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({ appError: { code: "conflict" } });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a chat omp still holds after its viewer let go as still finishing, and keeps it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root, {
        serverSessionIds: new Set(["finishing"]),
        serverWatches: () => false,
      });
      const file = path.join(store.bucketPath(cwd), "finishing.jsonl");
      await writeSession(file, "finishing", cwd);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message: "omp is still finishing this chat. Try again in a moment.",
        },
      });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a chat another view holds open in the other-tab sentence, and keeps it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root, {
        serverSessionIds: new Set(["watched"]),
        serverWatches: () => true,
      });
      const file = path.join(store.bucketPath(cwd), "watched.jsonl");
      await writeSession(file, "watched", cwd);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({
        appError: {
          code: "conflict",
          message:
            "Another tab or window has this chat open. Close it there, then delete it again.",
        },
      });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a chat whose lease another omp holds, and keeps it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root, { leaseProbe: () => null });
      const file = path.join(store.bucketPath(cwd), "held.jsonl");
      await writeSession(file, "held", cwd);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({ appError: { code: "conflict" } });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a chat whose turn is running, and keeps it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root, { turnOf: () => "running" });
      const file = path.join(store.bucketPath(cwd), "busy.jsonl");
      await writeSession(file, "busy", cwd);

      const error = await refusal(store.deleteSession({ folder: cwd, sessionFile: file }));

      expect(error).toMatchObject({ appError: { code: "conflict" } });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "deletes the chat even when one of its artifacts cannot be removed: the delete succeeds, and the artifacts stay, reported",
    async () => {
      const root = await makeTempRoot();
      let locked: string | undefined;
      try {
        const cwd = "/workspace/app";
        const store = storeFor(root);
        const bucket = store.bucketPath(cwd);
        const file = path.join(bucket, "2026-10-10_chat-locked.jsonl");
        await writeSession(file, "chat-locked", cwd);
        const artifacts = path.join(bucket, "2026-10-10_chat-locked");
        locked = path.join(artifacts, "sub");
        await mkdir(locked, { recursive: true });
        await writeFile(path.join(locked, "out.md"), "result", "utf8");
        await chmod(locked, 0o555);

        const result = await store.deleteSession({ folder: cwd, sessionFile: file });

        expect(result).toEqual({ id: "chat-locked", sessionFile: file, artifactsKept: artifacts });
        expect(await exists(file)).toBe(false);
        expect(await exists(artifacts)).toBe(true);
      } finally {
        if (locked !== undefined) await chmod(locked, 0o755);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  describe("a delete from a connection that holds the chat", () => {
    /**
     * One chat held by the given connections' views, with the server's omp for it. An omp nobody else watches is stopped,
     * and omp's exit takes every view on the chat with it, as A0 does: the store lets no view go by hand on a delete.
     */
    function heldBy(holders: readonly string[]) {
      const state = { holders: [...holders], omp: true, released: [] as string[] };
      const options: SessionFileStoreOptions = {
        serverSessionIds: () => (state.omp ? new Set(["held-chat"]) : new Set<string>()),
        serverWatches: () => state.holders.length > 0,
        stopUnwatched: async (_sessionId, ownViews) => {
          if (state.holders.length > ownViews) return;
          // omp's exit takes every view on the chat with it, the asking connection's among them.
          state.omp = false;
          state.holders = [];
        },
        views: {
          viewsOf: (_sessionId, connectionId) =>
            state.holders.filter((holder) => holder === connectionId).length,
          watcherCount: () => state.holders.length,
          releaseViews: async (_sessionId, connectionId) => {
            state.released.push(connectionId);
            state.holders = state.holders.filter((holder) => holder !== connectionId);
          },
        },
      };
      return { state, options };
    }

    test("the stop takes the asking connection's own view with omp, and the delete removes the chat", async () => {
      const root = await makeTempRoot();
      try {
        const cwd = "/workspace/app";
        const chat = heldBy(["tab-one"]);
        const store = storeFor(root, chat.options);
        const file = path.join(store.bucketPath(cwd), "held-chat.jsonl");
        await writeSession(file, "held-chat", cwd);

        const result = await store.deleteSession(
          { folder: cwd, sessionFile: file },
          { connectionId: "tab-one" },
        );

        expect(result).toEqual({ id: "held-chat", sessionFile: file });
        expect(chat.state.holders).toEqual([]);
        expect(chat.state.released).toEqual([]);
        expect(await exists(file)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("is refused while another connection holds the chat, and keeps its own view", async () => {
      const root = await makeTempRoot();
      try {
        const cwd = "/workspace/app";
        const chat = heldBy(["tab-one", "tab-two"]);
        const store = storeFor(root, chat.options);
        const file = path.join(store.bucketPath(cwd), "held-chat.jsonl");
        await writeSession(file, "held-chat", cwd);

        const error = await refusal(
          store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
        );

        expect(error).toMatchObject({
          appError: {
            code: "conflict",
            message:
              "Another tab or window has this chat open. Close it there, then delete it again.",
          },
        });
        expect(chat.state.released).toEqual([]);
        expect(chat.state.holders).toEqual(["tab-one", "tab-two"]);
        expect(await exists(file)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("is refused while the chat's turn runs, and keeps its own view", async () => {
      const root = await makeTempRoot();
      try {
        const cwd = "/workspace/app";
        const chat = heldBy(["tab-one"]);
        const store = storeFor(root, { ...chat.options, turnOf: () => "running" });
        const file = path.join(store.bucketPath(cwd), "held-chat.jsonl");
        await writeSession(file, "held-chat", cwd);

        const error = await refusal(
          store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
        );

        expect(error).toMatchObject({
          appError: {
            code: "conflict",
            message: "Wait for this chat's turn to finish, then delete it.",
          },
        });
        expect(chat.state.released).toEqual([]);
        expect(chat.state.holders).toEqual(["tab-one"]);
        expect(chat.state.omp).toBe(true);
        expect(await exists(file)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("is refused before any stop when the asking connection holds no view and another connection does", async () => {
      const root = await makeTempRoot();
      try {
        const cwd = "/workspace/app";
        const asked: number[] = [];
        const chat = heldBy(["tab-two"]);
        const store = storeFor(root, {
          ...chat.options,
          stopUnwatched: async (sessionId, ownViews) => {
            asked.push(ownViews);
            await chat.options.stopUnwatched?.(sessionId, ownViews);
          },
        });
        const file = path.join(store.bucketPath(cwd), "held-chat.jsonl");
        await writeSession(file, "held-chat", cwd);

        const error = await refusal(
          store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
        );

        expect(error).toMatchObject({
          appError: {
            code: "conflict",
            message:
              "Another tab or window has this chat open. Close it there, then delete it again.",
          },
        });
        // Another tab holds the chat and this tab holds none: the refusal comes before omp is asked to stop.
        expect(asked).toEqual([]);
        expect(chat.state.holders).toEqual(["tab-two"]);
        expect(chat.state.released).toEqual([]);
        expect(await exists(file)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("asks the stop to count the asking connection's own view as its own", async () => {
      const root = await makeTempRoot();
      try {
        const cwd = "/workspace/app";
        const asked: number[] = [];
        const chat = heldBy(["tab-one"]);
        const store = storeFor(root, {
          ...chat.options,
          stopUnwatched: async (_sessionId, ownViews) => {
            asked.push(ownViews);
            if (chat.state.holders.length <= ownViews) chat.state.omp = false;
          },
        });
        const file = path.join(store.bucketPath(cwd), "held-chat.jsonl");
        await writeSession(file, "held-chat", cwd);

        await store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" });

        expect(asked).toEqual([1]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a refusal after the stop keeps the asking connection's own view, and its chat's file", async () => {
      const root = await makeTempRoot();
      try {
        const cwd = "/workspace/app";
        const chat = heldBy(["tab-one"]);
        // omp does not go: the chat is still held once the stop has run.
        const store = storeFor(root, { ...chat.options, stopUnwatched: async () => undefined });
        const file = path.join(store.bucketPath(cwd), "held-chat.jsonl");
        await writeSession(file, "held-chat", cwd);

        const error = await refusal(
          store.deleteSession({ folder: cwd, sessionFile: file }, { connectionId: "tab-one" }),
        );

        expect(error).toMatchObject({
          appError: {
            code: "conflict",
            message: "omp is still finishing this chat. Try again in a moment.",
          },
        });
        expect(chat.state.released).toEqual([]);
        expect(chat.state.holders).toEqual(["tab-one"]);
        expect(await exists(file)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("SessionFileStore.checkOmpDelete and finishOmpDelete (a delete omp runs itself)", () => {
  test("the check returns the chat's file as a clear delete, and a clear delete with no file for a chat with none", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const store = storeFor(root);
      const file = path.join(store.bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      expect(await store.checkOmpDelete("chat-one", { connectionId: "app" })).toMatchObject({
        outcome: "clear",
        file: { sessionFile: file },
      });
      expect(await store.checkOmpDelete("chat-missing", { connectionId: "app" })).toEqual({
        outcome: "clear",
        file: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the check returns the refusal for a chat another view holds, a chat omp is still finishing, and a chat whose turn runs", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const file = path.join(storeFor(root).bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      const views = {
        viewsOf: () => 1,
        watcherCount: () => 2,
        releaseViews: async () => undefined,
      };
      const held = storeFor(root, { views });
      expect(await held.checkOmpDelete("chat-one", { connectionId: "app" })).toEqual({
        outcome: "refused",
        reason: "open-elsewhere",
      });
      const finishing = storeFor(root, { views, serverWatches: () => false });
      expect(await finishing.checkOmpDelete("chat-one", { connectionId: "app" })).toEqual({
        outcome: "refused",
        reason: "finishing",
      });
      const running = storeFor(root, { turnOf: () => "running" });
      expect(await running.checkOmpDelete("chat-one", { connectionId: "app" })).toEqual({
        outcome: "refused",
        reason: "running",
      });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the finish stops the chat's omp with the caller's own view counted, then removes the file omp wrote back", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const file = path.join(storeFor(root).bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      const order: string[] = [];
      const store = storeFor(root, {
        views: {
          viewsOf: () => 1,
          watcherCount: () => 1,
          releaseViews: async (id, connectionId) => {
            order.push(`release ${id} ${connectionId}`);
          },
        },
        stopUnwatched: async (id, ownViews) => {
          order.push(`stop ${id} ${ownViews}`);
          // omp writes the chat back while its omp stops, so the file is there again.
          await writeSession(file, "chat-one", cwd);
        },
      });
      const checked = await store.checkOmpDelete("chat-one", { connectionId: "app" });
      if (checked.outcome !== "clear" || checked.file === undefined) {
        throw new Error("the chat has no file");
      }
      // omp deletes the file itself, and then the server finishes the delete.
      await rm(file);
      await store.finishOmpDelete(checked.file, { connectionId: "app" });
      // The caller's view is not let go first: it is the stop's own, and omp's exit takes it.
      expect(order).toEqual(["stop chat-one 1"]);
      expect(await exists(file)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stop that fails is raised, and the file is left as omp left it", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const file = path.join(storeFor(root).bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      const store = storeFor(root, {
        stopUnwatched: async () => {
          throw new Error("omp did not stop");
        },
      });
      const checked = await store.checkOmpDelete("chat-one", { connectionId: "app" });
      if (checked.outcome !== "clear" || checked.file === undefined) {
        throw new Error("the chat has no file");
      }
      await expect(store.finishOmpDelete(checked.file, { connectionId: "app" })).rejects.toThrow(
        "omp did not stop",
      );
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stop that fails keeps the caller's own view counted: the finish releases nothing before omp has stopped", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const file = path.join(storeFor(root).bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      const released: string[] = [];
      const asked: number[] = [];
      const store = storeFor(root, {
        views: {
          viewsOf: () => 1,
          watcherCount: () => 1,
          releaseViews: async (_id, connectionId) => {
            released.push(connectionId);
          },
        },
        stopUnwatched: async (_id, ownViews) => {
          asked.push(ownViews);
          throw new Error("omp did not stop");
        },
      });
      const checked = await store.checkOmpDelete("chat-one", { connectionId: "app" });
      if (checked.outcome !== "clear" || checked.file === undefined) {
        throw new Error("the chat has no file");
      }
      await expect(store.finishOmpDelete(checked.file, { connectionId: "app" })).rejects.toThrow(
        "omp did not stop",
      );
      expect(asked).toEqual([1]);
      expect(released).toEqual([]);
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the finish re-checks after its stop: a view that came in while omp stopped keeps the file, and is refused as open elsewhere", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const file = path.join(storeFor(root).bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      // The asking view leaves with omp's exit. While omp stops, another tab opens the chat, and omp writes the chat back.
      let callerViews = 1;
      let otherViews = 0;
      const store = storeFor(root, {
        views: {
          viewsOf: () => callerViews,
          watcherCount: () => callerViews + otherViews,
          releaseViews: async () => undefined,
        },
        stopUnwatched: async () => {
          callerViews = 0;
          otherViews = 1;
          await writeSession(file, "chat-one", cwd);
        },
      });
      const checked = await store.checkOmpDelete("chat-one", { connectionId: "app" });
      if (checked.outcome !== "clear" || checked.file === undefined) {
        throw new Error("the chat has no file");
      }
      // omp deletes the file itself, and then the server finishes the delete.
      await rm(file);
      await expect(store.finishOmpDelete(checked.file, { connectionId: "app" })).resolves.toEqual({
        outcome: "refused",
        reason: "open-elsewhere",
      });
      // The file omp wrote back stays: another omp holds the chat, and it would write the file again.
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the finish refuses as still finishing when omp's own entry for the chat remains with no view", async () => {
    const root = await makeTempRoot();
    try {
      const cwd = "/workspace/app";
      const file = path.join(storeFor(root).bucketPath(cwd), "2026-10-10_chat-one.jsonl");
      await writeSession(file, "chat-one", cwd);
      const store = storeFor(root, {
        views: {
          viewsOf: () => 1,
          watcherCount: () => 1,
          releaseViews: async () => undefined,
        },
        serverOwnsSession: () => true,
        stopUnwatched: async () => undefined,
      });
      const checked = await store.checkOmpDelete("chat-one", { connectionId: "app" });
      if (checked.outcome !== "clear" || checked.file === undefined) {
        throw new Error("the chat has no file");
      }
      await rm(file);
      await writeSession(file, "chat-one", cwd);
      await expect(store.finishOmpDelete(checked.file, { connectionId: "app" })).resolves.toEqual({
        outcome: "refused",
        reason: "finishing",
      });
      expect(await exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

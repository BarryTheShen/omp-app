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
});

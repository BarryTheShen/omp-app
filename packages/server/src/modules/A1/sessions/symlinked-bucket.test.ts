import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SessionFilePath } from "@omp-app/contracts";
import { SessionFileStore } from "./index";

// A chat whose folder's session bucket is a symlink to a directory outside the sessions root (#2533). omp follows such a
// bucket when it lists the folder and resumes from it; its all-folders scans skip it.

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const CHAT_ID = "01b00000-0000-7000-8000-000000000001";
const OTHER_ID = "01b00000-0000-7000-8000-000000000002";

/** A chat file as omp writes it: the session header, then one user message. */
function chatFile(id: string, cwd: string): string {
  const stamp = "2026-10-22T12:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id, timestamp: stamp, cwd },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: stamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello from the linked folder" }],
        timestamp: Date.parse(stamp),
      },
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

interface LinkedFolder {
  readonly root: string;
  readonly cwd: string;
  /** The chat's path inside the sessions root, through the bucket's symlink. */
  readonly chat: string;
  readonly store: SessionFileStore;
}

/**
 * A folder whose bucket is a symlink: the chat is written into a directory outside the sessions root, and the bucket
 * path inside the root points at that directory, as the issue sets it up.
 */
async function linkedFolder(): Promise<LinkedFolder> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const root = await mkdtemp(path.join(WORKTREE_DATA, "symlinked-bucket-"));
  const home = path.join(root, "home");
  const cwd = path.join(home, "project");
  const sessionsRoot = path.join(root, "agent", "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const store = new SessionFileStore({ sessionsRoot, home, tempRoot: path.join(root, "tmp") });
  const bucket = store.bucketPath(cwd);
  const target = path.join(root, "elsewhere", path.basename(bucket));
  await mkdir(target, { recursive: true });
  const chat = path.join(target, `2026-10-22T12-00-00-000Z_${CHAT_ID}.jsonl`);
  await writeFile(chat, chatFile(CHAT_ID, cwd));
  await symlink(target, bucket);
  return { root, cwd, chat: path.join(bucket, path.basename(chat)), store };
}

describe("a chat in a folder whose session bucket is a symlink", () => {
  test("is not found by an all-folders lookup, even after its folder's listing has shown it", async () => {
    const folder = await linkedFolder();
    try {
      expect(await folder.store.resolveThread(CHAT_ID)).toBeUndefined();
      await folder.store.listSessions({ folder: folder.cwd });
      const all = await folder.store.listSessions();
      expect(all.sessions.map((session) => session.id)).not.toContain(CHAT_ID);
    } finally {
      await rm(folder.root, { recursive: true, force: true });
    }
  });

  test("opens from the file its folder's listing found", async () => {
    const folder = await linkedFolder();
    try {
      const listed = await folder.store.listSessions({ folder: folder.cwd });
      expect(listed.sessions.map((session) => session.id)).toEqual([CHAT_ID]);
      expect(await folder.store.resolveThread(CHAT_ID)).toEqual({
        cwd: folder.cwd,
        sessionFile: folder.chat,
      });
    } finally {
      await rm(folder.root, { recursive: true, force: true });
    }
  });

  test("is found by id, and its entries read, once its folder's listing has shown it", async () => {
    const folder = await linkedFolder();
    try {
      await folder.store.listSessions({ folder: folder.cwd });
      expect((await folder.store.findSession(CHAT_ID))?.sessionFile).toBe(folder.chat);
      const window = await folder.store.readEntryWindow({
        sessionFile: SessionFilePath.parse(folder.chat),
      });
      expect(window.entries.length).toBeGreaterThan(0);
    } finally {
      await rm(folder.root, { recursive: true, force: true });
    }
  });

  test("is not opened from a file that is gone, or that now holds another chat", async () => {
    const folder = await linkedFolder();
    try {
      await folder.store.listSessions({ folder: folder.cwd });
      await rm(folder.chat);
      expect(await folder.store.resolveThread(CHAT_ID)).toBeUndefined();
      await writeFile(folder.chat, chatFile(OTHER_ID, folder.cwd));
      expect(await folder.store.resolveThread(CHAT_ID)).toBeUndefined();
    } finally {
      await rm(folder.root, { recursive: true, force: true });
    }
  });
});

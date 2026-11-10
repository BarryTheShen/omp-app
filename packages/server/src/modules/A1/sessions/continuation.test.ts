import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { newestCopy } from "./continuation";
import { SessionFileStore } from "./index";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

interface Chat {
  /** omp's file-name time, `2026-11-01T00-05-00-000Z`. */
  readonly named: string;
  readonly id: string;
  /** The header's time: its creation, or for a moved copy the move. */
  readonly at: string;
  readonly continues?: string;
  /** One user message at each time. */
  readonly messages: readonly string[];
}

/** A chat file as omp writes it (`<time>_<id>.jsonl`): the header, then the messages. */
async function writeChat(folder: string, cwd: string, chat: Chat): Promise<string> {
  const file = path.join(folder, `${chat.named}_${chat.id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: chat.id,
    timestamp: chat.at,
    cwd,
    ...(chat.continues === undefined
      ? {}
      : { parentSession: chat.continues, continuationOf: chat.continues }),
  };
  const messages = chat.messages.map((timestamp, index) => ({
    type: "message",
    id: `${chat.id}-${index}`,
    parentId: index === 0 ? null : `${chat.id}-${index - 1}`,
    timestamp,
    message: { role: "user", content: [{ type: "text", text: `turn ${index}` }] },
  }));
  await writeFile(
    file,
    `${[header, ...messages].map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return file;
}

/**
 * A chat, the copy omp moved it to at 00:05, and the store over their folder (`runsOld`: this server runs the chat).
 * `restart` starts another store over the same folder and app data, as a server's restart does.
 */
async function withMovedChat(
  options: { readonly oldWentOn: boolean; readonly runsOld?: boolean },
  run: (files: {
    readonly old: string;
    readonly copy: string;
    readonly folder: string;
    readonly cwd: string;
    readonly store: SessionFileStore;
    readonly restart: () => SessionFileStore;
  }) => Promise<void>,
): Promise<void> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const root = await mkdtemp(path.join(WORKTREE_DATA, "continuation-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(home, "project");
    const sessionsRoot = path.join(root, "sessions");
    const folder = path.join(sessionsRoot, "-project");
    await mkdir(cwd, { recursive: true });
    await mkdir(folder, { recursive: true });
    const old = await writeChat(folder, cwd, {
      named: "2026-11-01T00-00-00-000Z",
      id: "old-chat",
      at: "2026-11-01T00:00:00.000Z",
      // A turn after the move means the process that kept the old file went on writing it.
      messages: options.oldWentOn
        ? ["2026-11-01T00:01:00.000Z", "2026-11-01T00:07:00.000Z"]
        : ["2026-11-01T00:01:00.000Z"],
    });
    const copy = await writeChat(folder, cwd, {
      named: "2026-11-01T00-05-00-000Z",
      id: "moved-chat",
      at: "2026-11-01T00:05:00.000Z",
      continues: "old-chat",
      messages: ["2026-11-01T00:01:00.000Z", "2026-11-01T00:06:00.000Z"],
    });
    const restart = (): SessionFileStore =>
      new SessionFileStore({
        sessionsRoot,
        home,
        tempRoot: path.join(root, "tmp"),
        appDataDir: path.join(root, "app"),
        serverOwnsSession: (sessionId) => options.runsOld === true && sessionId === "old-chat",
      });
    await run({ old, copy, folder, cwd, store: restart(), restart });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("a chat omp moved to another file", () => {
  test("opens as the copy that continues it, following every move", async () => {
    await withMovedChat({ oldWentOn: false }, async ({ old, copy, folder, cwd }) => {
      expect(await newestCopy(old, "old-chat")).toEqual({ file: copy, id: "moved-chat" });
      // The copy is the newest one: nothing continues it.
      expect(await newestCopy(copy, "moved-chat")).toBeUndefined();
      const again = await writeChat(folder, cwd, {
        named: "2026-11-01T00-10-00-000Z",
        id: "moved-again",
        at: "2026-11-01T00:10:00.000Z",
        continues: "moved-chat",
        messages: [
          "2026-11-01T00:01:00.000Z",
          "2026-11-01T00:06:00.000Z",
          "2026-11-01T00:11:00.000Z",
        ],
      });
      expect(await newestCopy(old, "old-chat")).toEqual({ file: again, id: "moved-again" });
    });
  });

  test("is listed once, as its copy, also after a restart", async () => {
    await withMovedChat({ oldWentOn: false }, async ({ cwd, store, restart }) => {
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id)).toEqual(["moved-chat"]);
      await store.flushSummaries();
      // The next server takes what each file continues from the facts the last one kept.
      const again = await restart().listSessions({ folder: cwd });
      expect(again.sessions.map((session) => session.id)).toEqual(["moved-chat"]);
    });
  });

  test("that this app runs stays listed: another omp moved its own copy aside", async () => {
    await withMovedChat({ oldWentOn: false, runsOld: true }, async ({ cwd, store }) => {
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id).sort()).toEqual([
        "moved-chat",
        "old-chat",
      ]);
    });
  });

  test("that went on after the move stays itself: both copies hold turns the other lacks", async () => {
    await withMovedChat({ oldWentOn: true }, async ({ old, cwd, store }) => {
      expect(await newestCopy(old, "old-chat")).toBeUndefined();
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id).sort()).toEqual([
        "moved-chat",
        "old-chat",
      ]);
    });
  });
});

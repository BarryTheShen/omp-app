import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore as SessionFileStorePort, streamKey } from "@omp-app/contracts";
import { SessionFileStore } from "../sessions";
import type { A1PortContext } from "./context";
import { createOmpCommandGatewayRegistration } from "./omp-command-gateway";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

type Published = { readonly stream: string; readonly payload: unknown };

/** A chat's file with its header, the way omp has saved a chat. */
async function writeChat(store: SessionFileStore, cwd: string, id: string): Promise<string> {
  const file = path.join(store.bucketPath(cwd), `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const header = { type: "session", version: 3, id, timestamp: "2026-10-10T12:00:00.000Z", cwd };
  await writeFile(file, `${JSON.stringify(header)}\n`, "utf8");
  return file;
}

/**
 * The `/session delete` handler over a real session store. The fake omp deletes the chat's file, as omp does, and
 * replies `deleted`. Every publish is recorded with its stream.
 */
function deleteHandler(store: SessionFileStore, published: Published[], omp: () => Promise<void>) {
  const context = {
    sessionFileStore: store,
    ompCommandGateway: {
      onOutput: () => () => undefined,
      onCompaction: () => () => undefined,
      runWithParser: async () => {
        await omp();
        return { data: { outcome: "deleted" } };
      },
    },
    publish: (stream: unknown, payload: unknown) => {
      published.push({ stream: String(stream), payload });
      return undefined;
    },
    watchStreamActivity: () => () => undefined,
  } as unknown as A1PortContext;
  const handler = createOmpCommandGatewayRegistration(context).handlers.sessionDelete;
  if (handler === undefined) throw new Error("the port has no sessionDelete handler");
  return (threadId: string): Promise<unknown> =>
    Promise.resolve(
      handler({ threadId }, { connectionId: "app", signal: new AbortController().signal } as never),
    );
}

describe("a typed /session delete publishes the removal the sidebar's own delete publishes", () => {
  test("a delete omp confirms publishes one removed change on the session file stream, after the file is gone", async () => {
    await mkdir(WORKTREE_DATA, { recursive: true });
    const root = await mkdtemp(path.join(WORKTREE_DATA, "gateway-delete-"));
    try {
      const cwd = "/workspace/app";
      const store = new SessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        tempRoot: path.join(root, "tmp"),
      });
      const file = await writeChat(store, cwd, "chat-typed");
      const published: Published[] = [];
      const run = deleteHandler(store, published, () => rm(file));

      await expect(run("chat-typed")).resolves.toMatchObject({ outcome: "deleted" });
      await expect(access(file)).rejects.toThrow();
      expect(published).toEqual([
        {
          stream: streamKey(SessionFileStorePort.name, "changed"),
          payload: { folder: cwd, sessionFile: file, id: "chat-typed", kind: "removed" },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a delete another view holds is refused before omp runs, and publishes nothing", async () => {
    await mkdir(WORKTREE_DATA, { recursive: true });
    const root = await mkdtemp(path.join(WORKTREE_DATA, "gateway-delete-held-"));
    try {
      const cwd = "/workspace/app";
      const store = new SessionFileStore({
        sessionsRoot: path.join(root, "sessions"),
        home: root,
        tempRoot: path.join(root, "tmp"),
        views: {
          viewsOf: () => 1,
          watcherCount: () => 2,
          releaseViews: async () => undefined,
        },
      });
      const file = await writeChat(store, cwd, "chat-held");
      const published: Published[] = [];
      let ompRan = false;
      const run = deleteHandler(store, published, async () => {
        ompRan = true;
      });

      await expect(run("chat-held")).resolves.toEqual({
        outcome: "refused",
        reason: "open-elsewhere",
      });
      expect(ompRan).toBe(false);
      expect(published).toEqual([]);
      // The chat's file stays: omp was not asked to delete it, so the file is still there to be read.
      await access(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

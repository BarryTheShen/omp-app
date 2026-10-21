import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  SUMMARY_CACHE_FILE,
  SUMMARY_CACHE_LIMIT,
  SUMMARY_SCHEMA,
  SUMMARY_WRITE_INTERVAL_MS,
  SummaryCache,
  type SummaryCacheEntry,
} from "./summary-cache";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

async function makeTempRoot(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  return mkdtemp(path.join(WORKTREE_DATA, "summary-cache-unit-"));
}

function entryFor(realpath: string, messageCount = 2): SummaryCacheEntry {
  return {
    realpath,
    identity: { dev: 1, ino: 2, size: 10, mtimeMs: 1_700_000_000_000.25 },
    updatedAt: "2026-10-01T10:00:00.000Z",
    summary: {
      header: {
        id: "chat-a",
        cwd: "/workspace/app",
        version: 3,
        title: "A title",
        timestamp: "2026-10-01T09:00:00.000Z",
      },
      messageCount,
      assistantTurns: 1,
      firstPrompt: "hello",
      status: "complete",
      parseWarnings: [{ code: "malformed_line", message: "Malformed JSONL record", line: 3 }],
    },
  };
}

/** A cache whose timers never run on their own: the test decides when a write is due. */
function quietCache(file: string | undefined, errors: unknown[], limit?: number): SummaryCache {
  return new SummaryCache({
    ...(file === undefined ? {} : { file }),
    ...(limit === undefined ? {} : { limit }),
    schedule: () => () => undefined,
    onError: (error) => errors.push(error),
  });
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** The real paths of the entries a cache file holds, sorted. */
async function storedPaths(file: string): Promise<string[]> {
  const text = JSON.parse(await readFile(file, "utf8")) as {
    readonly entries: readonly { readonly realpath: string }[];
  };
  return text.entries.map((entry) => entry.realpath).sort();
}

describe("SummaryCache", () => {
  test("writes a 0600 file that a new cache reads back, with the facts still unverified", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "app", SUMMARY_CACHE_FILE);
      const chat = path.join(root, "chat.jsonl");
      // The cache drops the facts of a chat whose file is gone when it loads, so the chat must exist.
      await writeFile(chat, "chat\n");
      const errors: unknown[] = [];
      const first = quietCache(file, errors);
      await first.ready();
      first.put(entryFor(chat));
      await first.flush();

      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const second = quietCache(file, errors);
      await second.ready();
      expect(second.get(chat)).toEqual(entryFor(chat));
      expect(second.isUnverified(chat)).toBe(true);
      second.verify(chat);
      expect(second.isUnverified(chat)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops the chats whose files are gone when the file loads, and rewrites the file without them", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "app", SUMMARY_CACHE_FILE);
      const present = path.join(root, "present.jsonl");
      const gone = path.join(root, "gone.jsonl");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(present, "present\n");
      await writeFile(
        file,
        JSON.stringify({
          summarySchema: SUMMARY_SCHEMA,
          entries: [entryFor(present), entryFor(gone)],
        }),
      );
      const errors: unknown[] = [];
      const cache = quietCache(file, errors);
      await cache.ready();
      expect(cache.get(gone)).toBeUndefined();
      expect(cache.get(present)).toBeDefined();
      await cache.flush();
      expect(await storedPaths(file)).toEqual([present]);
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("starts empty and rebuilds the file when it is of another schema, or is not JSON", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "app", SUMMARY_CACHE_FILE);
      const chat = path.join(root, "chat.jsonl");
      await writeFile(chat, "chat\n");
      await mkdir(path.dirname(file), { recursive: true });
      const errors: unknown[] = [];
      for (const content of [
        JSON.stringify({ summarySchema: SUMMARY_SCHEMA - 1, entries: [entryFor(chat)] }),
        "{ this is not json",
        JSON.stringify({ summarySchema: SUMMARY_SCHEMA, entries: "not a list" }),
      ]) {
        await writeFile(file, content);
        const cache = quietCache(file, errors);
        await cache.ready();
        expect(cache.get(chat)).toBeUndefined();
        await cache.flush();
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
          summarySchema: SUMMARY_SCHEMA,
          entries: [],
        });
      }
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops only the entries that do not validate, and keeps the rest", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "app", SUMMARY_CACHE_FILE);
      const chat = path.join(root, "chat.jsonl");
      await writeFile(chat, "chat\n");
      await mkdir(path.dirname(file), { recursive: true });
      const valid = entryFor(chat);
      const invalid = [
        { ...valid, identity: { ...valid.identity, size: -1 } },
        { realpath: chat, identity: valid.identity },
        { ...valid, realpath: "relative/chat.jsonl" },
        { ...valid, summary: { ...valid.summary, status: "finished" } },
        { ...valid, summary: { ...valid.summary, firstPrompt: "x".repeat(121) } },
      ];
      await writeFile(
        file,
        JSON.stringify({ summarySchema: SUMMARY_SCHEMA, entries: [...invalid, valid] }),
      );
      const errors: unknown[] = [];
      const cache = quietCache(file, errors);
      await cache.ready();
      expect(cache.get(chat)).toEqual(valid);
      await cache.flush();
      expect(await storedPaths(file)).toEqual([chat]);
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("forgets the least recently used chat past its limit", () => {
    const errors: unknown[] = [];
    const cache = quietCache(undefined, errors, 2);
    cache.put(entryFor("/chats/a.jsonl"));
    cache.put(entryFor("/chats/b.jsonl"));
    expect(cache.get("/chats/a.jsonl")).toBeDefined();
    cache.put(entryFor("/chats/c.jsonl"));
    expect(cache.get("/chats/b.jsonl")).toBeUndefined();
    expect(cache.get("/chats/a.jsonl")).toBeDefined();
    expect(cache.get("/chats/c.jsonl")).toBeDefined();
    expect(errors).toEqual([]);
  });

  test("a deleted chat is not in the next write", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "app", SUMMARY_CACHE_FILE);
      const errors: unknown[] = [];
      const cache = quietCache(file, errors);
      cache.put(entryFor("/chats/a.jsonl"));
      cache.put(entryFor("/chats/b.jsonl"));
      await cache.flush();
      cache.delete("/chats/a.jsonl");
      await cache.flush();
      expect(await storedPaths(file)).toEqual(["/chats/b.jsonl"]);
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes at most once per interval, and a change waits for the interval since the last write", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "app", SUMMARY_CACHE_FILE);
      const errors: unknown[] = [];
      let now = 1_000_000;
      const start = now;
      let timers: { readonly at: number; readonly run: () => void }[] = [];
      const runDue = (): void => {
        const due = timers.filter((timer) => timer.at <= now);
        timers = timers.filter((timer) => timer.at > now);
        for (const timer of due) timer.run();
      };
      const cache = new SummaryCache({
        file,
        now: () => now,
        schedule: (run, delayMs) => {
          timers.push({ at: now + delayMs, run });
          return () => undefined;
        },
        onError: (error) => errors.push(error),
      });
      await cache.ready();

      cache.put(entryFor("/chats/a.jsonl"));
      expect(timers.map((timer) => timer.at)).toEqual([start + SUMMARY_WRITE_INTERVAL_MS]);
      now += 1_000;
      cache.put(entryFor("/chats/b.jsonl"));
      expect(timers).toHaveLength(1);
      expect(await exists(file)).toBe(false);

      now = start + SUMMARY_WRITE_INTERVAL_MS;
      runDue();
      await cache.flush();
      expect(await storedPaths(file)).toEqual(["/chats/a.jsonl", "/chats/b.jsonl"]);
      const written = now;

      cache.put(entryFor("/chats/c.jsonl"));
      now += 1;
      expect(timers.map((timer) => timer.at)).toEqual([written + SUMMARY_WRITE_INTERVAL_MS]);
      runDue();
      expect(await storedPaths(file)).toEqual(["/chats/a.jsonl", "/chats/b.jsonl"]);

      now = written + SUMMARY_WRITE_INTERVAL_MS;
      runDue();
      await cache.flush();
      expect(await storedPaths(file)).toEqual([
        "/chats/a.jsonl",
        "/chats/b.jsonl",
        "/chats/c.jsonl",
      ]);
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a failed write and keeps the change for the next write", async () => {
    const root = await makeTempRoot();
    try {
      const blocker = path.join(root, "blocker");
      await writeFile(blocker, "a file where the folder should be\n");
      const file = path.join(blocker, SUMMARY_CACHE_FILE);
      const errors: unknown[] = [];
      const cache = quietCache(file, errors);
      cache.put(entryFor("/chats/a.jsonl"));
      await cache.flush();
      expect(errors).toHaveLength(1);
      await rm(blocker);
      await cache.flush();
      expect(errors).toHaveLength(1);
      expect(await storedPaths(file)).toEqual(["/chats/a.jsonl"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("close writes what changed once, cancels the armed write, and ignores later changes", async () => {
    const root = await makeTempRoot();
    try {
      const folder = path.join(root, "app");
      const file = path.join(folder, SUMMARY_CACHE_FILE);
      const errors: unknown[] = [];
      const armed: { cancelled: boolean }[] = [];
      const cache = new SummaryCache({
        file,
        schedule: () => {
          const timer = { cancelled: false };
          armed.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        onError: (error) => errors.push(error),
      });
      await cache.ready();
      cache.put(entryFor("/chats/a.jsonl"));
      expect(armed).toHaveLength(1);

      await cache.close();
      expect(armed[0]?.cancelled).toBe(true);
      expect(await storedPaths(file)).toEqual(["/chats/a.jsonl"]);
      expect(await readdir(folder)).toEqual([SUMMARY_CACHE_FILE]);

      cache.put(entryFor("/chats/b.jsonl"));
      cache.delete("/chats/a.jsonl");
      await cache.flush();
      expect(armed).toHaveLength(1);
      expect(await storedPaths(file)).toEqual(["/chats/a.jsonl"]);

      await rm(folder, { recursive: true, force: true });
      await cache.flush();
      expect(await exists(file)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps 20,000 chats, and forgets the least recently listed one past that", () => {
    expect(SUMMARY_CACHE_LIMIT).toBe(20_000);
    const errors: unknown[] = [];
    const cache = quietCache(undefined, errors);
    for (let index = 0; index < SUMMARY_CACHE_LIMIT; index += 1) {
      cache.put(entryFor(`/chats/${index}.jsonl`));
    }
    expect(cache.get("/chats/0.jsonl")).toBeDefined();
    cache.put(entryFor("/chats/extra.jsonl"));
    expect(cache.get("/chats/1.jsonl")).toBeUndefined();
    expect(cache.get("/chats/0.jsonl")).toBeDefined();
    expect(cache.get("/chats/extra.jsonl")).toBeDefined();
    expect(errors).toEqual([]);
  });

  test("a write that fails at close is not retried: nothing is written once close resolves", async () => {
    const root = await makeTempRoot();
    try {
      const blocker = path.join(root, "blocker");
      await writeFile(blocker, "a file where the folder should be\n");
      const file = path.join(blocker, SUMMARY_CACHE_FILE);
      const errors: unknown[] = [];
      const cache = quietCache(file, errors);
      cache.put(entryFor("/chats/a.jsonl"));
      await cache.close();
      expect(errors).toHaveLength(1);
      await rm(blocker);
      await cache.flush();
      expect(await exists(file)).toBe(false);
      expect(errors).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

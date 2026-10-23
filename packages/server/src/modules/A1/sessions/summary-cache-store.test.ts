import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { type SessionBackgroundEvent, SessionFileStore } from "./store";
import { summarizeSessionFile } from "./summary";
import { SUMMARY_CACHE_FILE, SUMMARY_SCHEMA } from "./summary-cache";
import { readSummary } from "./summary-resume";
import type { SessionListResult } from "./types";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

async function makeTempRoot(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  return mkdtemp(path.join(WORKTREE_DATA, "summary-cache-store-"));
}

function at(day: number, minute = 0): string {
  return `2026-10-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function headerLine(
  id: string,
  cwd: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): string {
  return jsonLine({ type: "session", version: 3, id, timestamp, cwd, ...extra });
}

/** A title slot, padded to the 256 bytes omp writes: the first line of a chat that has one. */
function titleSlotLine(title: string): string {
  const line = JSON.stringify({
    type: "title",
    v: 1,
    title,
    source: "user",
    updatedAt: at(1),
    pad: "",
  });
  return `${line}${" ".repeat(256 - Buffer.byteLength(line) - 1)}\n`;
}

function userLine(id: string, timestamp: string, text: string): string {
  return jsonLine({ type: "message", id, timestamp, message: { role: "user", content: text } });
}

function assistantLine(id: string, timestamp: string, text: string, stopReason = "stop"): string {
  return jsonLine({
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
  });
}

async function writeChat(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

/** The first background event of `kind` the store reports. */
function nextBackground(
  store: SessionFileStore,
  kind: SessionBackgroundEvent["kind"],
): Promise<SessionBackgroundEvent> {
  let stop: () => void = () => undefined;
  return new Promise((resolve) => {
    stop = store.onBackground((event) => {
      if (event.kind !== kind) return;
      stop();
      resolve(event);
    });
  });
}

/**
 * A gate that holds a read until the test opens it. The server package compiles against ES2023, which has no
 * `Promise.withResolvers`, so the resolver is taken from the executor.
 */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** The real paths of the chats a cache file holds, sorted. */
async function storedPaths(file: string): Promise<string[]> {
  const cache = JSON.parse(await readFile(file, "utf8")) as {
    readonly entries: readonly { readonly realpath: string }[];
  };
  return cache.entries.map((entry) => entry.realpath).sort();
}

/** What a listing shows of each chat, as numbers, statuses and times: no text. */
function shown(list: SessionListResult): unknown[] {
  return list.sessions.map((session) => ({
    id: session.id,
    messageCount: session.messageCount,
    assistantTurns: session.assistantTurns,
    status: session.status,
    sizeBytes: session.sizeBytes,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    warnings: session.parseWarnings.map((warning) => `${warning.code}:${warning.line ?? ""}`),
  }));
}

interface Fixture {
  readonly root: string;
  readonly sessionsRoot: string;
  readonly cwd: string;
  readonly bucket: string;
  readonly options: {
    readonly sessionsRoot: string;
    readonly home: string;
    readonly tempRoot: string;
    readonly appDataDir: string;
  };
}

async function fixture(): Promise<Fixture> {
  const root = await makeTempRoot();
  const home = path.join(root, "home");
  const sessionsRoot = path.join(root, "sessions");
  const cwd = path.join(home, "project");
  const options = {
    sessionsRoot,
    home,
    tempRoot: path.join(root, "tmp"),
    appDataDir: path.join(root, "app"),
  };
  const bucket = new SessionFileStore(options).bucketPath(cwd);
  return { root, sessionsRoot, cwd, bucket, options };
}

/** Chats of many shapes: each one a case the summary reads differently. */
async function writeVariants(bucket: string, cwd: string): Promise<void> {
  const chat = (name: string, text: string) =>
    writeChat(path.join(bucket, `2026-10-01_${name}.jsonl`), text);
  await chat(
    "plain",
    headerLine("plain", cwd, at(1)) +
      userLine("u1", at(1, 1), "hello") +
      assistantLine("a1", at(1, 2), "hi"),
  );
  await chat(
    "titled",
    titleSlotLine("Slot title") +
      headerLine("titled", cwd, at(2), { title: "Header title" }) +
      userLine("u1", at(2, 1), "titled chat") +
      assistantLine("a1", at(2, 2), "ok"),
  );
  await chat(
    "long-prompt",
    headerLine("long", cwd, at(3)) +
      userLine(
        "u1",
        at(3, 1),
        "Explain this very long first prompt, which goes on past the limit of a listing line. ".repeat(
          3,
        ),
      ) +
      assistantLine("a1", at(3, 2), "sure"),
  );
  await chat(
    "malformed",
    headerLine("malformed", cwd, at(4)) +
      "{not json\n" +
      userLine("u1", at(4, 1), "after a broken line") +
      assistantLine("a1", at(4, 2), "fine"),
  );
  await chat(
    "partial",
    `${headerLine("partial", cwd, at(5))}${userLine("u1", at(5, 1), "cut")}{"type":"message"`,
  );
  await chat(
    "aborted",
    headerLine("aborted", cwd, at(6)) +
      userLine("u1", at(6, 1), "stop me") +
      assistantLine("a1", at(6, 2), "partly", "aborted"),
  );
  await chat(
    "errored",
    headerLine("errored", cwd, at(7)) +
      userLine("u1", at(7, 1), "fail") +
      assistantLine("a1", at(7, 2), "", "error"),
  );
  await chat(
    "length",
    headerLine("length", cwd, at(8)) +
      userLine("u1", at(8, 1), "long answer") +
      assistantLine("a1", at(8, 2), "cut off", "length"),
  );
  await chat(
    "tool-result-last",
    headerLine("tool", cwd, at(9)) +
      userLine("u1", at(9, 1), "run it") +
      jsonLine({
        type: "message",
        id: "r1",
        timestamp: at(9, 2),
        message: { role: "toolResult", content: [] },
      }),
  );
  await chat(
    "fork",
    headerLine("fork", cwd, at(10), { parentSession: "plain" }) +
      userLine("u1", at(10, 1), "branch") +
      assistantLine("a1", at(10, 2), "branched"),
  );
  await chat(
    "crlf",
    (
      headerLine("crlf", cwd, at(11)) +
      userLine("u1", at(11, 1), "windows line endings") +
      assistantLine("a1", at(11, 2), "ok")
    ).replace(/\n/g, "\r\n"),
  );
  await chat("header-only", headerLine("empty", cwd, at(12)));
  await chat(
    "unicode",
    headerLine("unicode", cwd, at(13)) +
      userLine("u1", at(13, 1), "héllo 🌍 世界") +
      assistantLine("a1", at(13, 2), "ok"),
  );
  await chat("no-header", userLine("u1", at(14, 1), "a file with no header"));
}

describe("SessionFileStore summary cache", () => {
  test("a restart lists what a fresh read lists, with the same numbers and statuses", async () => {
    const { root, cwd, bucket, options, sessionsRoot } = await fixture();
    try {
      await writeVariants(bucket, cwd);
      const first = new SessionFileStore(options);
      const cold = await first.listSessions({ folder: cwd });
      await first.flushSummaries();

      const restarted = new SessionFileStore(options);
      const warm = await restarted.listSessions({ folder: cwd });

      const fresh = await new SessionFileStore({
        sessionsRoot,
        home: options.home,
        tempRoot: options.tempRoot,
      }).listSessions({ folder: cwd });
      expect(shown(cold)).toEqual(shown(fresh));
      expect(shown(warm)).toEqual(shown(fresh));
      expect(warm.sessions.length).toBeGreaterThan(10);
      for (const session of warm.sessions) {
        const truth = await summarizeSessionFile(session.sessionFile);
        expect({
          messageCount: session.messageCount,
          assistantTurns: session.assistantTurns,
          status: session.status,
        }).toEqual({
          messageCount: truth.messageCount,
          assistantTurns: truth.assistantTurns,
          status: truth.status,
        });
      }
      await restarted.flushSummaries();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a restart serves a chat's stored facts as they are, without reading the chat", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_stored.jsonl");
      await writeChat(chat, headerLine("stored", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.flushSummaries();
      // The chat has one message. Its stored count is changed to 99: a listing that serves the cache shows 99, and one
      // that reads the chat shows 1.
      const cacheFile = path.join(options.appDataDir, SUMMARY_CACHE_FILE);
      const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
        entries: { summary?: { messageCount: number } }[];
      };
      for (const entry of cache.entries) {
        if (entry.summary) entry.summary.messageCount = 99;
      }
      await writeFile(cacheFile, JSON.stringify(cache));

      const restarted = new SessionFileStore(options);
      const listed = await restarted.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.messageCount).toBe(99);
      await restarted.flushSummaries();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat that grew since the cache was written is listed as cached, then refreshed and published", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_grows.jsonl");
      await writeChat(
        chat,
        headerLine("grows", cwd, at(1)) +
          userLine("u1", at(1, 1), "one") +
          assistantLine("a1", at(1, 2), "two"),
      );
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.flushSummaries();
      await appendFile(chat, userLine("u2", at(1, 3), "three"));

      const restarted = new SessionFileStore(options);
      const refreshed = nextBackground(restarted, "refreshed");
      // The listing shows the cached facts: the new message is absent, so the listing did not read the chat.
      // The refresh that follows reads it in the background, so the file reads are not asserted here.
      const listed = await restarted.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.messageCount).toBe(2);
      expect(await refreshed).toEqual({ kind: "refreshed", sessionFile: chat, id: "grows", cwd });
      const after = await restarted.listSessions({ folder: cwd });
      expect(after.sessions[0]?.messageCount).toBe(3);
      await restarted.flushSummaries();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose modified time changed is refreshed in the background the same way", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_touched.jsonl");
      await writeChat(chat, headerLine("touched", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.flushSummaries();
      const later = new Date(at(2));
      await utimes(chat, later, later);

      const restarted = new SessionFileStore(options);
      const refreshed = nextBackground(restarted, "refreshed");
      const listed = await restarted.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.updatedAt).toBe(at(1, 1));
      expect(await refreshed).toMatchObject({
        kind: "refreshed",
        sessionFile: chat,
        id: "touched",
      });
      await restarted.flushSummaries();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a rename-rewrite with the same size and time is not a cache hit", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_rewritten.jsonl");
      const header = headerLine("rewritten", cwd, at(1));
      // "stop" is a complete chat and "error" an errored one: one byte longer, so the text is one byte shorter.
      await writeChat(chat, header + assistantLine("a1", at(1, 1), "x".repeat(40), "stop"));
      const modified = new Date(at(1, 2));
      await utimes(chat, modified, modified);
      const first = new SessionFileStore(options);
      expect((await first.listSessions({ folder: cwd })).sessions[0]?.status).toBe("complete");
      await first.flushSummaries();

      const replacement = path.join(bucket, "replacement.tmp");
      await writeFile(replacement, header + assistantLine("a1", at(1, 1), "x".repeat(39), "error"));
      await utimes(replacement, modified, modified);
      await rename(replacement, chat);

      const restarted = new SessionFileStore(options);
      const refreshed = nextBackground(restarted, "refreshed");
      expect((await restarted.listSessions({ folder: cwd })).sessions[0]?.status).toBe("complete");
      expect(await refreshed).toMatchObject({ kind: "refreshed", id: "rewritten" });
      expect((await restarted.listSessions({ folder: cwd })).sessions[0]?.status).toBe("error");
      await restarted.flushSummaries();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a cache of another schema is rebuilt from the chats", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_schema.jsonl");
      await writeChat(chat, headerLine("schema", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.flushSummaries();
      const cacheFile = path.join(options.appDataDir, SUMMARY_CACHE_FILE);
      const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
        entries: { summary?: { messageCount: number } }[];
      };
      for (const entry of cache.entries) {
        if (entry.summary) entry.summary.messageCount = 99;
      }
      await writeFile(cacheFile, JSON.stringify({ ...cache, summarySchema: SUMMARY_SCHEMA - 1 }));

      const restarted = new SessionFileStore(options);
      // The stored count was changed to 99: a count of 1 shows the chat was read again.
      const listed = await restarted.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.messageCount).toBe(1);
      await restarted.flushSummaries();
      const rebuilt = JSON.parse(await readFile(cacheFile, "utf8")) as { summarySchema: number };
      expect(rebuilt.summarySchema).toBe(SUMMARY_SCHEMA);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a corrupt cache file is rebuilt from the chats, and listing does not fail", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_corrupt.jsonl");
      await writeChat(chat, headerLine("corrupt", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const cacheFile = path.join(options.appDataDir, SUMMARY_CACHE_FILE);
      await mkdir(options.appDataDir, { recursive: true });
      await writeFile(cacheFile, "{ this is not a cache");

      const restarted = new SessionFileStore(options);
      const listed = await restarted.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id)).toEqual(["corrupt"]);
      expect(listed.sessions[0]?.messageCount).toBe(1);
      await restarted.flushSummaries();
      expect(await storedPaths(cacheFile)).toEqual([await fs.realpath(chat)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deleting a chat removes its cached facts from the cache file", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const kept = path.join(bucket, "2026-10-01_kept.jsonl");
      const removed = path.join(bucket, "2026-10-01_removed.jsonl");
      await writeChat(kept, headerLine("kept", cwd, at(1)));
      await writeChat(removed, headerLine("removed", cwd, at(2)));
      const store = new SessionFileStore(options);
      await store.listSessions({ folder: cwd });
      await store.flushSummaries();
      const cacheFile = path.join(options.appDataDir, SUMMARY_CACHE_FILE);
      const realKept = await fs.realpath(kept);
      const realRemoved = await fs.realpath(removed);
      expect(await storedPaths(cacheFile)).toEqual([realKept, realRemoved].sort());

      await store.deleteSession({ folder: cwd, sessionFile: removed });
      await store.flushSummaries();
      expect(await storedPaths(cacheFile)).toEqual([realKept]);
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id)).toEqual(["kept"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat changed while the server runs is read at once, as before the cache", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_live.jsonl");
      await writeChat(chat, headerLine("live", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const store = new SessionFileStore(options);
      expect((await store.listSessions({ folder: cwd })).sessions[0]?.messageCount).toBe(1);
      await store.flushSummaries();
      await appendFile(chat, assistantLine("a1", at(1, 2), "two"));
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.messageCount).toBe(2);
      expect(listed.sessions[0]?.updatedAt).toBe(at(1, 2));
      await store.flushSummaries();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat whose file is gone is dropped from the cache file when it loads", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const kept = path.join(bucket, "2026-10-01_kept.jsonl");
      const gone = path.join(bucket, "2026-10-01_gone.jsonl");
      await writeChat(kept, headerLine("kept", cwd, at(1)));
      await writeChat(gone, headerLine("gone", cwd, at(2)));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.flushSummaries();
      await rm(gone);

      const restarted = new SessionFileStore(options);
      await restarted.flushSummaries();
      expect(await storedPaths(path.join(options.appDataDir, SUMMARY_CACHE_FILE))).toEqual([
        await fs.realpath(kept),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a refresh that fails drops the chat's cached facts, reports the failure, and the next listing reads the chat", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_failing.jsonl");
      await writeChat(chat, headerLine("failing", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.close();
      await appendFile(chat, assistantLine("a1", at(1, 2), "two"));

      const failing = new SessionFileStore({
        ...options,
        summarizeFile: async () => {
          throw new Error("The disk is busy.");
        },
      });
      const failed = nextBackground(failing, "failed");
      const listed = await failing.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.messageCount).toBe(1);
      expect(await failed).toEqual({
        kind: "failed",
        sessionFile: chat,
        message: "The disk is busy.",
      });
      await failing.close();
      expect(await storedPaths(path.join(options.appDataDir, SUMMARY_CACHE_FILE))).toEqual([]);

      const next = new SessionFileStore(options);
      expect((await next.listSessions({ folder: cwd })).sessions[0]?.messageCount).toBe(2);
      await next.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a delete during a refresh cancels it: the chat stays out of the cache and the list", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_deleted.jsonl");
      await writeChat(chat, headerLine("deleted", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.close();
      await appendFile(chat, assistantLine("a1", at(1, 2), "two"));

      const held = gate();
      const deleting = new SessionFileStore({
        ...options,
        summarizeFile: async (file, size, prior) => {
          await held.wait;
          return readSummary(file, size, prior);
        },
      });
      const events: SessionBackgroundEvent[] = [];
      deleting.onBackground((event) => {
        events.push(event);
      });
      const listed = await deleting.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.messageCount).toBe(1);
      await deleting.deleteSession({ folder: cwd, sessionFile: chat });
      held.open();
      await deleting.close();

      expect(events).toEqual([]);
      expect(await storedPaths(path.join(options.appDataDir, SUMMARY_CACHE_FILE))).toEqual([]);
      const after = new SessionFileStore(options);
      expect((await after.listSessions({ folder: cwd })).sessions).toEqual([]);
      await after.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a refresh still running at close is cancelled: it reports nothing and writes nothing back", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_closing.jsonl");
      await writeChat(chat, headerLine("closing", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.close();
      await appendFile(chat, assistantLine("a1", at(1, 2), "two"));

      const held = gate();
      const closing = new SessionFileStore({
        ...options,
        summarizeFile: async (file, size, prior) => {
          await held.wait;
          return readSummary(file, size, prior);
        },
      });
      const events: SessionBackgroundEvent[] = [];
      closing.onBackground((event) => {
        events.push(event);
      });
      await closing.listSessions({ folder: cwd });
      await fs.rm(options.appDataDir, { recursive: true, force: true });

      const shutdown = closing.close();
      held.open();
      await shutdown;
      await closing.flushSummaries();

      expect(events).toEqual([]);
      await expect(fs.access(options.appDataDir)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("after close nothing is written, so a chat deleted then is dropped only at the next start", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const kept = path.join(bucket, "2026-10-01_kept.jsonl");
      const removed = path.join(bucket, "2026-10-01_removed.jsonl");
      await writeChat(kept, headerLine("kept", cwd, at(1)));
      await writeChat(removed, headerLine("removed", cwd, at(2)));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.close();
      const cacheFile = path.join(options.appDataDir, SUMMARY_CACHE_FILE);
      const before = await readFile(cacheFile, "utf8");

      const store = new SessionFileStore(options);
      await store.listSessions({ folder: cwd });
      await store.close();
      await store.deleteSession({ folder: cwd, sessionFile: removed });
      await store.flushSummaries();
      expect(await readFile(cacheFile, "utf8")).toBe(before);
      await expect(fs.access(removed)).rejects.toThrow();

      const next = new SessionFileStore(options);
      const listed = await next.listSessions({ folder: cwd });
      expect(listed.sessions.map((session) => session.id)).toEqual(["kept"]);
      await next.close();
      expect(await storedPaths(cacheFile)).toEqual([await fs.realpath(kept)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Lists a folder with a store opened on `options`, and records whether each read of a chat carried a resume state. A
   * listing after a restart serves the cached facts, and its background refresh is awaited before the second listing.
   */
  async function listAfterRestart(
    options: Fixture["options"],
    cwd: string,
  ): Promise<{ readonly priors: boolean[]; readonly messageCount: number | undefined }> {
    const priors: boolean[] = [];
    const store = new SessionFileStore({
      ...options,
      summarizeFile: async (file, size, prior) => {
        priors.push(prior !== undefined);
        return readSummary(file, size, prior);
      },
    });
    try {
      const refreshed = nextBackground(store, "refreshed");
      await store.listSessions({ folder: cwd });
      await refreshed;
      const listed = await store.listSessions({ folder: cwd });
      return { priors, messageCount: listed.sessions[0]?.messageCount };
    } finally {
      await store.close();
    }
  }

  /** Removes the resume state of every cache entry: what a cache written before resume states holds. */
  async function dropResumeStates(file: string): Promise<void> {
    const cache = JSON.parse(await readFile(file, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    for (const entry of cache.entries) delete entry.resume;
    await writeFile(file, JSON.stringify(cache), "utf8");
  }

  test("a restart reads a grown chat from the cache's resume state: the background refresh folds only the appended line", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_resumes.jsonl");
      await writeChat(chat, headerLine("resumes", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.close();
      await appendFile(chat, assistantLine("a1", at(1, 2), "two"));

      const restarted = await listAfterRestart(options, cwd);
      expect(restarted.priors).toEqual([true]);
      expect(restarted.messageCount).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a cache entry written before resume states gets one whole read at its next change, then resumes", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_legacy.jsonl");
      await writeChat(chat, headerLine("legacy", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const first = new SessionFileStore(options);
      await first.listSessions({ folder: cwd });
      await first.close();
      await dropResumeStates(path.join(options.appDataDir, SUMMARY_CACHE_FILE));

      await appendFile(chat, assistantLine("a1", at(1, 2), "two"));
      const whole = await listAfterRestart(options, cwd);
      expect(whole.priors).toEqual([false]);
      expect(whole.messageCount).toBe(2);

      await appendFile(chat, userLine("u2", at(1, 3), "three"));
      const resumed = await listAfterRestart(options, cwd);
      expect(resumed.priors).toEqual([true]);
      expect(resumed.messageCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat that grows in one run is read from its resume state; a chat replaced by a new file is read whole", async () => {
    const { root, cwd, bucket, options } = await fixture();
    try {
      const chat = path.join(bucket, "2026-10-01_replaced.jsonl");
      await writeChat(chat, headerLine("replaced", cwd, at(1)) + userLine("u1", at(1, 1), "one"));
      const priors: boolean[] = [];
      const store = new SessionFileStore({
        ...options,
        summarizeFile: async (file, size, prior) => {
          priors.push(prior !== undefined);
          return readSummary(file, size, prior);
        },
      });
      try {
        await store.listSessions({ folder: cwd });
        await appendFile(chat, assistantLine("a1", at(1, 2), "two"));
        expect((await store.listSessions({ folder: cwd })).sessions[0]?.messageCount).toBe(2);

        const replacement = path.join(root, "replacement.jsonl");
        await writeChat(
          replacement,
          headerLine("replaced", cwd, at(1)) +
            userLine("u1", at(1, 1), "one") +
            assistantLine("a1", at(1, 2), "two") +
            userLine("u2", at(1, 3), "three"),
        );
        await rename(replacement, chat);
        expect((await store.listSessions({ folder: cwd })).sessions[0]?.messageCount).toBe(3);
      } finally {
        await store.close();
      }
      expect(priors).toEqual([false, true, false]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

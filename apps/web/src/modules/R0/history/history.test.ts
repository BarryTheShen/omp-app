import type {
  ChatSessionEvent,
  ChatSessionRequest,
  EntryId,
  OmpWire,
  SessionEntryWindow,
  SessionEntryWindowArgs,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, EntryId as EntryIdSchema, SessionFilePath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store/store";
import {
  SessionHistoryLoader,
  type SessionOutputReader,
  type SessionWindowReader,
} from "./history";

const threadId = "thread-h" as ThreadId;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/** A `process` envelope event, as the real transport would deliver it. */
function processEvent(status: string): ChatSessionEvent {
  return { kind: "process", status } as ChatSessionEvent;
}

function entry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  };
}

interface FileEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly raw: Record<string, unknown>;
}

function fileEntry(id: string, parentId: string | null, text: string): FileEntry {
  return { id, parentId, raw: entry(id, parentId, text) };
}
function boundaryFileEntry(id: string, parentId: string | null): FileEntry {
  return {
    id,
    parentId,
    raw: {
      type: "reset_boundary",
      id,
      parentId,
      timestamp: "2026-10-05T00:01:00.000Z",
    },
  };
}

/**
 * A session file's windows, read the way A1's `readEntryWindow` reads them: the branch from the leaf
 * (default: the file's last entry), `pageSize` entries at a time, newest first, `before` for the
 * window older than an entry. Every request is recorded in `calls`.
 */
function windowsOf(
  file: readonly FileEntry[],
  pageSize: number,
  calls: SessionEntryWindowArgs[] = [],
): SessionWindowReader {
  const byId = new Map(file.map((item) => [item.id, item] as const));
  return async (args) => {
    calls.push(args);
    const fileLast = file.at(-1)?.id;
    const leaf = args.leafId ?? fileLast;
    const fileLastId = fileLast === undefined ? null : EntryIdSchema.parse(fileLast);
    if (leaf === undefined) {
      return {
        sessionFile: args.sessionFile,
        leafId: null,
        fileLastId,
        entries: [],
        oldestId: null,
        hasOlder: false,
      };
    }
    const branch: FileEntry[] = [];
    let current = byId.get(leaf);
    while (current !== undefined) {
      branch.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    const start =
      args.before === undefined ? 0 : branch.findIndex((item) => item.id === args.before) + 1;
    const page = branch.slice(start, start + pageSize);
    const oldest = page.at(-1);
    return {
      sessionFile: args.sessionFile,
      leafId: EntryIdSchema.parse(leaf),
      fileLastId,
      entries: page.reverse().map((item) => item.raw),
      oldestId: oldest === undefined ? null : EntryIdSchema.parse(oldest.id),
      hasOlder: start + page.length < branch.length,
    };
  };
}

/** Never called: a test that reads no window has no session file, so it must not ask for one. */
const noWindows: SessionWindowReader = async () => {
  throw new Error("this test has no session file to read a window from");
};

interface SendCall {
  readonly type: string;
  readonly args: unknown;
}

/** Answers one request from its params. */
type CommandHandler = (params: Record<string, unknown>, signal?: AbortSignal) => unknown;

function makeSend(
  handlers: Partial<Record<string, CommandHandler>>,
  calls: SendCall[] = [],
): { send: ChatSessionRequest; calls: SendCall[] } {
  const send = (async (
    args: { method: string; params: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ) => {
    calls.push({ type: args.method, args });
    const handler = handlers[args.method];
    if (!handler) throw new Error(`no handler for ${args.method}`);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new AppFailure({
        code: "cancelled",
        message: "aborted before dispatch",
        retryable: false,
      });
    }
    const resultPromise = Promise.resolve().then(() => handler(args.params, signal));
    if (!signal) return resultPromise;
    const raced = Promise.withResolvers<unknown>();
    const onAbort = (): void => {
      raced.reject(
        new AppFailure({ code: "cancelled", message: "aborted mid-flight", retryable: false }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    resultPromise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        raced.resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        raced.reject(error);
      },
    );
    return raced.promise;
  }) as unknown as ChatSessionRequest;
  return { send, calls };
}

function sinceOf(command: Record<string, unknown>): string | undefined {
  const since = command.since;
  return typeof since === "string" ? since : undefined;
}

describe("SessionHistoryLoader.loadInitial", () => {
  test("hydrates state and entries, never asks for the tree, then establishes a fresh sequence baseline", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1", isStreaming: false }),
      get_entries: () => ({ entries: [entry("a", null, "hi")], leafId: "a" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    await loader.loadInitial();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
    const snapshot = store.getSnapshot();
    expect(snapshot.needsRefetch).toBe(false);
    expect(snapshot.lastSeq).toBe(0);
    expect(snapshot.transcript.order).toEqual(["a"]);
    expect(snapshot.transcript.head).toBe("a");

    // A fresh baseline means the very next live event must be seq 1.
    store.ingest(processEvent("running"), 1);
    expect(store.getSnapshot().needsRefetch).toBe(false);
  });

  test("reads the newest window from the session file, and confirms the leaf with omp's since", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const windowCalls: SessionEntryWindowArgs[] = [];
    const file = [
      fileEntry("a", null, "one"),
      fileEntry("b", "a", "two"),
      fileEntry("c", "b", "three"),
    ];
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: (command) =>
        sinceOf(command) === "c" ? { entries: [], leafId: "c" } : { entries: [], leafId: null },
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf(file, 2, windowCalls),
    });

    await loader.loadInitial();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
    expect(windowCalls[0]).toEqual({ sessionFile: "/work/s1.jsonl", byteBudget: 256 * 1024 });
    const snapshot = store.getSnapshot();
    expect(snapshot.transcript.order).toEqual(["b", "c"]);
    expect(snapshot.transcript.head).toBe("c");
    expect(snapshot.transcript.hasOlder).toBe(true);
    loader.dispose();
  });

  test("fills the default window in the background after the small first page", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const sessionFile = SessionFilePath.parse("/work/s1.jsonl");
    const windowCalls: SessionEntryWindowArgs[] = [];
    const names = Array.from({ length: 80 }, (_, index) => `e${index}`);
    const file = names.map((id, index) =>
      fileEntry(id, index === 0 ? null : (names[index - 1] ?? null), id),
    );
    const backgroundRequest = createDeferred<SessionEntryWindowArgs>();
    const backgroundResponse = createDeferred<SessionEntryWindow>();
    const smallReader = windowsOf(file, names.length);
    const readWindow: SessionWindowReader = async (args, options) => {
      windowCalls.push(args);
      if (args.byteBudget !== undefined) return smallReader(args, options);
      backgroundRequest.resolve(args);
      return backgroundResponse.promise;
    };
    const defaultWindow = await windowsOf(file, 60)(
      { sessionFile, leafId: EntryIdSchema.parse("e79") },
      { signal: new AbortController().signal },
    );
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile }),
      get_entries: () => ({ entries: [], leafId: "e79" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow });
    try {
      await loader.loadInitial();

      expect(windowCalls[0]).toEqual({
        sessionFile,
        byteBudget: 256 * 1024,
      });
      expect(store.getSnapshot().transcript.order).toEqual(names.slice(30));
      expect(store.getSnapshot().transcript.hasOlder).toBe(true);

      const fillArgs = await backgroundRequest.promise;
      expect(fillArgs).toEqual({
        sessionFile,
        leafId: EntryIdSchema.parse("e79"),
      });
      expect(store.getSnapshot().transcript.order).toEqual(names.slice(30));
      backgroundResponse.resolve(defaultWindow);
      await flushMicrotasks();

      const order = store.getSnapshot().transcript.order;
      expect(order).toEqual(defaultWindow.entries.map((item) => item.id));
      expect(new Set(order).size).toBe(defaultWindow.entries.length);
      expect(store.getSnapshot().transcript.hasOlder).toBe(defaultWindow.hasOlder);
      expect(windowCalls).toEqual([
        { sessionFile, byteBudget: 256 * 1024 },
        { sessionFile, leafId: EntryIdSchema.parse("e79") },
      ]);
    } finally {
      backgroundResponse.resolve(defaultWindow);
      loader.dispose();
    }
  });

  test("reads the window again from omp's leaf when that is not the file's newest branch", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const windowCalls: SessionEntryWindowArgs[] = [];
    // The file's last entry (x) is on a branch omp has left; omp is on b.
    const file = [
      fileEntry("a", null, "root"),
      fileEntry("b", "a", "omp leaf"),
      fileEntry("x", "a", "other"),
    ];
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "b" }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf(file, 10, windowCalls),
    });

    await loader.loadInitial();

    expect(windowCalls).toEqual([
      { sessionFile: "/work/s1.jsonl", byteBudget: 256 * 1024 },
      { sessionFile: "/work/s1.jsonl", leafId: EntryIdSchema.parse("b"), byteBudget: 256 * 1024 },
    ]);
    expect(store.getSnapshot().transcript.order).toEqual(["a", "b"]);
    expect(store.getSnapshot().transcript.head).toBe("b");
  });

  test("falls back to omp's entries when the thread has no session file", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({ entries: [entry("a", null, "in memory")], leafId: "a" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    await loader.loadInitial();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
    expect(store.getSnapshot().transcript.order).toEqual(["a"]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(false);
  });
  test("starts the transcript after the latest omp reset boundary", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({
        entries: [
          entry("old", null, "before clear"),
          {
            type: "reset_boundary",
            id: "clear-1",
            parentId: "old",
            timestamp: "2026-10-05T00:01:00.000Z",
          },
          entry("middle", "clear-1", "after first clear"),
          {
            type: "reset_boundary",
            id: "clear-2",
            parentId: "middle",
            timestamp: "2026-10-05T00:02:00.000Z",
          },
          entry("new", "clear-2", "after second clear"),
        ],
        leafId: "new",
      }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    await loader.loadInitial();

    expect(store.getSnapshot().transcript.order).toEqual(["new"]);
    expect(store.getSnapshot().messageOrder).toEqual([`entry:${threadId}:new`]);
  });
  test("cuts a session-file window at its boundary and closes its older cursor", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const file = [
      fileEntry("old1", null, "old one"),
      fileEntry("old2", "old1", "old two"),
      boundaryFileEntry("clear", "old2"),
      fileEntry("new1", "clear", "new one"),
      fileEntry("new2", "new1", "new two"),
    ];
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "new2" }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf(file, 4),
    });
    await loader.loadInitial();
    expect(store.getSnapshot().transcript.order).toEqual(["new1", "new2"]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(false);
  });

  test("cuts live entries when the session-file window is empty and omp has no leaf", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({
        entries: [
          entry("old", null, "old"),
          {
            type: "reset_boundary",
            id: "clear",
            parentId: "old",
            timestamp: "2026-10-05T00:01:00.000Z",
          },
          entry("new", "clear", "new"),
        ],
        leafId: null,
      }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf([], 4),
    });
    await loader.loadInitial();
    expect(store.getSnapshot().transcript.order).toEqual(["new"]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(false);
  });

  test("keeps a just-cleared chat empty, then shows a message parented to its boundary", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({
        entries: [
          entry("old", null, "old"),
          {
            type: "reset_boundary",
            id: "clear",
            parentId: "old",
            timestamp: "2026-10-05T00:01:00.000Z",
          },
        ],
        leafId: "clear",
      }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });
    await loader.loadInitial();
    expect(store.getSnapshot().transcript.order).toEqual([]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(false);

    store.pairEndedMessages([entry("after", "clear", "after clear")], "after" as EntryId);
    expect(store.getSnapshot().transcript.order).toEqual(["after"]);
    expect(store.getSnapshot().messageOrder).toEqual([`entry:${threadId}:after`]);
  });
});

describe("SessionHistoryLoader.loadInitial before a session file is written", () => {
  test("falls back to omp's entries while a new chat's session file is not written yet", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [entry("a", null, "first message")], leafId: "a" }),
    });
    const notWritten: SessionWindowReader = async () => {
      throw new AppFailure({
        code: "not_found",
        message: "Session file is not listed",
        retryable: false,
      });
    };
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: notWritten });

    await loader.loadInitial();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
    expect(store.getSnapshot().transcript.order).toEqual(["a"]);
  });
});

describe("SessionHistoryLoader.loadOlder", () => {
  test("cuts paging at a boundary and stops requesting older pages", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const windowCalls: SessionEntryWindowArgs[] = [];
    const file = [
      fileEntry("old1", null, "old one"),
      boundaryFileEntry("clear", "old1"),
      fileEntry("mid", "clear", "middle"),
      fileEntry("x", "mid", "x"),
      fileEntry("y", "x", "y"),
    ];
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "y" }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf(file, 2, windowCalls),
    });
    await loader.loadInitial();
    expect(store.getSnapshot().transcript.order).toEqual(["x", "y"]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(true);

    await loader.loadOlder();
    expect(store.getSnapshot().transcript.order).toEqual(["mid", "x", "y"]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(false);
    const requests = windowCalls.length;
    await loader.loadOlder();
    expect(windowCalls).toHaveLength(requests);
  });
  test("pages older entries in front of the transcript, on the branch the head shows", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const windowCalls: SessionEntryWindowArgs[] = [];
    const file = ["a", "b", "c", "d", "e"].map((id, index) =>
      fileEntry(id, index === 0 ? null : (["a", "b", "c", "d", "e"][index - 1] ?? null), id),
    );
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "e" }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf(file, 2, windowCalls),
    });
    await loader.loadInitial();
    expect(store.getSnapshot().transcript.order).toEqual(["d", "e"]);

    await loader.loadOlder();
    expect(windowCalls.at(-1)).toMatchObject({ leafId: "e", before: "d" });
    expect(windowCalls.at(-1)).not.toHaveProperty("byteBudget");
    expect(store.getSnapshot().transcript.order).toEqual(["b", "c", "d", "e"]);
    expect(store.getSnapshot().transcript.head).toBe("e");
    expect(store.getSnapshot().transcript.hasOlder).toBe(true);

    await loader.loadOlder();
    expect(windowCalls.at(-1)).toMatchObject({ leafId: "e", before: "b" });
    expect(windowCalls.at(-1)).not.toHaveProperty("byteBudget");
    expect(store.getSnapshot().transcript.order).toEqual(["a", "b", "c", "d", "e"]);
    expect(store.getSnapshot().transcript.hasOlder).toBe(false);
    expect(store.getSnapshot().messageOrder).toEqual(
      ["a", "b", "c", "d", "e"].map((id) => `entry:${threadId}:${id}`),
    );

    const requests = windowCalls.length;
    await loader.loadOlder();
    expect(windowCalls).toHaveLength(requests);
  });

  test("shares one page request between concurrent callers", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const windowCalls: SessionEntryWindowArgs[] = [];
    const file = [fileEntry("a", null, "a"), fileEntry("b", "a", "b"), fileEntry("c", "b", "c")];
    const windows = windowsOf(file, 1, windowCalls);
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "c" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: windows });
    await loader.loadInitial();

    await Promise.all([loader.loadOlder(), loader.loadOlder()]);
    expect(windowCalls.filter((call) => call.before !== undefined)).toHaveLength(1);
  });

  test("cancels a page in flight when the loader is disposed", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const file = [fileEntry("a", null, "a"), fileEntry("b", "a", "b"), fileEntry("c", "b", "c")];
    const initial = windowsOf(file, 1);
    const readWindow: SessionWindowReader = (args, options) => {
      if (args.before === undefined) return initial(args, options);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted at the reader")), {
          once: true,
        });
      });
    };
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "c" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow });
    await loader.loadInitial();

    const older = loader.loadOlder();
    loader.dispose();

    await expect(older).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(store.getSnapshot().transcript.order).toEqual(["c"]);
  });
});

describe("SessionHistoryLoader.refetch", () => {
  test("pages since the latest known entry and stays idempotent across repeated refetches", async () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest(processEvent("ready"), 5);
    expect(store.getSnapshot().needsRefetch).toBe(true);

    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: (command) =>
        sinceOf(command) === undefined
          ? { entries: [entry("a", null, "hi"), entry("b", "a", "there")], leafId: "b" }
          : { entries: [], leafId: "b" },
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    await loader.refetch();
    expect(store.getSnapshot().needsRefetch).toBe(false);
    // The cursor resumes at the highest seq seen (5), so the next live event (6) applies.
    expect(store.getSnapshot().lastSeq).toBe(5);
    expect(store.getSnapshot().transcript.order).toEqual(["a", "b"]);

    calls.length = 0;
    await loader.refetch();
    const secondEntriesCall = calls.find((call) => call.type === "get_entries");
    expect(secondEntriesCall?.args).toMatchObject({ params: { since: "b" } });
    expect(store.getSnapshot().transcript.order).toEqual(["a", "b"]);
    // History messages show once, in branch order, however often the history is refetched.
    expect(store.getSnapshot().messageOrder).toEqual([
      `entry:${threadId}:a`,
      `entry:${threadId}:b`,
    ]);
  });

  test("falls back to a full reload when the known watermark is unknown to omp", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send: initialSend } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({ entries: [entry("a", null, "hi")], leafId: "a" }),
    });
    await new SessionHistoryLoader({
      send: initialSend,
      threadId,
      store,
      readWindow: noWindows,
    }).loadInitial();

    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: (command) => {
        if (sinceOf(command) === "a") {
          throw new AppFailure({
            code: "omp_error",
            message: "unknown since",
            retryable: false,
            omp: { command: "get_entries", error: "unknown since", code: "unknown_since" },
          });
        }
        return { entries: [entry("x", null, "fresh"), entry("y", "x", "fresh2")], leafId: "y" };
      },
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    await loader.refetch();

    const entriesCalls = calls.filter((call) => call.type === "get_entries");
    expect(entriesCalls).toHaveLength(2);
    expect(store.getSnapshot().transcript.order).toEqual(["a", "x", "y"]);
  });

  test("re-reads the newest window, not the whole history, when omp no longer knows the watermark", async () => {
    const store = new OmpRuntimeStore({ threadId });
    let current = [fileEntry("a", null, "one")];
    let rewritten = false;
    const windowCalls: SessionEntryWindowArgs[] = [];
    const readWindow: SessionWindowReader = (args, options) =>
      windowsOf(current, 10, windowCalls)(args, options);
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: (command) => {
        if (rewritten && sinceOf(command) === "a") {
          throw new AppFailure({
            code: "omp_error",
            message: "unknown since",
            retryable: false,
            omp: { command: "get_entries", error: "unknown since", code: "unknown_since" },
          });
        }
        return { entries: [], leafId: sinceOf(command) === "y" ? "y" : "a" };
      },
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow });
    await loader.loadInitial();
    expect(store.getSnapshot().transcript.order).toEqual(["a"]);

    rewritten = true;
    current = [fileEntry("x", null, "fresh"), fileEntry("y", "x", "fresh2")];
    await loader.refetch();

    expect(windowCalls).toHaveLength(2);
    expect(windowCalls).toEqual([
      { sessionFile: "/work/s1.jsonl", byteBudget: 256 * 1024 },
      { sessionFile: "/work/s1.jsonl" },
    ]);
    expect(calls.filter((call) => call.type === "get_entries")).toHaveLength(3);
    expect(store.getSnapshot().transcript.order).toEqual(["a", "x", "y"]);
    expect(store.getSnapshot().transcript.head).toBe("y");
  });

  test("a new load cancels the one in flight with a typed AppFailure, and the new one still resolves", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const firstState = createDeferred<OmpWire.SessionState>();
    let stateCallIndex = 0;
    const { send } = makeSend({
      get_state: () => {
        stateCallIndex += 1;
        return stateCallIndex === 1 ? firstState.promise : { sessionId: "s2" };
      },
      get_entries: () => ({ entries: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    const first = loader.loadInitial();
    const second = loader.refetch();

    await expect(first).rejects.toBeInstanceOf(AppFailure);
    await expect(first).rejects.toMatchObject({ appError: { code: "cancelled" } });
    await expect(second).resolves.toBeUndefined();
    firstState.resolve({ sessionId: "s1" });
  });

  test("an externally aborted signal rejects with a cancelled AppFailure", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const pending = createDeferred<OmpWire.SessionState>();
    const { send } = makeSend({
      get_state: () => pending.promise,
      get_entries: () => ({ entries: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });
    const controller = new AbortController();

    const result = loader.loadInitial({ signal: controller.signal });
    controller.abort("component unmounted");

    await expect(result).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });

  test("wraps a plain Error as a typed AppFailure", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send } = makeSend({
      get_state: () => {
        throw new Error("boom");
      },
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    await expect(loader.loadInitial()).rejects.toMatchObject({
      appError: { code: "internal", message: "boom" },
    });
  });
});

describe("SessionHistoryLoader.loadFullOutput", () => {
  test("replaces a shortened tool output with the full entry read from the session file", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const file = [
      fileEntry("u1", null, "run it"),
      { id: "t2", parentId: "u1", raw: toolResultEntry("t2", "u1", "SHORT") },
    ];
    const readOutput: SessionOutputReader = async (args) => ({
      entry: toolResultEntry(args.entryId, "u1", "FULL output"),
    });
    const { send } = makeSend({
      get_state: () => ({ sessionId: "s1", sessionFile: "/work/s1.jsonl" }),
      get_entries: () => ({ entries: [], leafId: "t2" }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: windowsOf(file, 10),
      readOutput,
    });
    await loader.loadInitial();
    expect(JSON.stringify(store.getSnapshot().messages)).toContain("SHORT");

    await loader.loadFullOutput("call-1");

    expect(JSON.stringify(store.getSnapshot().messages)).toContain("FULL output");
    expect(JSON.stringify(store.getSnapshot().messages)).not.toContain("SHORT");
  });
});

function toolResultEntry(id: string, parentId: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    },
  };
}

describe("SessionHistoryLoader.watchNeedsRefetch", () => {
  test("does nothing until a gap is detected, then refetches exactly once and clears it", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({ entries: [entry("a", null, "hi")], leafId: "a" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });

    const unsubscribe = loader.watchNeedsRefetch();
    expect(calls).toHaveLength(0);

    store.ingest(processEvent("ready"), 5);
    await flushMicrotasks();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
    expect(store.getSnapshot().needsRefetch).toBe(false);
    unsubscribe();
  });

  test("reports a genuine refetch failure but not a superseded one", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const failing = createDeferred<OmpWire.SessionState>();
    const errors: AppFailure[] = [];
    let stateCallIndex = 0;
    const { send } = makeSend({
      get_state: () => {
        stateCallIndex += 1;
        return stateCallIndex === 1 ? failing.promise : { sessionId: "s2" };
      },
      get_entries: () => ({ entries: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
      readWindow: noWindows,
      onRefetchError: (error) => errors.push(error),
    });
    const unsubscribe = loader.watchNeedsRefetch();

    store.ingest(processEvent("ready"), 5);
    await flushMicrotasks();
    // Superseding the automatic refetch must not surface an error for it.
    const manual = loader.refetch();
    await flushMicrotasks();
    failing.reject(new AppFailure({ code: "omp_error", message: "disconnected", retryable: true }));
    await flushMicrotasks();

    expect(errors).toHaveLength(0);
    await expect(manual).resolves.toBeUndefined();
    unsubscribe();
  });

  test("a gap that opens during a settled-turn refresh still gets its refetch", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const heldState = createDeferred<unknown>();
    let stateCalls = 0;
    const { send } = makeSend({
      get_state: () => {
        stateCalls += 1;
        return stateCalls === 1 ? heldState.promise : { sessionId: "s2" };
      },
      get_entries: () => ({ entries: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });
    const unsubscribe = loader.watchNeedsRefetch();

    // The refresh that follows a settled turn is still in flight when the stream reports a gap.
    const refresh = loader.refreshAfterTurn();
    store.ingest(processEvent("ready"), 5);
    heldState.resolve({ sessionId: "s1" });
    await refresh.catch(() => undefined);
    await flushMicrotasks(50);

    expect(store.getSnapshot().needsRefetch).toBe(false);
    unsubscribe();
  });
});

describe("SessionHistoryLoader and a run that starts while the load's answer is on its way", () => {
  test("a get_state answer asked before the run started does not end the run", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const answer = createDeferred<unknown>();
    const { send } = makeSend({
      get_state: () => answer.promise,
      get_entries: () => ({ entries: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store, readWindow: noWindows });
    const loading = loader.loadInitial();
    await flushMicrotasks();
    // The run's first event reaches the store while omp's answer to the load's get_state is still on its way.
    store.ingest({ kind: "event", event: { type: "agent_start" } } as ChatSessionEvent, 1);
    answer.resolve({ sessionId: "s1", isStreaming: false });
    await loading;
    expect(store.getSnapshot().prompt.streaming).toBe(true);
  });
});

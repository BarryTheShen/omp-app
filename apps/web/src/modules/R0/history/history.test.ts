import type { OmpWire, RpcSessionEvent, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store/store";
import { flattenSessionTree, SessionHistoryLoader } from "./history";

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
function processEvent(status: string): RpcSessionEvent {
  return { kind: "process", status } as RpcSessionEvent;
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

interface SendCall {
  readonly type: string;
  readonly args: unknown;
}

type CommandHandler = (command: Record<string, unknown>, signal?: AbortSignal) => unknown;

function makeSend(
  handlers: Partial<Record<string, CommandHandler>>,
  calls: SendCall[] = [],
): { send: RpcSessionSend; calls: SendCall[] } {
  const send = (async (
    args: { command: Record<string, unknown> & { type: string } },
    options?: { signal?: AbortSignal },
  ) => {
    calls.push({ type: args.command.type, args });
    const handler = handlers[args.command.type];
    if (!handler) throw new Error(`no handler for ${args.command.type}`);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new AppFailure({
        code: "cancelled",
        message: "aborted before dispatch",
        retryable: false,
      });
    }
    const resultPromise = Promise.resolve().then(() => handler(args.command, signal));
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
  }) as unknown as RpcSessionSend;
  return { send, calls };
}

function idOf(value: unknown): string {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  throw new Error("expected an entry with a string id");
}

function sinceOf(command: Record<string, unknown>): string | undefined {
  const since = command.since;
  return typeof since === "string" ? since : undefined;
}

describe("flattenSessionTree", () => {
  test("flattens nested branches parent before children, siblings in order", () => {
    const tree = [
      {
        entry: entry("a", null, "root"),
        children: [
          { entry: entry("b", "a", "left"), children: [] },
          {
            entry: entry("c", "a", "right"),
            children: [{ entry: entry("d", "c", "grandchild"), children: [] }],
          },
        ],
      },
    ];
    const flat = flattenSessionTree(tree);
    expect(flat.map(idOf)).toEqual(["a", "b", "c", "d"]);
  });

  test("skips malformed nodes without throwing", () => {
    expect(
      flattenSessionTree([null, 42, { entry: entry("a", null, "x"), children: "not-an-array" }]),
    ).toEqual([entry("a", null, "x")]);
  });
});

describe("SessionHistoryLoader.loadInitial", () => {
  test("hydrates state, entries and tree, then establishes a fresh sequence baseline", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1", isStreaming: false }),
      get_entries: () => ({ entries: [entry("a", null, "hi")], leafId: "a" }),
      get_tree: () => ({ tree: [{ entry: entry("a", null, "hi"), children: [] }], leafId: "a" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store });

    await loader.loadInitial();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_tree", "get_entries"]);
    const snapshot = store.getSnapshot();
    expect(snapshot.needsRefetch).toBe(false);
    expect(snapshot.lastSeq).toBe(0);
    expect(snapshot.transcript.order).toEqual(["a"]);
    expect(snapshot.transcript.head).toBe("a");

    // A fresh baseline means the very next live event must be seq 1.
    store.ingest(processEvent("running"), 1);
    expect(store.getSnapshot().needsRefetch).toBe(false);
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
      get_tree: () => ({
        tree: [
          {
            entry: entry("a", null, "hi"),
            children: [{ entry: entry("b", "a", "there"), children: [] }],
          },
        ],
        leafId: "b",
      }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store });

    await loader.refetch();
    expect(store.getSnapshot().needsRefetch).toBe(false);
    // The cursor resumes at the highest seq seen (5), so the next live event (6) applies.
    expect(store.getSnapshot().lastSeq).toBe(5);
    expect(store.getSnapshot().transcript.order).toEqual(["a", "b"]);

    calls.length = 0;
    await loader.refetch();
    const secondEntriesCall = calls.find((call) => call.type === "get_entries");
    expect(secondEntriesCall?.args).toMatchObject({ command: { since: "b" } });
    expect(store.getSnapshot().transcript.order).toEqual(["a", "b"]);
    expect(store.getSnapshot().messageOrder).toEqual([]);
  });

  test("falls back to a full reload when the known watermark is unknown to omp", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send: initialSend } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({ entries: [entry("a", null, "hi")], leafId: "a" }),
      get_tree: () => ({ tree: [{ entry: entry("a", null, "hi"), children: [] }], leafId: "a" }),
    });
    await new SessionHistoryLoader({ send: initialSend, threadId, store }).loadInitial();

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
      get_tree: () => ({ tree: [], leafId: "y" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store });

    await loader.refetch();

    const entriesCalls = calls.filter((call) => call.type === "get_entries");
    expect(entriesCalls).toHaveLength(2);
    expect(store.getSnapshot().transcript.order).toEqual(["a", "x", "y"]);
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
      get_tree: () => ({ tree: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store });

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
      get_tree: () => ({ tree: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store });
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
    const loader = new SessionHistoryLoader({ send, threadId, store });

    await expect(loader.loadInitial()).rejects.toMatchObject({
      appError: { code: "internal", message: "boom" },
    });
  });
});

describe("SessionHistoryLoader.watchNeedsRefetch", () => {
  test("does nothing until a gap is detected, then refetches exactly once and clears it", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const { send, calls } = makeSend({
      get_state: () => ({ sessionId: "s1" }),
      get_entries: () => ({ entries: [entry("a", null, "hi")], leafId: "a" }),
      get_tree: () => ({ tree: [{ entry: entry("a", null, "hi"), children: [] }], leafId: "a" }),
    });
    const loader = new SessionHistoryLoader({ send, threadId, store });

    const unsubscribe = loader.watchNeedsRefetch();
    expect(calls).toHaveLength(0);

    store.ingest(processEvent("ready"), 5);
    await flushMicrotasks();

    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_tree", "get_entries"]);
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
      get_tree: () => ({ tree: [], leafId: null }),
    });
    const loader = new SessionHistoryLoader({
      send,
      threadId,
      store,
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
});

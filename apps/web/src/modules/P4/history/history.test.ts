import type { ChatSessionRequest, SessionEntryHead, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { EntryCursor, SessionTreePort, TreeSnapshot } from "../contract";
import { IncrementalHistoryCursor, OmpSessionTreePort, SelectedThreadHistoryReconciler } from ".";

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;

function entry(id: string, parentId: string | null): SessionEntryHead {
  return {
    type: "message",
    id: id as SessionEntryHead["id"],
    parentId: parentId as SessionEntryHead["parentId"],
    timestamp: `2026-10-05T00:00:0${id.slice(-1)}.000Z`,
    unknownField: { retained: true },
  };
}
interface WireTreeNode extends Record<string, unknown> {
  readonly entry: SessionEntryHead;
  readonly children: readonly WireTreeNode[];
  readonly label?: string;
}

function tree(threadId: ThreadId, entries: readonly SessionEntryHead[]): TreeSnapshot {
  return {
    threadId,
    sessionFile: null,
    tree: entries.map((item) => ({ entry: item, children: [] })),
    leafId: entries.at(-1)?.id ?? null,
    labels: [],
    labelsCapability: "unavailable",
  };
}

class FakeTreePort implements SessionTreePort {
  public readonly loadCalls: ThreadId[] = [];
  public readonly afterCalls: Array<{ threadId: ThreadId; since: string }> = [];
  public readonly entries = new Map<ThreadId, SessionEntryHead[]>();
  public compacted = false;
  public overlap = false;

  public constructor() {
    this.entries.set(threadA, [
      entry("a-1", null),
      entry("a-2", "a-1"),
      entry("a-3", "a-2"),
      entry("a-4", "a-3"),
      entry("a-5", "a-4"),
    ]);
    this.entries.set(threadB, [entry("b-1", null), entry("b-2", "b-1")]);
  }

  public async load(threadId: ThreadId): Promise<EntryCursor> {
    this.loadCalls.push(threadId);
    const entries = this.entries.get(threadId) ?? [];
    return { threadId, entries, leafId: entries.at(-1)?.id ?? null, nextSince: entries.at(-1)?.id };
  }

  public async loadAfter(threadId: ThreadId, since: string): Promise<EntryCursor> {
    this.afterCalls.push({ threadId, since });
    if (this.compacted) {
      throw new AppFailure({
        code: "omp_error",
        message: "history compacted",
        retryable: false,
        omp: { command: "get_entries", error: "unknown since", code: "unknown_since" },
      });
    }
    const entries = this.entries.get(threadId) ?? [];
    const index = entries.findIndex((item) => item.id === since);
    if (index < 0) {
      throw new AppFailure({
        code: "omp_error",
        message: "unknown since",
        retryable: false,
        omp: { command: "get_entries", error: "unknown since", code: "unknown_since" },
      });
    }
    const next = entries.slice(index + 1);
    if (this.overlap) next.unshift(entries[index] as SessionEntryHead);
    return {
      threadId,
      entries: next,
      leafId: entries.at(-1)?.id ?? null,
      nextSince: next.at(-1)?.id,
    };
  }

  public async readTree(threadId: ThreadId): Promise<TreeSnapshot> {
    return tree(threadId, this.entries.get(threadId) ?? []);
  }

  public subscribe(_threadId: ThreadId, _listener: (snapshot: TreeSnapshot) => void): () => void {
    return () => {};
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("OmpSessionTreePort", () => {
  test("maps get_entries/get_tree while retaining unknown entry fields and labels", async () => {
    const commands: string[] = [];
    const send = (async (args: { method: string }) => {
      commands.push(args.method);
      if (args.method === "get_entries") {
        return { entries: [entry("a-1", null)], leafId: "a-1" };
      }
      return {
        tree: [
          {
            entry: entry("a-1", null),
            children: [],
            label: "checkpoint",
          },
        ],
        leafId: "a-1",
      };
    }) as unknown as ChatSessionRequest;
    const port = new OmpSessionTreePort({ send });

    const cursor = await port.load(threadA);
    const snapshot = await port.readTree(threadA);

    expect(commands).toEqual(["get_entries", "get_tree"]);
    expect(cursor.entries[0]).toMatchObject({ id: "a-1", unknownField: { retained: true } });
    expect(snapshot.tree[0]?.label?.text).toBe("checkpoint");
    expect(snapshot.leafId).toBe("a-1");
  });
  test("normalizes string labels and a 17,000-entry chain without recursion", async () => {
    const depth = 17_000;
    let node: WireTreeNode | undefined;
    for (let index = depth - 1; index >= 0; index -= 1) {
      const id = `a-${String(index).padStart(5, "0")}`;
      node = {
        entry: entry(id, index === 0 ? null : `a-${String(index - 1).padStart(5, "0")}`),
        children: node ? [node] : [],
        ...(index === 0 ? { label: "Saved point" } : {}),
      };
    }
    if (!node) throw new Error("Expected the deep-tree fixture to have a root.");

    const send = (async (args: { method: string }) => {
      if (args.method === "get_entries") return { entries: [], leafId: null };
      return { tree: [node], leafId: `a-${String(depth - 1).padStart(5, "0")}` };
    }) as unknown as ChatSessionRequest;
    const snapshot = await new OmpSessionTreePort({ send }).readTree(threadA);

    expect(snapshot.labels).toHaveLength(1);
    expect(snapshot.labels[0]).toMatchObject({
      targetId: "a-00000",
      text: "Saved point",
      editable: false,
    });
    let current = snapshot.tree[0];
    let count = 0;
    while (current) {
      count += 1;
      current = current.children[0];
    }
    expect(count).toBe(depth);
  });
});

describe("IncrementalHistoryCursor", () => {
  test("loads the newest page and reveals older pages at stable boundaries", async () => {
    const port = new FakeTreePort();
    const cursor = new IncrementalHistoryCursor({ port, pageSize: 2 });

    await cursor.loadNewest(threadA);
    expect(cursor.getSnapshot().entries.map((item) => item.id)).toEqual(["a-4", "a-5"]);
    expect(cursor.getSnapshot().hasOlder).toBe(true);
    expect(cursor.getSnapshot().leafId).toBe("a-5");

    const older = await cursor.loadOlder();
    expect(older?.entries.map((item) => item.id)).toEqual(["a-2", "a-3"]);
    expect(cursor.getSnapshot().entries.map((item) => item.id)).toEqual([
      "a-2",
      "a-3",
      "a-4",
      "a-5",
    ]);
    expect((await cursor.loadOlder())?.entries.map((item) => item.id)).toEqual(["a-1"]);
    expect(await cursor.loadOlder()).toBeNull();
  });

  test("ignores a stale branch request when the selected thread changes mid-page", async () => {
    const aLoad = deferred<EntryCursor>();
    const bLoad = deferred<EntryCursor>();
    const aTree = deferred<TreeSnapshot>();
    const bTree = deferred<TreeSnapshot>();
    const port: SessionTreePort = {
      load: (threadId) => (threadId === threadA ? aLoad.promise : bLoad.promise),
      loadAfter: async () => ({ threadId: threadA, entries: [], leafId: null }),
      readTree: (threadId) => (threadId === threadA ? aTree.promise : bTree.promise),
      subscribe: () => () => {},
    };
    const cursor = new IncrementalHistoryCursor({ port, pageSize: 2 });
    const first = cursor.loadNewest(threadA);
    const second = cursor.loadNewest(threadB);
    aLoad.resolve({
      threadId: threadA,
      entries: [entry("a-1", null)],
      leafId: "a-1" as EntryCursor["leafId"],
    });
    aTree.resolve(tree(threadA, [entry("a-1", null)]));
    bLoad.resolve({
      threadId: threadB,
      entries: [entry("b-1", null)],
      leafId: "b-1" as EntryCursor["leafId"],
    });
    bTree.resolve(tree(threadB, [entry("b-1", null)]));

    await Promise.all([first, second]);
    expect(cursor.getSnapshot().threadId).toBe(threadB);
    expect(cursor.getSnapshot().entries.map((item) => item.id)).toEqual(["b-1"]);
  });

  test("refreshes after a compaction boundary and suppresses duplicate entries", async () => {
    const port = new FakeTreePort();
    const cursor = new IncrementalHistoryCursor({ port, pageSize: 10 });
    await cursor.loadNewest(threadA);
    port.entries.set(threadA, [entry("a-3", "a-2"), entry("a-6", "a-3")]);
    port.compacted = true;
    await cursor.loadNewer(threadA);
    expect(cursor.getSnapshot().entries.map((item) => item.id)).toEqual(["a-3", "a-6"]);
    port.compacted = false;
    port.entries.set(threadA, [entry("a-3", "a-2"), entry("a-6", "a-3"), entry("a-7", "a-6")]);
    port.overlap = true;
    await cursor.loadNewer(threadA);
    expect(cursor.getSnapshot().entries.map((item) => item.id)).toEqual(["a-3", "a-6", "a-7"]);
  });
});

describe("SelectedThreadHistoryReconciler", () => {
  test("reloads on session switch and compaction without duplicating entries", async () => {
    const port = new FakeTreePort();
    const cursor = new IncrementalHistoryCursor({ port, pageSize: 10 });
    let state = {
      threadId: threadA as ThreadId | undefined,
      store: {
        getSnapshot: () => ({ threadId: threadA, processGeneration: 0, needsRefetch: false }),
      },
    };
    const listeners = new Set<() => void>();
    const source = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const reconciler = new SelectedThreadHistoryReconciler({ source, cursor });
    const stop = reconciler.start();
    await reconciler.reconcile();
    expect(port.loadCalls).toEqual([threadA]);

    state = {
      threadId: threadB,
      store: {
        getSnapshot: () => ({ threadId: threadB, processGeneration: 0, needsRefetch: false }),
      },
    };
    for (const listener of listeners) listener();
    await reconciler.reconcile();
    expect(port.loadCalls).toEqual([threadA, threadB]);
    expect(cursor.getSnapshot().entries.map((item) => item.id)).toEqual(["b-1", "b-2"]);

    state = {
      threadId: threadB,
      store: {
        getSnapshot: () => ({ threadId: threadB, processGeneration: 1, needsRefetch: true }),
      },
    };
    for (const listener of listeners) listener();
    await reconciler.reconcile();
    expect(port.loadCalls).toEqual([threadA, threadB, threadB]);
    expect(new Set(cursor.getSnapshot().entries.map((item) => item.id)).size).toBe(
      cursor.getSnapshot().entries.length,
    );
    stop();
  });
});

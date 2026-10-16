import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, EntryId, FolderPath, ThreadId } from "@omp-app/contracts";
import {
  checkScrubbed,
  EntryId as EntryIdSchema,
  parseFixture,
  SessionEntryHead,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import recordedTreeCapture from "@/modules/D4/copy/fixtures/real-chat-p4-tree.fixture.jsonl?raw";
import type { SessionHistoryLoader } from "@/modules/R0/history/history";
import { OmpRuntimeStore } from "@/modules/R0/store/store";
import { createSelectedThreadHistoryController } from "@/modules/R1/history";
import type { TreeNode, TreeSelectorState, TreeSnapshot } from "../contract";
import { EntryCursorSchema, TreeSnapshotSchema } from "../contract";
import {
  FORKED_LABEL_ID,
  FORKED_SESSION_FILE,
  FORKED_THREAD_ID,
  FORKED_WITHOUT_LABEL_SESSION_FILE,
  FORKED_WITHOUT_LABEL_THREAD_ID,
  RECORDED_BACKGROUND_ONLY_FORK_REPLY,
  RECORDED_BEFORE_EARLIER_ID,
  RECORDED_BUSY_FORK_REPLY,
  RECORDED_EARLIER_ENTRY_ID,
  RECORDED_ENTRIES,
  RECORDED_FORK_REPLY,
  RECORDED_FORK_WITH_LABEL_ENTRIES_REPLY,
  RECORDED_FORK_WITH_LABEL_TREE_REPLY,
  RECORDED_FORK_WITHOUT_LABEL_ENTRIES_REPLY,
  RECORDED_FORK_WITHOUT_LABEL_REPLY,
  RECORDED_FORK_WITHOUT_LABEL_TREE_REPLY,
  RECORDED_GET_ENTRIES_AFTER_REPLY,
  RECORDED_GET_ENTRIES_REPLY,
  RECORDED_GET_TREE_REPLY,
  RECORDED_LABEL_TEXT,
  RECORDED_LEAF_ID,
  RECORDED_SESSION_FILE,
  RECORDED_THREAD_ID,
  RECORDED_UNKNOWN_SINCE_ID,
  RECORDED_UNKNOWN_SINCE_REPLY,
  type RecordedOmp,
  recordedOmp,
  recordedStore,
  SESSIONS_BUCKET,
} from "../fixtures/recorded-tree";
import { IncrementalHistoryCursor, OmpSessionTreePort } from "../history";
import { createP4LabelsViewModel } from "../labels/model";
import { createP4TreeSelectorViewModel } from "../selector/tree-selector-model";
import { createOmpConversationTransitionPort } from "../transitions";

/*
 * The W6 model leg uses omp replies captured with FixtureRecorder and P4's history, transition and view-model code.
 * The separate real-omp browser leg is `apps/web/e2e/p4-6-w6-real.spec.ts` (#1718).
 */

/** Both transitions are available. `transitions.ts` gates on these two keys. */
const AVAILABLE: CapabilityMap = {
  "omp.cmd.branch": { state: "available", via: "rpc" },
  "omp.cmd.fork": { state: "available", via: "rpc" },
};

function selectorState(threadId: ThreadId, selectedEntryId: EntryId | null): TreeSelectorState {
  return {
    threadId,
    filter: { query: "", showLabels: true },
    selectedEntryId,
    leafId: null,
    isLoading: false,
    error: null,
  };
}

/** The node for one entry, found by a walk that stops at the first match. */
function nodeFor(tree: readonly TreeNode[], entryId: EntryId): TreeNode | undefined {
  const pending = [...tree];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.entry.id === entryId) return node;
    pending.push(...node.children);
  }
  return undefined;
}

/** The last message the list shows: where the reloaded transcript ends, since bookkeeping rows are not listed. */
function lastListedEntry(snapshot: TreeSnapshot): EntryId | undefined {
  return createP4TreeSelectorViewModel(snapshot, selectorState(snapshot.threadId, null)).rows.at(-1)
    ?.entryId;
}

function r1Controller(omp: RecordedOmp, sourceStore: OmpRuntimeStore) {
  const rpc = {
    open: async (args: { readonly threadId: ThreadId }) => ({
      threadId: args.threadId,
      sessionFile: null,
      capabilities: AVAILABLE,
    }),
    send: omp.send,
    close: async () => null,
    openQuestions: async () => [],
    stateFrames: async () => [],
  };
  const client = {
    port: () => rpc,
    subscribe: async () => ({
      stream: "recorded-session",
      lastSeq: 0,
      onEvent: () => () => {},
      unsubscribe: async () => {},
    }),
  } as unknown as AppClient;

  return createSelectedThreadHistoryController({
    client,
    folder: "/workspace" as FolderPath,
    createStore: (threadId) =>
      threadId === RECORDED_THREAD_ID ? sourceStore : new OmpRuntimeStore({ threadId }),
    createLoader: () =>
      ({
        loadInitial: async () => {},
        loadOlder: async () => {},
        loadFullOutput: async () => {},
        refetch: async () => {},
        refreshAfterTurn: async () => {},
        watchNeedsRefetch: () => () => {},
        dispose: () => {},
      }) as unknown as SessionHistoryLoader,
  });
}

function transitionsOn(
  store: OmpRuntimeStore,
  omp: RecordedOmp,
  switched: ThreadId[],
  switchTo?: (threadId: ThreadId) => Promise<void>,
) {
  return createOmpConversationTransitionPort({
    store,
    send: omp.send,
    branchingController: {
      switchTo: async (threadId) => {
        switched.push(threadId);
        await switchTo?.(threadId);
      },
    },
    capabilities: AVAILABLE,
    pickCount: () => 0,
  });
}

describe("W6, at the model level: a recorded tree lists its entries, selects an earlier message, forks without touching the source, keeps labels and reloads the selected head", () => {
  test("loads the scrubbed live omp capture with its release and scenario tags", () => {
    const parsed = parseFixture(recordedTreeCapture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.header.omp).toMatchObject({
      version: "18.8.9",
      commit: "fa5ff4a3a977a28b93d025f4cf50f046e019f18c",
    });
    expect(parsed.value.header.tags).toEqual(
      expect.arrayContaining(["running-turn", "background-only"]),
    );
  });
  test("every reply in the replies bundle is exactly the response omp recorded in the capture", () => {
    const parsed = parseFixture(recordedTreeCapture);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const sent = new Map<string, string>();
    const answered = new Map<string, Record<string, unknown>>();
    for (const frame of parsed.value.frames) {
      const body = JSON.parse(frame.line) as Record<string, unknown>;
      if (typeof body.id !== "string") continue;
      if (frame.dir === "stdin" && typeof body.type === "string") sent.set(body.id, body.type);
      if (frame.dir === "stdout" && body.type === "response") answered.set(body.id, body);
    }
    const data = (id: string, command: string): unknown => {
      expect(sent.get(id)).toBe(command);
      return answered.get(id)?.data;
    };
    const refusal = (id: string, command: string): unknown => {
      expect(sent.get(id)).toBe(command);
      const { error, code } = answered.get(id) ?? {};
      return { command, error, code };
    };
    expect(RECORDED_GET_ENTRIES_REPLY).toEqual(data("rpc-3", "get_entries"));
    expect(RECORDED_GET_TREE_REPLY).toEqual(data("rpc-4", "get_tree"));
    expect(RECORDED_GET_ENTRIES_AFTER_REPLY).toEqual(data("rpc-5", "get_entries"));
    expect(RECORDED_UNKNOWN_SINCE_REPLY).toEqual(refusal("rpc-6", "get_entries"));
    expect(RECORDED_FORK_WITHOUT_LABEL_REPLY).toEqual(data("rpc-7", "fork"));
    expect(RECORDED_FORK_WITHOUT_LABEL_ENTRIES_REPLY).toEqual(data("rpc-8", "get_entries"));
    expect(RECORDED_FORK_WITHOUT_LABEL_TREE_REPLY).toEqual(data("rpc-9", "get_tree"));
    expect(RECORDED_FORK_REPLY).toEqual(data("rpc-11", "fork"));
    expect(RECORDED_FORK_WITH_LABEL_ENTRIES_REPLY).toEqual(data("rpc-12", "get_entries"));
    expect(RECORDED_FORK_WITH_LABEL_TREE_REPLY).toEqual(data("rpc-13", "get_tree"));
    expect(RECORDED_BUSY_FORK_REPLY).toEqual(refusal("rpc-16", "fork"));
    expect(RECORDED_BACKGROUND_ONLY_FORK_REPLY).toEqual(data("rpc-19", "fork"));
  });
  test("the captured entries have valid heads, a message chain, and a label side entry", () => {
    expect(checkScrubbed(JSON.stringify(RECORDED_ENTRIES))).toEqual([]);
    for (const path of [
      RECORDED_SESSION_FILE,
      FORKED_SESSION_FILE,
      FORKED_WITHOUT_LABEL_SESSION_FILE,
      SESSIONS_BUCKET,
    ]) {
      expect(checkScrubbed(path)).toEqual([]);
    }
    expect(RECORDED_ENTRIES.every((entry) => SessionEntryHead.safeParse(entry).success)).toBe(true);
    const messages = RECORDED_ENTRIES.filter((entry) => entry.type === "message");
    expect(messages.filter((entry) => entry.parentId === null)).toHaveLength(1);
    for (const [index, entry] of messages.slice(1).entries()) {
      expect(entry.parentId).toBe(messages[index]?.id);
    }
    const label = RECORDED_ENTRIES.find((entry) => entry.type === "label");
    expect(label?.parentId).toBe(RECORDED_EARLIER_ENTRY_ID);
    expect(label?.targetId).toBe(RECORDED_EARLIER_ENTRY_ID);
  });

  test("lists the recorded entries in append order, and after a durable cursor lists only the entries after it", async () => {
    const port = new OmpSessionTreePort({
      send: recordedOmp().send,
      sessionFile: RECORDED_SESSION_FILE,
    });

    const cursor = await port.load(RECORDED_THREAD_ID);
    expect(EntryCursorSchema.parse(cursor).entries.map((entry) => entry.id)).toEqual(
      RECORDED_ENTRIES.map((entry) => entry.id),
    );
    expect(cursor.leafId).toBe(RECORDED_LEAF_ID);
    expect(cursor.nextSince).toBe(RECORDED_LEAF_ID);

    const earlierIndex = RECORDED_ENTRIES.findIndex(
      (entry) => entry.id === RECORDED_EARLIER_ENTRY_ID,
    );
    const newer = await port.loadAfter(RECORDED_THREAD_ID, RECORDED_EARLIER_ENTRY_ID);
    expect(newer.entries.map((entry) => entry.id)).toEqual(
      RECORDED_ENTRIES.slice(earlierIndex + 1).map((entry) => entry.id),
    );
  });
  test("P4 history preserves the captured unknown_since error and reloads a stale cursor", async () => {
    const port = new OmpSessionTreePort({ send: recordedOmp().send });
    await expect(
      port.loadAfter(RECORDED_THREAD_ID, RECORDED_UNKNOWN_SINCE_ID),
    ).rejects.toMatchObject({
      appError: {
        code: "omp_error",
        omp: RECORDED_UNKNOWN_SINCE_REPLY,
      },
    });

    const omp = recordedOmp({ unknownSince: true });
    const cursor = new IncrementalHistoryCursor({
      port: new OmpSessionTreePort({ send: omp.send }),
      pageSize: 10,
    });
    await cursor.loadNewest(RECORDED_THREAD_ID);
    const refreshed = await cursor.loadNewer(RECORDED_THREAD_ID);
    expect(refreshed.entries.map((entry) => entry.id)).toEqual(
      RECORDED_ENTRIES.map((entry) => entry.id),
    );
    expect(refreshed.error).toBeNull();
  });

  test("reads the tree with its leaf, the children omp recorded, the label omp resolved, and the session file", async () => {
    const port = new OmpSessionTreePort({
      send: recordedOmp().send,
      sessionFile: RECORDED_SESSION_FILE,
      labelsCapability: "unavailable",
    });

    const snapshot = await port.readTree(RECORDED_THREAD_ID);
    expect(TreeSnapshotSchema.parse(snapshot).leafId).toBe(RECORDED_LEAF_ID);
    expect(snapshot.sessionFile).toBe(RECORDED_SESSION_FILE);
    expect(snapshot.labels).toEqual([
      {
        targetId: RECORDED_EARLIER_ENTRY_ID,
        text: RECORDED_LABEL_TEXT,
        editable: false,
        disabledReason: "Labels can't be changed here.",
      },
    ]);
    const labelled = nodeFor(snapshot.tree, RECORDED_EARLIER_ENTRY_ID);
    expect(labelled?.label?.text).toBe(RECORDED_LABEL_TEXT);
    expect(labelled?.children.map((child) => child.entry.type)).toEqual(["label", "message"]);
    expect(nodeFor(snapshot.tree, RECORDED_LEAF_ID)?.children).toEqual([]);
  });

  test("selects an earlier message: the selector model lets it be chosen, and its preview model carries the recorded text and its label", async () => {
    const port = new OmpSessionTreePort({
      send: recordedOmp().send,
      sessionFile: RECORDED_SESSION_FILE,
    });
    const snapshot = await port.readTree(RECORDED_THREAD_ID);

    const view = createP4TreeSelectorViewModel(
      snapshot,
      selectorState(RECORDED_THREAD_ID, RECORDED_EARLIER_ENTRY_ID),
    );

    expect(view.canSelect).toBe(true);
    expect(view.selectedEntryId).toBe(RECORDED_EARLIER_ENTRY_ID);
    expect(view.preview).toMatchObject({
      entryId: RECORDED_EARLIER_ENTRY_ID,
      role: "You",
      text: expect.stringContaining("hello again"),
      label: { text: RECORDED_LABEL_TEXT },
    });
    expect(view.rows.find((row) => row.entryId === RECORDED_EARLIER_ENTRY_ID)?.label?.text).toBe(
      RECORDED_LABEL_TEXT,
    );
  });

  test("forks from the selected message and R1 opens the forked thread before P4 reloads its tree", async () => {
    const omp = recordedOmp();
    const port = new OmpSessionTreePort({ send: omp.send, sessionFile: RECORDED_SESSION_FILE });
    const sourceStore = recordedStore();
    const controller = r1Controller(omp, sourceStore);
    await controller.openExisting(RECORDED_THREAD_ID);
    const store = controller.getSnapshot().store;
    if (!store) throw new Error("R1 did not open the recorded source thread");
    const storeBefore = store.getSnapshot();
    const sourceBefore = await port.readTree(RECORDED_THREAD_ID);
    const switched: ThreadId[] = [];
    const transitions = transitionsOn(store, omp, switched, async (threadId) => {
      await controller.openExisting(threadId);
    });

    const result = await transitions.fork({
      threadId: RECORDED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
    });

    expect(result).toEqual({
      sourceThreadId: RECORDED_THREAD_ID,
      threadId: FORKED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
      sessionFile: FORKED_SESSION_FILE,
      cancelled: false,
      reloaded: true,
      sourceRetained: true,
    });
    expect(controller.getSnapshot().threadId).toBe(FORKED_THREAD_ID);
    expect(controller.getSnapshot().store).not.toBe(sourceStore);
    expect(store.getSnapshot()).toBe(storeBefore);
    expect(transitions.getRetainedSource()?.threadId).toBe(RECORDED_THREAD_ID);
    expect(await port.readTree(RECORDED_THREAD_ID)).toEqual(sourceBefore);

    // omp's head is the label it carried onto the selected message (`createBranchedSession`); the list shows
    // the selected message as its last row, because labels are bookkeeping rows.
    const forked = await port.readTree(FORKED_THREAD_ID);
    expect(forked.leafId).toBe(FORKED_LABEL_ID);
    expect(lastListedEntry(forked)).toBe(RECORDED_EARLIER_ENTRY_ID);
  });
  test("a recorded fork whose path ends before the label reloads with no carried label", async () => {
    const omp = recordedOmp();
    const rootEntryId = EntryIdSchema.parse(RECORDED_ENTRIES[0]?.id);
    const port = new OmpSessionTreePort({ send: omp.send, sessionFile: RECORDED_SESSION_FILE });
    const result = await transitionsOn(recordedStore(), omp, []).fork({
      threadId: RECORDED_THREAD_ID,
      entryId: rootEntryId,
    });
    expect(result).toMatchObject({
      threadId: FORKED_WITHOUT_LABEL_THREAD_ID,
      sessionFile: FORKED_WITHOUT_LABEL_SESSION_FILE,
      sourceRetained: true,
      reloaded: true,
    });
    const forked = await port.readTree(FORKED_WITHOUT_LABEL_THREAD_ID);
    expect(forked.leafId).toBe(rootEntryId);
    expect(forked.labels).toEqual([]);
  });

  test("keeps the label: the labels model lists it for the source and the forked session, and the selector model's row carries it", async () => {
    const omp = recordedOmp();
    const port = new OmpSessionTreePort({ send: omp.send, sessionFile: RECORDED_SESSION_FILE });
    await transitionsOn(recordedStore(), omp, []).fork({
      threadId: RECORDED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
    });
    const expected = [
      {
        key: RECORDED_EARLIER_ENTRY_ID,
        title: RECORDED_LABEL_TEXT,
        detail: expect.stringContaining("Entry from"),
      },
    ];

    const source = await port.readTree(RECORDED_THREAD_ID);
    const forked = await port.readTree(FORKED_THREAD_ID);

    expect(createP4LabelsViewModel(source).items).toEqual(expected);
    expect(createP4LabelsViewModel(forked).items).toEqual(expected);
    const row = createP4TreeSelectorViewModel(
      forked,
      selectorState(FORKED_THREAD_ID, RECORDED_EARLIER_ENTRY_ID),
    ).rows.find((item) => item.entryId === RECORDED_EARLIER_ENTRY_ID);
    expect(row?.label?.text).toBe(RECORDED_LABEL_TEXT);
  });

  test("a rewind through the same seam moves the identity to the session omp reports, leaves the source as it was, and the selector model lists its parent last", async () => {
    const omp = recordedOmp();
    const port = new OmpSessionTreePort({ send: omp.send, sessionFile: RECORDED_SESSION_FILE });
    const sourceBefore = await port.readTree(RECORDED_THREAD_ID);
    const switched: ThreadId[] = [];

    const result = await transitionsOn(recordedStore(), omp, switched).branch({
      threadId: RECORDED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
    });

    expect(result).toMatchObject({
      sourceThreadId: RECORDED_THREAD_ID,
      threadId: FORKED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
      sessionFile: FORKED_SESSION_FILE,
      cancelled: false,
      reloaded: true,
      sourceRetained: true,
      wording: "conversation rewind",
    });
    expect(switched).toEqual([FORKED_THREAD_ID]);
    expect(await port.readTree(RECORDED_THREAD_ID)).toEqual(sourceBefore);

    // A branch cuts before the selected user message, so the reloaded head is that message's parent.
    const rewound = await port.readTree(FORKED_THREAD_ID);
    expect(rewound.leafId).toBe(RECORDED_BEFORE_EARLIER_ID);
    expect(lastListedEntry(rewound)).toBe(RECORDED_BEFORE_EARLIER_ID);
  });
});

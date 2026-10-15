import type { CapabilityMap, EntryId, ThreadId } from "@omp-app/contracts";
import { checkScrubbed, SessionEntryHead } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { OmpRuntimeStore } from "@/modules/R0/store/store";
import type { TreeNode, TreeSelectorState, TreeSnapshot } from "../contract";
import { EntryCursorSchema, TreeSnapshotSchema } from "../contract";
import {
  FORKED_LABEL_ID,
  FORKED_SESSION_FILE,
  FORKED_THREAD_ID,
  RECORDED_BEFORE_EARLIER_ID,
  RECORDED_EARLIER_ENTRY_ID,
  RECORDED_ENTRIES,
  RECORDED_LABEL_TEXT,
  RECORDED_LEAF_ID,
  RECORDED_SESSION_FILE,
  RECORDED_THREAD_ID,
  type RecordedOmp,
  recordedOmp,
  recordedStore,
  SESSIONS_BUCKET,
} from "../fixtures/recorded-tree";
import { OmpSessionTreePort } from "../history";
import { createP4LabelsViewModel } from "../labels/model";
import { createP4TreeSelectorViewModel } from "../selector/tree-selector-model";
import { createOmpConversationTransitionPort } from "../transitions";

/*
 * The W6 gate for P4 at the model level: the recorded tree in ../fixtures/recorded-tree.ts, a fake omp that answers
 * by omp's rules (cited there), and P4's adapter, transition port and view models. It renders no component and saves
 * no screenshot. The real-omp leg (a real per-folder session driven through the app) is not here: P4.6 owns no e2e
 * spec, so it is follow-up #1718.
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

function transitionsOn(store: OmpRuntimeStore, omp: RecordedOmp, switched: ThreadId[]) {
  return createOmpConversationTransitionPort({
    store,
    send: omp.send,
    branchingController: {
      switchTo: async (threadId) => {
        switched.push(threadId);
      },
    },
    capabilities: AVAILABLE,
    pickCount: () => 0,
  });
}

describe("W6, at the model level: a recorded tree lists its entries, selects an earlier message, forks without touching the source, keeps labels and reloads the selected head", () => {
  test("the recorded entries have the head fields the app reads, are scrubbed, and form one chain", () => {
    expect(checkScrubbed(JSON.stringify(RECORDED_ENTRIES))).toEqual([]);
    for (const path of [RECORDED_SESSION_FILE, FORKED_SESSION_FILE, SESSIONS_BUCKET]) {
      expect(checkScrubbed(path)).toEqual([]);
    }
    expect(RECORDED_ENTRIES.every((entry) => SessionEntryHead.safeParse(entry).success)).toBe(true);
    expect(RECORDED_ENTRIES.filter((entry) => entry.parentId === null)).toHaveLength(1);
    for (const [index, entry] of RECORDED_ENTRIES.slice(1).entries()) {
      expect(entry.parentId).toBe(RECORDED_ENTRIES[index]?.id);
    }
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
    expect(labelled?.children.map((child) => child.entry.type)).toEqual(["label"]);
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

  test("forks from the selected message: the source is not changed, and the reloaded session's selector model lists that message last, with its label carried onto it", async () => {
    const omp = recordedOmp();
    const port = new OmpSessionTreePort({ send: omp.send, sessionFile: RECORDED_SESSION_FILE });
    const store = recordedStore();
    const storeBefore = store.getSnapshot();
    const sourceBefore = await port.readTree(RECORDED_THREAD_ID);
    const switched: ThreadId[] = [];
    const transitions = transitionsOn(store, omp, switched);

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
    expect(switched).toEqual([FORKED_THREAD_ID]);
    expect(store.getSnapshot()).toBe(storeBefore);
    expect(transitions.getRetainedSource()?.threadId).toBe(RECORDED_THREAD_ID);
    expect(await port.readTree(RECORDED_THREAD_ID)).toEqual(sourceBefore);

    // omp's head is the label it carried onto the selected message (`createBranchedSession`); the list shows
    // the selected message as its last row, because labels are bookkeeping rows.
    const forked = await port.readTree(FORKED_THREAD_ID);
    expect(forked.leafId).toBe(FORKED_LABEL_ID);
    expect(lastListedEntry(forked)).toBe(RECORDED_EARLIER_ENTRY_ID);
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

import type { CapabilityMap } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  FORKED_THREAD_ID,
  RECORDED_EARLIER_ENTRY_ID,
  RECORDED_THREAD_ID,
  type RecordedOmp,
  recordedOmp,
  recordedStore,
} from "../fixtures/recorded-tree";
import { createOmpConversationTransitionPort } from "../transitions";
import { shippedSources } from "./shipped";

/*
 * CC9 on P4's side. A conversation rewind or fork is a typed command on omp's session. It is kept apart from
 * assistant-ui message branches (P3) and from workspace snapshots (P5), and it never sends a prompt, writes a
 * file or restores a workspace. It renders nothing: it reads the transition port and the shipped text. Not covered
 * here: P5's snapshot ids against EntryId (P5.6, issue #363, runs on W7), and omp's own reply when a fork is refused
 * while a background job runs (follow-up #1717).
 */

/** Both transitions are available. `transitions.ts` gates on these two keys. */
const AVAILABLE: CapabilityMap = {
  "omp.cmd.branch": { state: "available", via: "rpc" },
  "omp.cmd.fork": { state: "available", via: "rpc" },
};

function transitionsOn(omp: RecordedOmp, isBusy?: () => boolean) {
  return createOmpConversationTransitionPort({
    store: recordedStore(),
    send: omp.send,
    branchingController: { switchTo: async () => {} },
    capabilities: AVAILABLE,
    pickCount: () => 0,
    ...(isBusy === undefined ? {} : { isBusy }),
  });
}

/**
 * The text a person can read in one file: its string literals and the text between JSX tags, without its
 * comments. A sanity scan, not a parser: it reads what the shipped copy is written in.
 */
function visibleStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const literals = [
    ...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  const jsxText = [...code.matchAll(/>([^<>{}\n]+)</g)].map((match) => match[1] ?? "");
  return [...literals, ...jsxText];
}

describe("CC9: a conversation rewind or fork is a typed session command, never a prompt, a file write or a workspace restore", () => {
  test("a fork sends only fork and get_state, and a rewind only branch and get_state, all to the selected conversation", async () => {
    const fork = recordedOmp();
    await transitionsOn(fork).fork({
      threadId: RECORDED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
    });
    expect(fork.calls).toEqual([
      { threadId: RECORDED_THREAD_ID, type: "fork" },
      { threadId: RECORDED_THREAD_ID, type: "get_state" },
    ]);

    const rewind = recordedOmp();
    await transitionsOn(rewind).branch({
      threadId: RECORDED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
    });
    expect(rewind.calls).toEqual([
      { threadId: RECORDED_THREAD_ID, type: "branch" },
      { threadId: RECORDED_THREAD_ID, type: "get_state" },
    ]);
  });

  // Follow-up #1717 records omp's own reply to a fork refused while a background job runs. This check covers
  // only P4's refusal, which comes before omp is called.
  test("a fork refused while the conversation is busy sends nothing to omp", async () => {
    const omp = recordedOmp();

    await expect(
      transitionsOn(omp, () => true).fork({
        threadId: RECORDED_THREAD_ID,
        entryId: RECORDED_EARLIER_ENTRY_ID,
      }),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(omp.calls).toEqual([]);
  });

  test("branch and fork refuse when their capability is unavailable, and send nothing to omp", async () => {
    const omp = recordedOmp();
    const transitions = createOmpConversationTransitionPort({
      store: recordedStore(),
      send: omp.send,
      branchingController: { switchTo: async () => {} },
      capabilities: {},
      pickCount: () => 0,
    });

    await expect(
      transitions.branch({ threadId: RECORDED_THREAD_ID, entryId: RECORDED_EARLIER_ENTRY_ID }),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    await expect(
      transitions.fork({ threadId: RECORDED_THREAD_ID, entryId: RECORDED_EARLIER_ENTRY_ID }),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    expect(omp.calls).toEqual([]);
  });

  test("a fork's new identity is the session omp reports, never the entry it was forked from", async () => {
    const result = await transitionsOn(recordedOmp()).fork({
      threadId: RECORDED_THREAD_ID,
      entryId: RECORDED_EARLIER_ENTRY_ID,
    });

    expect(result.threadId).toBe(FORKED_THREAD_ID);
    expect(result.threadId).not.toBe(result.entryId);
  });

  test("no shipped P4 string literal or JSX text says workspace or restore", () => {
    const words = shippedSources().flatMap((file) =>
      visibleStrings(file.text).map((text) => ({ file: file.path, text })),
    );

    expect(words.map((word) => word.text)).toEqual(
      expect.arrayContaining(["Conversation rewind", "Conversation fork"]),
    );
    expect(
      words.filter(({ text }) => /\b(?:workspace|restores?|restored|restoring)\b/i.test(text)),
    ).toEqual([]);
  });
});

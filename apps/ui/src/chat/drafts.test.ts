import type { AppClient } from "@omp-app/client";
import type { Draft, DraftChanged, ThreadId } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// This browser's copy (IndexedDB) is not what these tests are about: none is kept.
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async () => undefined,
  set: async () => undefined,
  del: async () => undefined,
}));

const { ChatDraft } = await import("./drafts");

const threadId = "01a00000-0000-7000-8000-000000000001" as ThreadId;
const scope = { kind: "thread", threadId } as const;

/** The app's draft store as another window sees it: one copy, its revisions, and its `changed` events. */
function appCopy(text: string) {
  const listeners: ((changed: DraftChanged) => void)[] = [];
  let count = 1;
  let current: Draft | null = draft(text, "r1");
  function draft(value: string, revision: string): Draft {
    return {
      scope,
      text: value,
      attachments: [],
      failedSends: [],
      revision,
      updatedAt: "2026-11-18T00:00:00.000Z",
    } as unknown as Draft;
  }
  const emit = () => {
    for (const listener of listeners) listener({ scope, draft: current } as DraftChanged);
  };
  const store = {
    get: async () => ({ draft: current }),
    save: async (args: { draft: { text: string } }) => {
      count += 1;
      current = draft(args.draft.text, `r${count}`);
      emit();
      return current;
    },
    clear: async () => {
      current = null;
      emit();
      return { cleared: true, revision: null };
    },
  };
  const client = {
    port: () => store,
    subscribe: async () => ({
      stream: "draft",
      lastSeq: 0,
      onEvent: (listener: (changed: DraftChanged) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      unsubscribe: async () => undefined,
    }),
  } as unknown as AppClient;
  return {
    client,
    /** Another window saved `value`. */
    async theirs(value: string) {
      await store.save({ draft: { text: value } });
    },
    async theyCleared() {
      await store.clear();
    },
  };
}

describe("a chat's draft follows what other windows write", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a text another window saved or cleared reaches this window, with the text it held before", async () => {
    const copy = appCopy("alpha");
    const draft = new ChatDraft(copy.client, threadId);
    expect(await draft.load()).toBe("alpha");
    const heard: [string, string][] = [];
    draft.follow((before, next) => heard.push([before, next]));
    await vi.runAllTimersAsync();

    await copy.theyCleared();
    await copy.theirs("a plan");
    expect(heard).toEqual([
      ["alpha", ""],
      ["", "a plan"],
    ]);
  });

  test("typing here wins: another window's text is not taken while this window's waits to be written", async () => {
    const copy = appCopy("");
    const draft = new ChatDraft(copy.client, threadId);
    await draft.load();
    const heard: [string, string][] = [];
    draft.follow((before, next) => heard.push([before, next]));
    await vi.runAllTimersAsync();

    draft.change("mine");
    await copy.theirs("theirs");
    expect(heard).toEqual([]);
    // Its own write, once made, is not news either.
    await vi.runAllTimersAsync();
    expect(heard).toEqual([]);
  });

  test("a stopped follow hears nothing", async () => {
    const copy = appCopy("alpha");
    const draft = new ChatDraft(copy.client, threadId);
    await draft.load();
    const heard: [string, string][] = [];
    const stop = draft.follow((before, next) => heard.push([before, next]));
    await vi.runAllTimersAsync();
    stop();
    await copy.theirs("later");
    expect(heard).toEqual([]);
  });
});

import type { EntryId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { OmpRuntimeStore } from "../../R0/store";
import { createStorePromptSource, userPromptsIn } from "./prompts";

const threadId = "prompt-thread" as ThreadId;

/** One saved session entry for a user message, linked to the entry before it. */
function userEntry(
  id: string,
  parentId: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1, ...extra },
  };
}

/** Saves a chain of entries in order; the last one is the branch head. */
function saveChain(store: OmpRuntimeStore, entries: readonly Record<string, unknown>[]): void {
  store.pairEndedMessages(entries, entries[entries.length - 1]?.id as EntryId);
}

describe("U2.5 prompts read from a chat", () => {
  test("lists what the user typed, oldest first, without synthetic, blank or repeated entries", () => {
    const store = new OmpRuntimeStore({ threadId });
    saveChain(store, [
      userEntry("p1", null, "first prompt"),
      userEntry("p2", "p1", "a reminder omp wrote", { synthetic: true }),
      userEntry("p3", "p2", "   "),
      userEntry("p4", "p3", "second prompt"),
      userEntry("p5", "p4", "second prompt"),
      userEntry("p6", "p5", [
        { type: "text", text: "look at" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "this" },
      ]),
    ]);

    expect(userPromptsIn(store.getSnapshot())).toEqual([
      "first prompt",
      "second prompt",
      "look at\n\nthis",
    ]);
  });

  test("the source answers from the store's current snapshot and reports each change", () => {
    const store = new OmpRuntimeStore({ threadId });
    const source = createStorePromptSource(store);
    expect(source.getUserPrompts()).toEqual([]);

    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    saveChain(store, [userEntry("p1", null, "hello probe")]);
    expect(listener).toHaveBeenCalled();
    expect(source.getUserPrompts()).toEqual(["hello probe"]);
    // The same snapshot gives the same list, so a key press costs no new read.
    expect(source.getUserPrompts()).toBe(source.getUserPrompts());

    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    saveChain(store, [userEntry("p1", null, "hello probe"), userEntry("p2", "p1", "again")]);
    expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
    expect(source.getUserPrompts()).toEqual(["hello probe", "again"]);
  });
});

import { describe, expect, test, vi } from "vitest";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store/store";
import { chatHistoryOf } from "./export-history";

/** A store snapshot with the fields the export reads: the message order and records, and the transcript's entries and older flag. */
function snapshotOf(options: {
  readonly keys: readonly string[];
  readonly entries: number;
  readonly hasOlder: boolean;
}): RuntimeSnapshot {
  return {
    messageOrder: options.keys,
    messages: Object.fromEntries(
      options.keys.map((key) => [key, { key, message: { role: "user", content: key } }]),
    ),
    transcript: {
      entries: Object.fromEntries(
        Array.from({ length: options.entries }, (_, index) => [`entry-${index}`, {}]),
      ),
      order: [],
      head: null,
      hasOlder: options.hasOlder,
    },
  } as unknown as RuntimeSnapshot;
}

/** A store whose snapshot the test replaces, as the live store does when messages or older pages arrive. */
function liveStore(initial: RuntimeSnapshot) {
  let current = initial;
  return {
    store: { getSnapshot: () => current } as unknown as Pick<OmpRuntimeStore, "getSnapshot">,
    replace: (next: RuntimeSnapshot) => {
      current = next;
    },
  };
}

describe("the export's view of the open chat", () => {
  test("its messages are the store's, oldest first, as they are now", () => {
    const live = liveStore(snapshotOf({ keys: ["a", "b"], entries: 2, hasOlder: false }));
    const history = chatHistoryOf(live.store, undefined);
    expect(history.messages().map((entry) => entry.key)).toEqual(["a", "b"]);
    live.replace(snapshotOf({ keys: ["0", "a", "b"], entries: 3, hasOlder: false }));
    expect(history.messages().map((entry) => entry.key)).toEqual(["0", "a", "b"]);
  });

  test("the loaded entries and the older flag are read from the store each time", () => {
    const live = liveStore(snapshotOf({ keys: [], entries: 3, hasOlder: true }));
    const history = chatHistoryOf(live.store, undefined);
    expect(history.loadedEntries()).toBe(3);
    expect(history.hasOlder()).toBe(true);
    live.replace(snapshotOf({ keys: [], entries: 5, hasOlder: false }));
    expect(history.loadedEntries()).toBe(5);
    expect(history.hasOlder()).toBe(false);
  });

  test("loadOlder runs the open chat's loader, and does nothing when there is no loader", async () => {
    const loadOlder = vi.fn(() => Promise.resolve());
    const live = liveStore(snapshotOf({ keys: [], entries: 0, hasOlder: true }));
    await chatHistoryOf(live.store, loadOlder).loadOlder();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    await expect(chatHistoryOf(live.store, undefined).loadOlder()).resolves.toBeUndefined();
  });
});

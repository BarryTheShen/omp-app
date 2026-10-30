import type { AppClient } from "@omp-app/client";
import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ChatController } from "../chat/controller";
import { ChatCache } from "./chatCache";

interface Shown {
  phase: string;
  process: string | null;
  entries: readonly unknown[];
}

interface FakeChat {
  readonly controller: ChatController;
  readonly calls: () => {
    readonly disposed: number;
    readonly parked: number;
    readonly unparked: number;
  };
  /** Changes what the chat shows, as its events would. */
  readonly shows: (change: Partial<Shown>) => void;
}

/** A chat's controller as the cache sees it: its id, what it shows, and how often it was closed, parked and unparked. */
function chat(id: string | null, shown: Partial<Shown> = {}): FakeChat {
  const calls = { disposed: 0, parked: 0, unparked: 0 };
  const snapshot: Shown = { phase: "live", process: "running", entries: [{}], ...shown };
  const controller = {
    threadId: id === null ? null : ThreadId.parse(id),
    store: { getSnapshot: () => snapshot },
    dispose: async () => {
      calls.disposed += 1;
    },
    park: async () => {
      calls.parked += 1;
    },
    unpark: async () => {
      calls.unparked += 1;
    },
  } as unknown as ChatController;
  return {
    controller,
    calls: () => ({ ...calls }),
    shows: (change) => Object.assign(snapshot, change),
  };
}

const client = {} as AppClient;
const id = (value: string) => ThreadId.parse(value);
const disposed = (...chats: FakeChat[]) => chats.map((each) => each.calls().disposed);

describe("ChatCache", () => {
  test("keeps the chats left most recently and closes the one left longest ago past the limit", () => {
    const cache = new ChatCache(2);
    const [a, b, c] = [chat("a"), chat("b"), chat("c")];
    cache.keep(client, a.controller);
    cache.keep(client, b.controller);
    cache.keep(client, c.controller);

    expect(disposed(a, b, c)).toEqual([1, 0, 0]);
    expect(cache.take(client, id("a"))).toBeUndefined();
    expect(cache.take(client, id("c"))).toBe(c.controller);
    // Taken, it is the pane's: the cache no longer holds it.
    expect(cache.take(client, id("c"))).toBeUndefined();
  });

  test("a kept chat lets go of its view, and takes it back when a pane shows it again", () => {
    const cache = new ChatCache(8);
    const a = chat("a");
    cache.keep(client, a.controller);
    expect(a.calls()).toEqual({ disposed: 0, parked: 1, unparked: 0 });

    cache.take(client, id("a"));
    expect(a.calls()).toEqual({ disposed: 0, parked: 1, unparked: 1 });
  });

  test("a chat shown again and left again is the most recent, so the next past the limit closes another", () => {
    const cache = new ChatCache(2);
    const [a, b, c] = [chat("a"), chat("b"), chat("c")];
    cache.keep(client, a.controller);
    cache.keep(client, b.controller);
    cache.keep(client, cache.take(client, id("a")) ?? a.controller);
    cache.keep(client, c.controller);

    expect(disposed(a, b, c)).toEqual([0, 1, 0]);
  });

  test("closes instead of keeping a chat with no id, nothing in it, an end, a stopped omp, or a delete behind it", () => {
    const cache = new ChatCache(8);
    const unsaved = chat(null);
    const empty = chat("empty", { entries: [] });
    const ended = chat("ended", { phase: "ended" });
    const stopped = chat("stopped", { process: "stopped" });
    const deleted = chat("deleted");
    cache.forget(id("deleted"));
    const all = [unsaved, empty, ended, stopped, deleted];
    for (const each of all) cache.keep(client, each.controller);

    expect(disposed(...all)).toEqual([1, 1, 1, 1, 1]);
    for (const each of ["empty", "ended", "stopped", "deleted"]) {
      expect(cache.take(client, id(each))).toBeUndefined();
    }
  });

  test("a chat deleted while kept is closed at once", () => {
    const cache = new ChatCache(8);
    const a = chat("a");
    cache.keep(client, a.controller);
    cache.forget(id("a"));

    expect(disposed(a)).toEqual([1]);
    expect(cache.take(client, id("a"))).toBeUndefined();
  });

  test("a kept chat whose omp stopped or that ended meanwhile, or of another connection, is closed instead of handed back", () => {
    const cache = new ChatCache(8);
    const [stopped, ended, other] = [chat("stopped"), chat("ended"), chat("other")];
    for (const each of [stopped, ended, other]) cache.keep(client, each.controller);
    // The server stopped the omp of a chat nobody viewed, and another chat ended.
    stopped.shows({ process: "stopped" });
    ended.shows({ phase: "ended" });

    expect(cache.take(client, id("stopped"))).toBeUndefined();
    expect(cache.take(client, id("ended"))).toBeUndefined();
    expect(cache.take({} as AppClient, id("other"))).toBeUndefined();
    expect(disposed(stopped, ended, other)).toEqual([1, 1, 1]);
    expect([stopped, ended, other].map((each) => each.calls().unparked)).toEqual([0, 0, 0]);
  });

  test("a second controller of the same chat replaces the first, which is closed", () => {
    const cache = new ChatCache(8);
    const [first, second] = [chat("a"), chat("a")];
    cache.keep(client, first.controller);
    cache.keep(client, second.controller);

    expect(disposed(first, second)).toEqual([1, 0]);
    expect(cache.take(client, id("a"))).toBe(second.controller);
  });
});

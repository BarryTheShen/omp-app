import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { Notification } from "../../contract";
import { NotificationBus, sessionRetiredNotices } from "../../notifications";
import { isStreamNoticeKey } from "../../notifications/bus";
import { MAX_RETIRED_PER_THREAD, RETIRED_NOTICES_STORAGE_KEY } from "../../notifications/retired";

const threadA = ThreadIdSchema.parse("thread-retired-a");
const threadB = ThreadIdSchema.parse("thread-retired-b");
const streamKey = "extension:notify:12:0a1b2c";

function notice(overrides: Partial<Notification>): Notification {
  return {
    threadId: threadA,
    dedupeKey: streamKey,
    severity: "info",
    placement: "toast",
    message: "Turn finished",
    live: "polite",
    focus: "preserve",
    ...overrides,
  };
}

/** One tab's sessionStorage, as far as the memory uses it. */
function tabStorage(initial?: string) {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set(RETIRED_NOTICES_STORAGE_KEY, initial);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

const instance = () => "instance-1";

describe("retired notices", () => {
  test("only a stream notice's key is remembered: a key without a sequence is reused for the same text", () => {
    expect(isStreamNoticeKey("extension:notify:12:0a1b2c")).toBe(true);
    expect(isStreamNoticeKey("session:notice:3:9f8e7d")).toBe(true);
    expect(isStreamNoticeKey("retry:active")).toBe(false);
    expect(isStreamNoticeKey("fallback:6b1f")).toBe(false);
    expect(isStreamNoticeKey("extension:notify:0a1b2c")).toBe(false);
  });

  test("a stream notice the person let go of is not shown again when its stream replays it", () => {
    const bus = new NotificationBus({ retired: sessionRetiredNotices(tabStorage(), instance) });
    expect(bus.publish(notice({}))).toBe("published");
    expect(bus.retire(threadA, streamKey)).toBe(true);
    expect(bus.publish(notice({}))).toBe("deduplicated");
    expect(bus.getSnapshot().notifications).toEqual([]);
  });

  test("a system removal, or a retire of a reused key, remembers nothing: a retry that resolved and returns is shown", () => {
    const bus = new NotificationBus({ retired: sessionRetiredNotices(tabStorage(), instance) });
    const retry = notice({ dedupeKey: "retry:active", message: "Retrying" });
    expect(bus.publish(retry)).toBe("published");
    expect(bus.dismiss(threadA, "retry:active")).toBe(true);
    expect(bus.publish(retry)).toBe("published");
    expect(bus.retire(threadA, "retry:active")).toBe(true);
    expect(bus.publish(retry)).toBe("published");
  });

  test("a stream notice that expires is remembered as well", () => {
    const bus = new NotificationBus({ retired: sessionRetiredNotices(tabStorage(), instance) });
    expect(bus.publish(notice({ expiresAt: 10 }))).toBe("published");
    expect(bus.expire(20)).toBe(1);
    expect(bus.publish(notice({ expiresAt: 40 }))).toBe("deduplicated");
  });

  test("a notice retired in one chat does not hide the same key in another chat", () => {
    const bus = new NotificationBus({ retired: sessionRetiredNotices(tabStorage(), instance) });
    bus.publish(notice({}));
    bus.retire(threadA, streamKey);
    expect(bus.publish(notice({ threadId: threadB }))).toBe("published");
  });

  test("retired notices survive a reload of the tab, and belong to their server instance", () => {
    const storage = tabStorage();
    sessionRetiredNotices(storage, instance).remember(threadA, streamKey);
    expect(sessionRetiredNotices(storage, instance).has(threadA, streamKey)).toBe(true);
    // A restarted server numbers its events from the start again, so this key names another event.
    expect(sessionRetiredNotices(storage, () => "instance-2").has(threadA, streamKey)).toBe(false);
  });

  test("the first retirement under a new server instance replaces the old instance's", () => {
    const storage = tabStorage();
    let current = "instance-1";
    const memory = sessionRetiredNotices(storage, () => current);
    memory.remember(threadA, streamKey);
    current = "instance-2";
    memory.remember(threadA, "extension:notify:3:aaaaaa");
    expect(memory.has(threadA, streamKey)).toBe(false);
    expect(memory.has(threadA, "extension:notify:3:aaaaaa")).toBe(true);
  });

  test("nothing is retired before the client has an instance, and damaged storage is ignored", () => {
    const storage = tabStorage("{not json");
    const memory = sessionRetiredNotices(storage, () => undefined);
    memory.remember(threadA, streamKey);
    expect(memory.has(threadA, streamKey)).toBe(false);
    expect(storage.items.get(RETIRED_NOTICES_STORAGE_KEY)).toBe("{not json");
    expect(sessionRetiredNotices(storage, instance).has(threadA, streamKey)).toBe(false);
  });

  test("the most recent retired notices of a chat are kept, and the oldest are dropped", () => {
    const memory = sessionRetiredNotices(tabStorage(), instance);
    for (let index = 0; index <= MAX_RETIRED_PER_THREAD; index += 1) {
      memory.remember(threadA, `extension:notify:${index}:aaaaaa`);
    }
    expect(memory.has(threadA, "extension:notify:0:aaaaaa")).toBe(false);
    expect(memory.has(threadA, `extension:notify:${MAX_RETIRED_PER_THREAD}:aaaaaa`)).toBe(true);
  });

  test("a storage that refuses writes still retires the notice on this page", () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage is full");
      },
    };
    const memory = sessionRetiredNotices(refusing, instance);
    memory.remember(threadA, streamKey);
    expect(memory.has(threadA, streamKey)).toBe(true);
  });
});

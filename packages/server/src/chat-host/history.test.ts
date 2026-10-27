import { describe, expect, test } from "bun:test";
import { pageMessages, selectEntries } from "./history";
import { HostMethodError } from "./method-error";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof HostMethodError ? error.code : `not coded: ${String(error)}`;
  }
  return undefined;
}

describe("entries after a cursor", () => {
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("all entries without one, those after it with one, and an id the session lacks is unknown_since", () => {
    expect(selectEntries(entries, undefined)).toEqual(entries);
    expect(selectEntries(entries, "a")).toEqual([{ id: "b" }, { id: "c" }]);
    expect(selectEntries(entries, "c")).toEqual([]);
    expect(codeOf(() => selectEntries(entries, "deadbeef"))).toBe("unknown_since");
  });
});

describe("pages of the session's messages", () => {
  const messages = ["m0", "m1", "m2", "m3", "m4"];
  const snapshot = { sessionId: "s1", leafId: "e5", messageCount: 5 };

  test("pages walk the messages in order, and the last page has no cursor", () => {
    const first = pageMessages(messages, snapshot, { limit: 2 });
    const second = pageMessages(messages, snapshot, { limit: 2, cursor: first.nextCursor });
    const third = pageMessages(messages, snapshot, { limit: 2, cursor: second.nextCursor });
    expect([first.messages, second.messages, third.messages]).toEqual([
      ["m0", "m1"],
      ["m2", "m3"],
      ["m4"],
    ]);
    expect(third.nextCursor).toBeUndefined();
    expect(third.totalMessages).toBe(5);
  });

  test("a cursor read before the session, its leaf or its message count changed is stale_cursor", () => {
    const { nextCursor } = pageMessages(messages, snapshot, { limit: 2 });
    const grown = [...messages, "m5"];
    expect(
      codeOf(() =>
        pageMessages(messages, { ...snapshot, sessionId: "s2" }, { cursor: nextCursor }),
      ),
    ).toBe("stale_cursor");
    expect(
      codeOf(() => pageMessages(messages, { ...snapshot, leafId: "e2" }, { cursor: nextCursor })),
    ).toBe("stale_cursor");
    expect(
      codeOf(() => pageMessages(grown, { ...snapshot, messageCount: 6 }, { cursor: nextCursor })),
    ).toBe("stale_cursor");
  });

  test("a cursor the host did not make is refused, never read as a place", () => {
    const pastTheEnd = Buffer.from(JSON.stringify({ version: 1, ...snapshot, offset: 9 })).toString(
      "base64url",
    );
    for (const cursor of [pastTheEnd, "not a cursor!", `${pastTheEnd}=`]) {
      expect(() => pageMessages(messages, snapshot, { cursor })).toThrow("Invalid message cursor");
    }
  });

  test("without a limit a page holds omp's 100 messages", () => {
    const many = Array.from({ length: 150 }, (_, index) => index);
    const page = pageMessages(many, { ...snapshot, messageCount: 150 });
    expect(page.messages).toHaveLength(100);
    expect(page.nextCursor).toBeDefined();
  });
});

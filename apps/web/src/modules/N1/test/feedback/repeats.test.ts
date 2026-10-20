import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { Notification } from "../../contract";
import { entryKeyOf, noticeEntries } from "../../feedback/repeats";

const threadId = ThreadIdSchema.parse("thread-repeats");

function notice(overrides: Partial<Notification> & { readonly dedupeKey: string }): Notification {
  return {
    threadId,
    severity: "warning",
    placement: "toast",
    message: "Disk is almost full",
    live: "polite",
    focus: "preserve",
    ...overrides,
  };
}

describe("noticeEntries", () => {
  test("the same text, placement and severity become one entry, with the count and the newest notice", () => {
    const first = notice({ dedupeKey: "extension:notify:2:a" });
    const second = notice({ dedupeKey: "extension:notify:9:a" });
    const [entry, ...rest] = noticeEntries([first, second]);
    expect(rest).toEqual([]);
    expect(entry?.members).toEqual([first, second]);
    expect(entry?.latest).toBe(second);
  });

  test("a different text or severity is a separate entry, in the order each text first appeared", () => {
    const disk = notice({ dedupeKey: "d1" });
    const tests = notice({ dedupeKey: "t1", message: "Tests passed" });
    const diskAgain = notice({ dedupeKey: "d2" });
    const diskError = notice({ dedupeKey: "d3", severity: "error" });
    const entries = noticeEntries([disk, tests, diskAgain, diskError]);
    expect(entries.map((entry) => entry.members.length)).toEqual([2, 1, 1]);
    expect(entries.map((entry) => entry.latest.message)).toEqual([
      "Disk is almost full",
      "Tests passed",
      "Disk is almost full",
    ]);
  });

  test("an entry keeps its key while its text repeats, so it is not drawn again", () => {
    const once = noticeEntries([notice({ dedupeKey: "d1" })]);
    const twice = noticeEntries([notice({ dedupeKey: "d1" }), notice({ dedupeKey: "d2" })]);
    expect(twice[0]?.key).toBe(once[0]?.key);
    expect(entryKeyOf(notice({ dedupeKey: "other" }))).toBe(once[0]?.key);
  });

  test("no notices make no entries", () => {
    expect(noticeEntries([])).toEqual([]);
  });
});

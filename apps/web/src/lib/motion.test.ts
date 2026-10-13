import { describe, expect, test } from "vitest";
import { createdSince, isRecent, NEW_ROW_WINDOW_MS } from "./motion";

const now = 1_000_000;

describe("isRecent", () => {
  test("a row that arrived just now is new", () => {
    expect(isRecent(now, now)).toBe(true);
    expect(isRecent(now - 500, now)).toBe(true);
  });

  test("history, a reload, or a missing time is not new", () => {
    expect(isRecent(now - NEW_ROW_WINDOW_MS, now)).toBe(false);
    expect(isRecent(now - 60 * 60 * 1000, now)).toBe(false);
    expect(isRecent(undefined, now)).toBe(false);
    expect(isRecent(Number.NaN, now)).toBe(false);
  });

  test("a time in the future (clock skew) does not count as new", () => {
    expect(isRecent(now + 1, now)).toBe(false);
  });
});

describe("createdSince", () => {
  test("a row created after the list loaded is new, at any time after it", () => {
    expect(createdSince(now + 1, now)).toBe(true);
    expect(createdSince(now + 60_000, now)).toBe(true);
  });

  test("a row created more than a second before the load was listed by it, and before any load nothing is new", () => {
    expect(createdSince(now - 1_500, now)).toBe(false);
    expect(createdSince(now + 1, null)).toBe(false);
  });

  test("a row created up to a second before the load (server times are whole seconds) still counts as new", () => {
    expect(createdSince(now - 999, now)).toBe(true);
  });

  test("a time that is not a number is not new", () => {
    expect(createdSince(Number.NaN, now)).toBe(false);
  });
});

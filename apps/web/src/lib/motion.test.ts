import { describe, expect, test } from "vitest";
import { isRecent, NEW_ROW_WINDOW_MS } from "./motion";

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

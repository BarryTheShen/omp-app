import { describe, expect, test } from "vitest";
import {
  accentIndex,
  folderName,
  formatClock,
  formatDuration,
  pullRequestHref,
  safeText,
} from "../../status/format";

describe("safeText", () => {
  test("turns controls and bidi overrides into spaces and collapses runs of space", () => {
    expect(safeText("main\u0007\u202e\u2066 x\n\ty")).toBe("main x y");
  });

  test("leaves ordinary text, including non-Latin letters, as it is", () => {
    expect(safeText("café 数据 — ok")).toBe("café 数据 — ok");
  });

  test("text made only of controls is empty", () => {
    expect(safeText("\u0000\u0001 \n")).toBe("");
  });
});

describe("folderName", () => {
  test("shows the last part of a folder path", () => {
    expect(folderName("~/code/projects/omp-app")).toBe("omp-app");
    expect(folderName("/work/app")).toBe("app");
  });

  test("shows a path with no name, such as the root, whole", () => {
    expect(folderName("/")).toBe("/");
    expect(folderName("~")).toBe("~");
  });
});

describe("pullRequestHref", () => {
  test("links an https address and nothing else", () => {
    expect(pullRequestHref("https://github.com/acme/app/pull/42")).toBe(
      "https://github.com/acme/app/pull/42",
    );
    expect(pullRequestHref("http://github.com/acme/app/pull/42")).toBeUndefined();
    expect(pullRequestHref("javascript:alert(1)")).toBeUndefined();
    expect(pullRequestHref("not a link")).toBeUndefined();
  });
});

describe("accentIndex", () => {
  test("the same name always gets the same accent, from 1 to the count", () => {
    const names = ["Refactor auth", "Fix build", "Notes", "Second chat", "Deploy", "A"];
    for (const name of names) {
      const index = accentIndex(name, 5);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(5);
      expect(accentIndex(name, 5)).toBe(index);
    }
    expect(new Set(names.map((name) => accentIndex(name, 5))).size).toBeGreaterThan(1);
  });
});

describe("formatClock", () => {
  test("shows 24-hour time with no leading zero on the hour", () => {
    expect(formatClock(new Date(2026, 9, 9, 14, 3).getTime())).toBe("14:03");
    expect(formatClock(new Date(2026, 9, 9, 0, 7).getTime())).toBe("0:07");
  });
});

describe("formatDuration", () => {
  test("writes a duration the way omp does for its active time", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(42_300)).toBe("42.3s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(65_000)).toBe("1m5s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(9_000_000)).toBe("2h30m");
    expect(formatDuration(90_000_000)).toBe("1d1h");
  });

  test("rounds to tenths before it picks the unit, so a minute never reads as 60.0s", () => {
    // omp 18.8.9 packages/utils/src/format.ts:13-17: toFixed(1) alone turns 59.95 s into "60.0s".
    expect(formatDuration(59_940)).toBe("59.9s");
    expect(formatDuration(59_950)).toBe("1m");
  });
});

import { describe, expect, test } from "vitest";
import { barPercent, limitTone, resetsInWords } from "./usage-words";

describe("limitTone", () => {
  test("the bar turns warning at 75% used and danger at 90%", () => {
    expect(limitTone(0)).toBe("normal");
    expect(limitTone(74.9)).toBe("normal");
    expect(limitTone(75)).toBe("warning");
    expect(limitTone(89.9)).toBe("warning");
    expect(limitTone(90)).toBe("danger");
    expect(limitTone(100)).toBe("danger");
  });
});

describe("barPercent", () => {
  test("the bar fills the used share, held within the track", () => {
    expect(barPercent(4)).toBe(4);
    expect(barPercent(-3)).toBe(0);
    expect(barPercent(140)).toBe(100);
    expect(barPercent(Number.NaN)).toBe(0);
  });
});

describe("resetsInWords", () => {
  const now = new Date("2026-10-10T06:00:00.000Z");
  const resetIn = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  test("the reset is said as the time left, in hours and minutes", () => {
    expect(resetsInWords(resetIn(125), now)).toBe("resets in 2 h 5 min");
    expect(resetsInWords(resetIn(45), now)).toBe("resets in 45 min");
    expect(resetsInWords(resetIn(120), now)).toBe("resets in 2 h");
  });

  test("a reset days away says days and hours; a reset already due says so", () => {
    expect(resetsInWords(resetIn(25 * 60), now)).toBe("resets in 1 d 1 h");
    expect(resetsInWords(resetIn(-5), now)).toBe("resets now");
  });

  test("a reset omp did not say when it happens reads as unknown", () => {
    expect(resetsInWords(null, now)).toBe("reset time unknown");
    expect(resetsInWords("not a time", now)).toBe("reset time unknown");
  });
});

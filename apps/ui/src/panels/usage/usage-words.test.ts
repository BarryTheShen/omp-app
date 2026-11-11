import { describe, expect, test } from "vitest";
import {
  barPercent,
  combinedShare,
  limitTone,
  partWords,
  resetsInWords,
  spendWords,
} from "./usage-words";

describe("combinedShare", () => {
  test("two accounts' shares add up as omp's combined line counts them, and the bar shows their share of both", () => {
    const share = combinedShare({ accounts: 2, usedAccounts: 1.15 });
    expect(share?.percent).toBeCloseTo(57.5);
    expect(share?.used).toBe("1.15 of 2 used");
    expect(share?.left).toBe("0.85× quota left");
  });

  test("one account, or a server that sends only the fullest account's share, has no combined line", () => {
    expect(combinedShare({ accounts: 1, usedAccounts: 0.4 })).toBeNull();
    expect(combinedShare({ accounts: 2 })).toBeNull();
  });

  test("past every account's limit, nothing is left rather than a negative share", () => {
    expect(combinedShare({ accounts: 2, usedAccounts: 2.3 })?.left).toBe("0.00× quota left");
  });
});

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

describe("partWords and spendWords (#14)", () => {
  test("a chat's part: whole from 10%, one decimal under it, and a sliver said as under 0.1%", () => {
    expect(partWords(15.4)).toBe("15%");
    expect(partWords(9.96)).toBe("10%");
    expect(partWords(4.24)).toBe("4.2%");
    expect(partWords(0.04)).toBe("under 0.1%");
    expect(partWords(0)).toBe("0%");
  });

  test("a spend in dollars with cents, and one too small to show said as under a cent", () => {
    expect(spendWords(3.4)).toBe("$3.40");
    expect(spendWords(8.1941)).toBe("$8.19");
    expect(spendWords(0.004)).toBe("under $0.01");
    expect(spendWords(0)).toBe("$0.00");
  });
});

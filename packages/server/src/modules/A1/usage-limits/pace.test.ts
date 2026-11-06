import { describe, expect, test } from "bun:test";
import { type WindowReading, windowPace } from "./pace";

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse("2026-11-06T01:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Readings every 5 minutes from `from`, `count` of them, growing `perStep` percent each, all naming `resetsAt`. */
function series(
  from: number,
  count: number,
  usedAtStart: number,
  perStep: number,
  resetsAt: number | null,
): WindowReading[] {
  return Array.from({ length: count }, (_, index) => ({
    at: from + index * 5 * MIN,
    usedPercent: usedAtStart + index * perStep,
    resetsAt: resetsAt === null ? null : iso(resetsAt),
  }));
}

describe("a usage window's pace (#2836)", () => {
  test("a window filling at 12% an hour is full before its reset: when", () => {
    // 40% to 52% over an hour; the reset is 6 hours after the last reading.
    const readings = series(START, 13, 40, 1, START + 7 * HOUR);
    const last = START + HOUR;
    const pace = windowPace(readings, last);
    expect(pace.perHour).toBeCloseTo(12, 6);
    expect(pace.fullAt).toBeCloseTo(last + 4 * HOUR, -3);
    expect(pace.atReset).toBe(100);
  });

  test("a window that will not fill by its reset: how full at the reset", () => {
    const readings = series(START, 13, 40, 1, START + 3 * HOUR);
    const pace = windowPace(readings, START + HOUR);
    expect(pace.perHour).toBeCloseTo(12, 6);
    expect(pace.fullAt).toBeNull();
    expect(pace.atReset).toBeCloseTo(52 + 24, 6);
  });

  test("readings from before the window reset are left out", () => {
    const before = series(START - HOUR, 6, 90, 1.5, START);
    // After the reset: 2% to 8% in 30 minutes, 12% an hour.
    const after = series(START + 5 * MIN, 7, 2, 1, START + 5 * HOUR);
    const pace = windowPace([...before, ...after], START + 35 * MIN);
    expect(pace.perHour).toBeCloseTo(12, 6);
    expect(pace.atReset).toBeCloseTo(8 + 12 * (4 + 25 / 60), 6);
  });

  test("too few readings, or readings too close together, say nothing", () => {
    expect(windowPace(series(START, 2, 10, 5, null), START + 5 * MIN).perHour).toBeNull();
    const close = [0, 1, 2].map((minute) => ({
      at: START + minute * MIN,
      usedPercent: 10 + minute,
      resetsAt: null,
    }));
    expect(windowPace(close, START + 2 * MIN)).toEqual({
      perHour: null,
      fullAt: null,
      atReset: null,
    });
  });

  test("a level window has a pace of 0 and ends its period as full as it is", () => {
    const pace = windowPace(series(START, 7, 30, 0, START + 2 * HOUR), START + 30 * MIN);
    expect(pace).toEqual({ perHour: 0, fullAt: null, atReset: 30 });
  });
});

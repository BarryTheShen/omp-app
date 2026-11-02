import { describe, expect, test } from "vitest";
import { biggestJumps, frameStats, type ScrollFrame, scrollMoves } from "./frames";

describe("frameStats", () => {
  test("steady frames: the median and worst are one frame's length, none is long", () => {
    const times = Array.from({ length: 61 }, (_, index) => index * 8.3);
    const stats = frameStats(times);
    expect(stats.frames).toBe(60);
    expect(stats.p50).toBeCloseTo(8.3, 1);
    expect(stats.max).toBeCloseTo(8.3, 1);
    expect(stats.longFrames).toBe(0);
    expect(stats.blockedMs).toBe(0);
  });

  test("a page busy twice: two long frames, in order, and the time beyond a 60 Hz frame they blocked", () => {
    const gaps = [16.7, 16.7, 120, 16.7, 300, 16.7];
    const times = [0];
    for (const gap of gaps) times.push((times.at(-1) ?? 0) + gap);
    const stats = frameStats(times);
    expect(stats.longFrames).toBe(2);
    expect(stats.longGaps).toEqual([120, 300]);
    expect(stats.blockedMs).toBe(Math.round(120 + 300 - 2 * (1000 / 60)));
    expect(stats.max).toBe(300);
    expect(stats.p50).toBeCloseTo(16.7, 1);
  });

  test("the steady mean leaves stalls out, and tells a 16 ms timer from a 60 Hz screen that whole-millisecond times hide", () => {
    // rAF times as WebKitGTK gives them, whole milliseconds: a 16.2 ms timer and a 16.67 ms screen, each with one stall.
    const paced = (step: number) => {
      const times = Array.from({ length: 120 }, (_, index) => Math.round(index * step));
      return [...times, (times.at(-1) ?? 0) + 90];
    };
    const timer = frameStats(paced(16.2));
    const screen = frameStats(paced(1000 / 60));
    expect(timer.p50).toBe(16);
    expect(screen.p50).toBe(17);
    expect(timer.steadyMean).toBeCloseTo(16.2, 1);
    expect(screen.steadyMean).toBeCloseTo(16.67, 1);
  });

  test("no frames, or one, is no statistics", () => {
    expect(frameStats([]).frames).toBe(0);
    expect(frameStats([5]).max).toBe(0);
  });
});

describe("scrollMoves", () => {
  test("a glide: many small moves, no jump", () => {
    const tops = Array.from({ length: 40 }, (_, index) => 1000 - index * 25);
    expect(scrollMoves(tops)).toEqual({ movedPx: 975, maxJumpPx: 25, stillFrames: 0 });
  });

  test("a jump: the largest move between two frames, and the frames that did not move in between", () => {
    const tops = [0, 0, 0, 400, 400, 400, 800, 800];
    expect(scrollMoves(tops)).toEqual({ movedPx: 800, maxJumpPx: 400, stillFrames: 2 });
  });

  test("frames before the first move and after the last are not counted as still", () => {
    expect(scrollMoves([10, 10, 10, 50, 10, 10]).stillFrames).toBe(0);
  });
});

describe("biggestJumps", () => {
  /** Frames from a list of [position, scroll height, on-screen move]. */
  const frames = (rows: readonly (readonly [number, number, number | null])[]): ScrollFrame[] =>
    rows.map(([top, height, seen]) => ({ top, height, seen }));

  test("a frame's change sits with that frame's on-screen move and growth, largest first", () => {
    const scrolled = frames([
      [5000, 20000, null],
      [4880, 20000, -120],
      // Older content added above: the position follows it and the screen does not move.
      [16400, 31520, 0],
      // The view jumps: the screen shows it.
      [14000, 31520, -2400],
      [14000, 31520, 0],
    ]);
    expect(biggestJumps(scrolled, 3)).toEqual([
      { frame: 2, movedPx: 11520, seenPx: 0, grewPx: 11520 },
      { frame: 3, movedPx: -2400, seenPx: -2400, grewPx: 0 },
      { frame: 1, movedPx: -120, seenPx: -120, grewPx: 0 },
    ]);
  });

  test("frames that did not move are no jumps, and at most `count` are kept", () => {
    const scrolled = frames([
      [0, 1000, null],
      [0, 1000, 0],
      [40, 1000, 40],
      [100, 1000, null],
      [130, 1000, 30],
    ]);
    expect(biggestJumps(scrolled, 2)).toEqual([
      { frame: 3, movedPx: 60, seenPx: null, grewPx: 0 },
      { frame: 2, movedPx: 40, seenPx: 40, grewPx: 0 },
    ]);
  });
});

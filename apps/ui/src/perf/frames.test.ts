import { describe, expect, test } from "vitest";
import { frameStats, scrollMoves } from "./frames";

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

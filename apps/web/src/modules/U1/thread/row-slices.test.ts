import { afterEach, describe, expect, test, vi } from "vitest";
import {
  changeRowSlices,
  drawWithinBudget,
  FIRST_ROWS,
  mountNextSlice,
  nextChunk,
  openRowSlices,
  type RowSlices,
  SLICE_BUDGET_MS,
  START_CHUNK,
  scheduleSlice,
} from "./row-slices";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The indexes of the drawn rows, oldest first: the newest `mounted` of `total`. */
function drawn(slices: RowSlices): number[] {
  return Array.from(
    { length: slices.mounted },
    (_, offset) => slices.total - slices.mounted + offset,
  );
}

describe("the first rows of a chat", () => {
  test("a chat opens with its newest 20 rows drawn and the rest left out", () => {
    const slices = openRowSlices({ key: "chat", firstId: "m0", total: 80, mountAll: false });
    expect(slices.mounted).toBe(FIRST_ROWS);
    expect(drawn(slices)).toEqual(Array.from({ length: 20 }, (_, offset) => 60 + offset));
  });

  test("a chat shorter than the first rows draws all of them", () => {
    const slices = openRowSlices({ key: "chat", firstId: "m0", total: 7, mountAll: false });
    expect(drawn(slices)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("a restored reading place needs every row, so all of them are drawn at once", () => {
    const slices = openRowSlices({ key: "chat", firstId: "m0", total: 2000, mountAll: true });
    expect(slices.mounted).toBe(2000);
  });
});

describe("slices", () => {
  test("every row is drawn in order: the newest first, then the block above it, slice by slice", () => {
    let slices = openRowSlices({ key: "chat", firstId: "m0", total: 80, mountAll: false });
    const batches: number[][] = [];
    while (slices.mounted < slices.total) {
      const before = slices.mounted;
      slices = mountNextSlice(slices, START_CHUNK);
      // The rows this slice drew are the ones just above the block drawn before it.
      batches.push(drawn(slices).slice(0, slices.mounted - before));
    }
    expect(drawn(slices)).toEqual(Array.from({ length: 80 }, (_, index) => index));
    // The first 20 rows were drawn at the open, so the slices draw rows 59 down to 0, in blocks of at most START_CHUNK.
    for (const [index, batch] of batches.entries()) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(START_CHUNK);
      const above = index === 0 ? 60 : Math.min(...(batches[index - 1] ?? []));
      expect(Math.max(...batch)).toBe(above - 1);
    }
    expect(batches.flat()).toHaveLength(60);
  });

  test("a slice past the last row changes nothing", () => {
    const done = openRowSlices({ key: "chat", firstId: "m0", total: 5, mountAll: false });
    expect(mountNextSlice(done, 4)).toBe(done);
  });
});

describe("a change of rows during slicing", () => {
  test("a row that arrives at the end is drawn at once", () => {
    const start = openRowSlices({ key: "chat", firstId: "m0", total: 80, mountAll: false });
    const sliced = mountNextSlice(start, START_CHUNK);
    const after = changeRowSlices(sliced, {
      key: "chat",
      firstId: "m0",
      total: 82,
      mountAll: false,
    });
    expect(after.total).toBe(82);
    expect(after.mounted).toBe(sliced.mounted + 2);
  });

  test("an older page that arrives during slicing draws all its rows at once", () => {
    const start = openRowSlices({ key: "chat", firstId: "m5", total: 80, mountAll: false });
    const sliced = mountNextSlice(start, START_CHUNK);
    const older = changeRowSlices(sliced, {
      key: "chat",
      firstId: "m0",
      total: 85,
      mountAll: false,
    });
    expect(older.mounted).toBe(85);
    expect(drawn(older)).toEqual(Array.from({ length: 85 }, (_, index) => index));
  });

  test("an older page after every row is drawn is drawn at once, as before", () => {
    const start = openRowSlices({ key: "chat", firstId: "m5", total: 80, mountAll: false });
    const full = mountNextSlice(start, 80);
    const older = changeRowSlices(full, { key: "chat", firstId: "m0", total: 85, mountAll: false });
    expect(older.mounted).toBe(85);
  });

  test("the same rows return the same object, so a caller does not render again", () => {
    const start = openRowSlices({ key: "chat", firstId: "m0", total: 80, mountAll: false });
    expect(changeRowSlices(start, { key: "chat", firstId: "m0", total: 80, mountAll: false })).toBe(
      start,
    );
  });

  test("a restored reading place that starts during slicing draws every row", () => {
    const start = openRowSlices({ key: "chat", firstId: "m0", total: 80, mountAll: false });
    const drawnAll = changeRowSlices(start, {
      key: "chat",
      firstId: "m0",
      total: 80,
      mountAll: true,
    });
    expect(drawnAll.mounted).toBe(80);
  });

  test("another chat starts over at its newest rows", () => {
    const start = openRowSlices({ key: "chat", firstId: "m0", total: 80, mountAll: false });
    const other = changeRowSlices(mountNextSlice(start, 30), {
      key: "other",
      firstId: "x0",
      total: 40,
      mountAll: false,
    });
    expect(other.key).toBe("other");
    expect(other.mounted).toBe(FIRST_ROWS);
  });

  test("the first messages of an empty chat are drawn at once", () => {
    const empty = openRowSlices({ key: "new", firstId: undefined, total: 0, mountAll: false });
    expect(
      changeRowSlices(empty, { key: "new", firstId: undefined, total: 0, mountAll: false }),
    ).toBe(empty);
    const first = changeRowSlices(empty, { key: "new", firstId: "m0", total: 3, mountAll: false });
    expect(drawn(first)).toEqual([0, 1, 2]);
  });
});

describe("slice size", () => {
  test("the budget is 30 ms, the value measured against main", () => {
    expect(SLICE_BUDGET_MS).toBe(30);
  });

  test("cheap rows get bigger slices, costly rows smaller ones, within the bounds", () => {
    expect(nextChunk(START_CHUNK, 4, 1)).toBeGreaterThan(START_CHUNK);
    expect(nextChunk(START_CHUNK, 4, 40)).toBe(3);
    expect(nextChunk(START_CHUNK, 1, 0.001)).toBe(64);
  });

  test("a slice sized from its measured cost stays within the budget", () => {
    const chunk = nextChunk(START_CHUNK, 4, 4 * 1.5);
    expect(chunk * 1.5).toBeLessThanOrEqual(SLICE_BUDGET_MS);
  });

  test("a slice that drew nothing keeps the chunk it had", () => {
    expect(nextChunk(9, 0, 3)).toBe(9);
  });
});

describe("drawing within a budget", () => {
  test("stops at once when the step reports that no work is left", () => {
    let calls = 0;
    const more = drawWithinBudget(
      () => {
        calls += 1;
        return false;
      },
      6,
      () => 0,
    );
    expect(more).toBe(false);
    expect(calls).toBe(1);
  });

  test("spends the budget, then reports that work remains", () => {
    let clock = 0;
    let calls = 0;
    const more = drawWithinBudget(
      () => {
        calls += 1;
        clock += 2;
        return true;
      },
      6,
      () => clock,
    );
    expect(more).toBe(true);
    expect(calls).toBe(3);
  });

  test("with no task scheduler, each animation frame draws until the budget is spent and the rest waits for the next frame", () => {
    vi.stubGlobal("scheduler", undefined);
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    let clock = 0;
    const now = (): number => clock;
    let remaining = 10;
    const drew: number[] = [];
    const step = (): boolean => {
      clock += 2;
      remaining -= 1;
      drew.push(remaining);
      return remaining > 0;
    };
    const pump = (): void => {
      if (drawWithinBudget(step, 6, now)) scheduleSlice(pump);
    };
    scheduleSlice(pump);

    frames.shift()?.();
    expect(drew).toHaveLength(3);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(drew).toHaveLength(6);
    frames.shift()?.();
    expect(drew).toHaveLength(9);
    frames.shift()?.();
    expect(drew).toHaveLength(10);
    expect(remaining).toBe(0);
    expect(frames).toHaveLength(0);
  });
});

describe("scheduleSlice", () => {
  test("runs the slice through scheduler.postTask where the browser has it, and a cancelled slice does not run", () => {
    const queued: Array<() => void> = [];
    vi.stubGlobal("scheduler", {
      postTask: (task: () => void) => {
        queued.push(task);
        return Promise.resolve();
      },
    });
    const cancelled = vi.fn();
    const cancel = scheduleSlice(cancelled);
    cancel();
    queued[0]?.();
    expect(cancelled).not.toHaveBeenCalled();

    const run = vi.fn();
    scheduleSlice(run);
    queued[1]?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("falls back to the next animation frame where the browser has no task scheduler", () => {
    vi.stubGlobal("scheduler", undefined);
    const frames: Array<() => void> = [];
    const cancelledFrames: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelledFrames.push(id);
    });
    const run = vi.fn();
    const cancel = scheduleSlice(run);
    cancel();
    expect(cancelledFrames).toEqual([1]);
    frames[0]?.();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

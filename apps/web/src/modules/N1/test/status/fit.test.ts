import { describe, expect, test } from "vitest";
import { fitSegments } from "../../status/fit";

describe("fitSegments", () => {
  test("keeps segments in priority order, leaves out one that does not fit, and tries the rest", () => {
    const kept = fitSegments(
      [
        { id: "a", width: 100 },
        { id: "b", width: 150 },
        { id: "c", width: 40 },
      ],
      260,
      12,
    );
    expect([...kept]).toEqual(["a", "c"]);
  });

  test("counts the gap between kept segments, and not before the first", () => {
    expect([...fitSegments([{ id: "a", width: 200 }], 200, 12)]).toEqual(["a"]);
    expect([
      ...fitSegments(
        [
          { id: "a", width: 100 },
          { id: "b", width: 100 },
        ],
        200,
        12,
      ),
    ]).toEqual(["a"]);
  });

  test("never cuts a segment to make room: one wider than the room is left out whole", () => {
    expect([...fitSegments([{ id: "a", width: 300 }], 200, 12)]).toEqual([]);
  });

  test("keeps nothing when there are no segments", () => {
    expect(fitSegments([], 500, 12).size).toBe(0);
  });
});

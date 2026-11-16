import { describe, expect, test } from "vitest";
import { quickTimes } from "./WhenPicker";

/** A local time on 2026-11-16, as `new Date(y, m, d, h, min)` reads it in this browser's zone. */
const local = (day: number, hour: number, minute: number): number =>
  new Date(2026, 10, day, hour, minute).getTime();

describe("the quick times above the picker", () => {
  test("in an hour goes to the next quarter; tonight at 11 and tomorrow at 9", () => {
    expect(quickTimes(local(16, 14, 5))).toEqual([
      { label: "In an hour", at: local(16, 15, 15) },
      { label: "Tonight, 11 p.m.", at: local(16, 23, 0) },
      { label: "Tomorrow, 9 a.m.", at: local(17, 9, 0) },
    ]);
  });

  test("after 11 p.m., tonight is tomorrow night", () => {
    expect(quickTimes(local(16, 23, 30))[1]).toEqual({
      label: "Tomorrow night, 11 p.m.",
      at: local(17, 23, 0),
    });
  });
});

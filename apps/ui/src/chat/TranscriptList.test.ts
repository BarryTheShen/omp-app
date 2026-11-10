import { describe, expect, test } from "vitest";
import { spareChangeAtRest } from "./TranscriptList";

describe("the spare room a rest sets above an iPhone's transcript", () => {
  test("at the chat's beginning, room the reader sees goes whatever its size", () => {
    // 340 px of room above "Beginning of the chat" with the view at the very top, 120 px wanted for rows not measured
    // yet: the reader saw only blank room with the keyboard up.
    expect(spareChangeAtRest(340, 120, 0, false)).toBe(-340);
    // The view's top inside the room: all of it goes too.
    expect(spareChangeAtRest(340, 120, 200, false)).toBe(-340);
  });

  test("room the reader does not see waits for a drift of 500 px, and room older messages still need stays", () => {
    // The band above the view: a small drift waits, a big one is set.
    expect(spareChangeAtRest(340, 120, 340, false)).toBe(0);
    expect(spareChangeAtRest(340, 120, 5_000, false)).toBe(0);
    expect(spareChangeAtRest(2_000, 120, 5_000, false)).toBe(-1_880);
    // Older messages still to read: their room is kept even in view.
    expect(spareChangeAtRest(340, 600, 0, true)).toBe(0);
    expect(spareChangeAtRest(340, 1_200, 0, true)).toBe(860);
  });

  test("room nothing needs goes at once", () => {
    expect(spareChangeAtRest(120, 0, 5_000, false)).toBe(-120);
    expect(spareChangeAtRest(0, 0, 0, false)).toBe(0);
  });
});

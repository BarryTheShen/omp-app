import { describe, expect, test } from "vitest";
import * as d8 from "../index";

describe("the D8 barrel", () => {
  test("exports the contract and the descriptors, and no fixture", () => {
    expect(d8).toHaveProperty("D8_DESCRIPTORS");
    expect(d8).toHaveProperty("continuationStatus");
    for (const fixture of [
      "RECORDED_GOAL_CREATED",
      "GUIDED_INTERVIEW_SUCCEEDED",
      "recordedWorkerRoster",
      "AP6_UNAVAILABLE_FIXTURES",
    ]) {
      expect(d8).not.toHaveProperty(fixture);
    }
  });
});

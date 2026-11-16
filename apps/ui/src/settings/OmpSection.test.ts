import { describe, expect, test } from "vitest";
import { dialHourWords } from "./HourDial";
import { everyWords, menuChoices, NIGHT_PRESETS, nightsLabel, windowWords } from "./OmpSection";

describe("Settings → App → omp's words for the update schedule", () => {
  test("how often, as a person says it", () => {
    expect(everyWords(1)).toBe("Every night");
    expect(everyWords(2)).toBe("Every second night");
    expect(everyWords(3)).toBe("Every third night");
    expect(everyWords(5)).toBe("Every 5 nights");
    expect(everyWords(7)).toBe("Every week");
    expect(everyWords(14)).toBe("Every 2 weeks");
  });

  test("the install's two hours, as the night job says them, across noon and midnight", () => {
    expect(windowWords(3)).toBe("between 3 and 5 a.m.");
    expect(windowWords(0)).toBe("between midnight and 2 a.m.");
    expect(windowWords(10)).toBe("between 10 a.m. and noon");
    expect(windowWords(11)).toBe("between 11 a.m. and 1 p.m.");
    expect(windowWords(12)).toBe("between noon and 2 p.m.");
    expect(windowWords(21)).toBe("between 9 and 11 p.m.");
  });

  test("the dial reads each hour out on a 12-hour clock", () => {
    expect([0, 1, 11, 12, 13, 21].map(dialHourWords)).toEqual([
      "12 a.m.",
      "1 a.m.",
      "11 a.m.",
      "12 p.m.",
      "1 p.m.",
      "9 p.m.",
    ]);
  });
});

describe("the menu of how often", () => {
  const labels = (value: number) =>
    menuChoices(NIGHT_PRESETS, value, nightsLabel).map((row) => row.label);

  test("a preset set: the presets and Custom… only", () => {
    expect(labels(3)).toEqual([
      "Every night",
      "Every 2 nights",
      "Every 3 nights",
      "Every week",
      "Every 2 weeks",
      "Custom…",
    ]);
  });

  test("a value set by Custom… is a row of its own in its place, so the menu shows what is set", () => {
    expect(labels(5)).toEqual([
      "Every night",
      "Every 2 nights",
      "Every 3 nights",
      "Every 5 nights",
      "Every week",
      "Every 2 weeks",
      "Custom…",
    ]);
  });
});

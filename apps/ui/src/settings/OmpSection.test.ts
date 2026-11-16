import { describe, expect, test } from "vitest";
import { everyWords, windowWords } from "./OmpSection";

describe("Settings → App → omp's words for the update schedule", () => {
  test("how often, as a person says it", () => {
    expect(everyWords(1)).toBe("Every night");
    expect(everyWords(2)).toBe("Every second night");
    expect(everyWords(3)).toBe("Every third night");
    expect(everyWords(7)).toBe("Every 7 nights");
    expect(everyWords(14)).toBe("Every 14 nights");
  });

  test("the install's two hours, as the night job says them, across noon and midnight", () => {
    expect(windowWords(3)).toBe("between 3 and 5 a.m.");
    expect(windowWords(0)).toBe("between midnight and 2 a.m.");
    expect(windowWords(10)).toBe("between 10 a.m. and noon");
    expect(windowWords(11)).toBe("between 11 a.m. and 1 p.m.");
    expect(windowWords(12)).toBe("between noon and 2 p.m.");
    expect(windowWords(21)).toBe("between 9 and 11 p.m.");
  });
});

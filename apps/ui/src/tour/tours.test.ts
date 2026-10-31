import { describe, expect, test } from "vitest";
import { KEYS } from "../keys/table";
import { TOURS, UPDATES } from "./tours";

describe("the tours", () => {
  test("every {placeholder} in a step's text names a key of the key table", () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        for (const [, id] of step.text.matchAll(/\{([^}]*)\}/g)) {
          expect(Object.hasOwn(KEYS, id ?? ""), `${tour.id}, "${step.title}": {${id}}`).toBe(true);
        }
      }
    }
  });

  test("every key a step waits for is a key of the key table", () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.action.kind !== "keys") continue;
        expect(
          Object.hasOwn(KEYS, step.action.key),
          `${tour.id}, "${step.title}": ${step.action.key}`,
        ).toBe(true);
      }
    }
  });

  test("tour ids are unique", () => {
    const ids = TOURS.map((tour) => tour.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("updates are listed newest first, each with a time that parses, an id of its own and a tour", () => {
    const times = UPDATES.map((update) => Date.parse(update.when));
    for (const [index, time] of times.entries()) {
      expect(Number.isNaN(time), UPDATES[index]?.id).toBe(false);
      if (index > 0) expect(time, UPDATES[index]?.id).toBeLessThan(times[index - 1] ?? 0);
    }
    expect(new Set(UPDATES.map((update) => update.id)).size).toBe(UPDATES.length);
    for (const update of UPDATES) expect(update.tours.length, update.id).toBeGreaterThan(0);
  });
});

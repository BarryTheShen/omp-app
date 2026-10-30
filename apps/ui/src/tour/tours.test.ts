import { describe, expect, test } from "vitest";
import { KEYS } from "../keys/table";
import { TOURS } from "./tours";

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
});

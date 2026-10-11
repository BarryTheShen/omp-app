import { describe, expect, test } from "vitest";
import { S1_INTERACTION_SECTIONS } from "../../interaction";
import type { ConfigSnapshot, SettingControl } from "../../settings-kit";
import { numberRangeWords, validate } from "../../settings-kit";

const snapshot: ConfigSnapshot = { folder: null, revision: "number-range-1", entries: [] };

function control(key: string): SettingControl {
  const found = S1_INTERACTION_SECTIONS.flatMap((section) => section.controls).find(
    (candidate) => candidate.key === key,
  );
  if (found === undefined) throw new Error(`No Interaction setting has the key ${key}.`);
  return found;
}

describe("the words that state a number's allowed range", () => {
  test("no maximum, or Number.MAX_VALUE, says 'or more' and never prints that number", () => {
    expect(numberRangeWords(false, 0, Number.MAX_VALUE)).toBe("a number, 0 or more");
    expect(numberRangeWords(true, 0, Number.MAX_VALUE)).toBe("a whole number, 0 or more");
    expect(numberRangeWords(false, 0)).toBe("a number, 0 or more");
    expect(numberRangeWords(true, 1, Number.POSITIVE_INFINITY)).toBe("a whole number, 1 or more");
  });

  test("a bounded range prints both ends, as it did before", () => {
    expect(numberRangeWords(true, 0, 100)).toBe("a whole number from 0 to 100");
    expect(numberRangeWords(false, 0, 1)).toBe("a number from 0 to 1");
  });
});

describe("the Interaction tab's number rules", () => {
  test("Loop Condition Timeout refuses -1 and an empty field in plain words", () => {
    const timeout = control("loop.conditionTimeoutMs");
    for (const value of [-1, ""]) {
      expect(validate(timeout, { secret: false, value }, snapshot)).toEqual({
        valid: false,
        code: "range",
        message: "Enter a number, 0 or more.",
      });
    }
    expect(validate(timeout, { secret: false, value: 5000 }, snapshot)).toEqual({ valid: true });
  });

  test("Large Paste Menu, a whole number with no upper limit, says so in plain words", () => {
    expect(
      validate(control("paste.largeMenuThreshold"), { secret: false, value: -1 }, snapshot),
    ).toEqual({
      valid: false,
      code: "range",
      message: "Enter a whole number, 0 or more.",
    });
  });

  test("Ask Timeout and Idle Recap Delay say so in plain words", () => {
    for (const key of ["ask.timeout", "recap.idleSeconds"]) {
      expect(validate(control(key), { secret: false, value: -1 }, snapshot)).toEqual({
        valid: false,
        code: "range",
        message: "Enter a number, 0 or more.",
      });
    }
  });
});

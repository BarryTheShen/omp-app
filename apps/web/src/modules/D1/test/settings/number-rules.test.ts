import { describe, expect, test } from "vitest";
import type { ConfigSnapshot } from "@/modules/S1/settings-kit";
import { validate } from "@/modules/S1/settings-kit";
import { modelSettingsSections } from "../../settings/descriptors";

const snapshot: ConfigSnapshot = { folder: null, revision: "r", entries: [] };

function check(key: string, value: unknown): string | null {
  const control = modelSettingsSections
    .flatMap((section) => section.controls)
    .find((candidate) => candidate.key === key);
  if (control === undefined) throw new Error(`no D1 setting ${key}`);
  const result = validate(control, { secret: false, value: value as never }, snapshot);
  return result.valid ? null : result.message;
}

const COUNT = "Enter a whole number, 0 or more.";
const DEFAULTABLE = "Enter a number, 0 or more, or -1 for the provider's default.";
const UNIT_RANGE = "Enter a number from 0 to 1, or -1 for the provider's default.";

describe("D1 number settings", () => {
  test("a retry count or delay is a whole number of 0 or more", () => {
    for (const key of ["retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs"]) {
      expect(check(key, 0)).toBeNull();
      expect(check(key, 3)).toBeNull();
      expect(check(key, -1)).toBe(COUNT);
      expect(check(key, 1.5)).toBe(COUNT);
      expect(check(key, Number.NaN)).toBe(COUNT);
      // An emptied field reaches the check as text, not as 0.
      expect(check(key, "")).toBe(COUNT);
    }
  });

  test("a sampling value is -1 (omp's own way to say the provider's default) or inside its range", () => {
    expect(check("temperature", -1)).toBeNull();
    expect(check("temperature", 0)).toBeNull();
    expect(check("temperature", 1.5)).toBeNull();
    expect(check("temperature", -0.5)).toBe(DEFAULTABLE);

    expect(check("topP", 1)).toBeNull();
    expect(check("topP", 0.9)).toBeNull();
    expect(check("topP", -1)).toBeNull();
    expect(check("topP", 1.5)).toBe(UNIT_RANGE);
    expect(check("topP", -0.5)).toBe(UNIT_RANGE);
    expect(check("minP", 0.05)).toBeNull();
    expect(check("minP", 2)).toBe(UNIT_RANGE);

    expect(check("topK", 40)).toBeNull();
    expect(check("topK", -1)).toBeNull();
    expect(check("topK", 0)).toBe(
      "Enter a whole number, 1 or more, or -1 for the provider's default.",
    );
    expect(check("topK", 2.5)).toBe(
      "Enter a whole number, 1 or more, or -1 for the provider's default.",
    );

    expect(check("presencePenalty", 0.5)).toBeNull();
    expect(check("presencePenalty", -2)).toBe(DEFAULTABLE);
    expect(check("repetitionPenalty", 1.1)).toBeNull();
    expect(check("repetitionPenalty", -1)).toBeNull();
  });

  test("the loop threshold is a whole number of 1 or more and the usage reserve is a percentage", () => {
    expect(check("model.toolCallLoopGuard.threshold", 5)).toBeNull();
    expect(check("model.toolCallLoopGuard.threshold", 0)).toBe("Enter a whole number, 1 or more.");
    expect(check("model.toolCallLoopGuard.threshold", 2.5)).toBe(
      "Enter a whole number, 1 or more.",
    );
    expect(check("retry.usageReservePct", 10)).toBeNull();
    expect(check("retry.usageReservePct", 100)).toBeNull();
    expect(check("retry.usageReservePct", 101)).toBe("Enter a number from 0 to 100.");
    expect(check("retry.usageReservePct", -1)).toBe("Enter a number from 0 to 100.");
  });
});

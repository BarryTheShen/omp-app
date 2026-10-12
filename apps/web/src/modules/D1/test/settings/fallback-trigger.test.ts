import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl } from "@/modules/S1/settings-kit";
import { validate } from "@/modules/S1/settings-kit";
import { modelSettingsSections } from "../../settings/descriptors";

const snapshot: ConfigSnapshot = { folder: null, revision: "r", entries: [] };

function fallbackTrigger(): SettingControl {
  const control = modelSettingsSections
    .flatMap((section) => section.controls)
    .find((candidate) => candidate.key === "retry.fallbackOn");
  if (control === undefined) throw new Error("the Fallback Trigger is not in the model settings");
  return control;
}

describe("the Fallback Trigger (retry.fallbackOn)", () => {
  test("sits in Retry & Fallback and offers omp's three choices, with plain labels", () => {
    const section = modelSettingsSections.find(
      (candidate) => candidate.section === "model/Retry & Fallback",
    );
    expect(section?.controls.map((control) => control.key)).toContain("retry.fallbackOn");

    const control = fallbackTrigger();
    expect(control.label).toBe("Fallback Trigger");
    expect(control.kind).toBe("enum");
    expect(control.kind === "enum" ? control.options : undefined).toEqual([
      { value: "any", label: "Any error" },
      { value: "usage-limit", label: "Usage limit only" },
      { value: "except-usage-limit", label: "Errors other than usage limits" },
    ]);
  });

  test("says in its own description that it needs omp 18.9, because an older omp ignores the saved key", () => {
    expect(fallbackTrigger().description).toContain("Needs omp 18.9 or newer");
  });

  test("saves only omp's three values, and refuses any other with the choices in words", () => {
    const control = fallbackTrigger();
    for (const value of ["any", "usage-limit", "except-usage-limit"]) {
      expect(validate(control, { secret: false, value }, snapshot)).toEqual({ valid: true });
    }
    expect(validate(control, { secret: false, value: "retries" }, snapshot)).toMatchObject({
      valid: false,
      message: "Choose one of: Any error, Usage limit only, Errors other than usage limits.",
    });
  });

  test("takes effect at once, because omp reads the trigger each time a request fails", () => {
    expect(fallbackTrigger().apply).toBe("live");
  });
});

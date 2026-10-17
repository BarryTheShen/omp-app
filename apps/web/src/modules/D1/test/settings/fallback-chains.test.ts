import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl } from "@/modules/S1/settings-kit";
import { validate } from "@/modules/S1/settings-kit";
import { modelSettingsSections } from "../../settings/descriptors";

const snapshot: ConfigSnapshot = { folder: null, revision: "r", entries: [] };

function fallbackChains(): SettingControl {
  const control = modelSettingsSections
    .flatMap((section) => section.controls)
    .find((candidate) => candidate.key === "retry.fallbackChains");
  if (control === undefined) throw new Error("Retry Fallback Chains is missing");
  return control;
}

describe("Retry Fallback Chains (retry.fallbackChains)", () => {
  const chain = () => fallbackChains();

  test("uses omp's map shape, plain labels, and live apply status", () => {
    const control = chain();
    expect(control).toMatchObject({
      key: "retry.fallbackChains",
      label: "Retry Fallback Chains",
      kind: "map",
      apply: "live",
      keyLabel: "Role or model selector",
      value: { kind: "list", label: "Fallback selectors" },
    });
  });

  test("accepts ordered fallback selector arrays", () => {
    expect(
      validate(
        chain(),
        {
          secret: false,
          value: { default: ["openai/gpt-4o-mini"], "google/*": ["google-vertex/*"] },
        },
        snapshot,
      ),
    ).toEqual({ valid: true });
  });

  test.each([
    [{ " ": ["openai/gpt-4o-mini"] }, "Each fallback chain needs selectors in order."],
    [{ default: [""] }, "Each fallback chain needs selectors in order."],
    [{ default: [3] }, "Each fallback chain needs selectors in order."],
    [{ default: "openai/gpt-4o-mini" }, "Each fallback chain needs selectors in order."],
  ])("rejects malformed chain %# with its validation sentence", (value, message) => {
    expect(validate(chain(), { secret: false, value }, snapshot)).toEqual({
      valid: false,
      code: "record",
      message,
    });
  });
});

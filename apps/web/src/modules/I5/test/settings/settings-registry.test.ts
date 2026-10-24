import { describe, expect, test } from "vitest";
import { SETTINGS_SECTIONS } from "@/registry";
import liveRegistry from "../../fixtures/omp-settings-keys.v18.12.6.json";

const REMOVED_IN_OMP_18_10_4 = [
  "providers.openai-codex.codeMode",
  "providers.openai-codex.codeModeDirectTools",
] as const;

const APP_SETTING_KEYS = [
  ...new Set(
    SETTINGS_SECTIONS.flatMap((section) => section.controls.map((control) => control.key)),
  ),
];

describe("omp 18.12.6 settings compatibility", () => {
  test("the only app descriptor keys missing from omp's loaded registry are the deliberate drops", () => {
    const liveKeys = new Set(liveRegistry.keys);
    const missing = APP_SETTING_KEYS.filter((key) => !liveKeys.has(key)).sort();
    expect(missing).toEqual([...REMOVED_IN_OMP_18_10_4].sort());
  });
});

import { describe, expect, test } from "vitest";
import { SETTINGS_SECTIONS } from "@/registry";
import liveRegistry from "../../fixtures/omp-settings-keys.v18.12.6.json";

const APP_SETTING_KEYS = [
  ...new Set(
    SETTINGS_SECTIONS.flatMap((section) => section.controls.map((control) => control.key)),
  ),
];

describe("omp 18.12.6 settings compatibility", () => {
  test("every app descriptor key is in omp's loaded registry", () => {
    const liveKeys = new Set(liveRegistry.keys);
    const missing = APP_SETTING_KEYS.filter((key) => !liveKeys.has(key)).sort();
    expect(missing).toEqual([]);
  });
});

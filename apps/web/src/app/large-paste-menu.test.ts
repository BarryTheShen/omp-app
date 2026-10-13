import type { ConfigEntry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigSnapshot } from "@/modules/S1/settings-kit";
import { DEFAULT_LARGE_PASTE_LINE_THRESHOLD } from "@/modules/U2/attachments";
import { largePasteThresholdOf } from "./large-paste-menu";

function entry(key: string, value: string | number | boolean): ConfigEntry {
  return { key, secret: false, value, source: "default", overrides: [] };
}

function config(entries: readonly ConfigEntry[]): ConfigSnapshot {
  return { folder: null, revision: "revision-1", entries };
}

describe("the Large Paste Menu threshold the app provides", () => {
  test("is omp's default of 100 lines before any value is read", () => {
    expect(DEFAULT_LARGE_PASTE_LINE_THRESHOLD).toBe(100);
    expect(largePasteThresholdOf(null)).toBe(100);
  });

  test("is the saved number, and 0 when the menu is off", () => {
    expect(largePasteThresholdOf(config([entry("paste.largeMenuThreshold", 250)]))).toBe(250);
    expect(largePasteThresholdOf(config([entry("paste.largeMenuThreshold", 0)]))).toBe(0);
  });

  test("is omp's default when the setting is missing or is not a number", () => {
    expect(largePasteThresholdOf(config([entry("steeringMode", "all")]))).toBe(100);
    expect(largePasteThresholdOf(config([entry("paste.largeMenuThreshold", "250")]))).toBe(100);
  });
});

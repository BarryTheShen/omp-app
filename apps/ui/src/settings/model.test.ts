import type { ConfigEntry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SettingDef, SettingsTab } from "./data";
import { changedHere, type Entries, inForce, matches, sections, shown, valueText } from "./model";

const plain = (key: string, value: unknown, source: ConfigEntry["source"]) =>
  ({ key, secret: false, value, source, overrides: [] }) as ConfigEntry;
const secret = (key: string, isSet: boolean, source: ConfigEntry["source"]) =>
  ({ key, secret: true, isSet, source, overrides: [] }) as ConfigEntry;
const def = (over: Partial<SettingDef> & { key: string }): SettingDef => ({
  tab: "memory",
  group: null,
  type: "boolean",
  label: over.key,
  description: "",
  ...over,
});

describe("settings rows", () => {
  test("a row is changed only where the scope's own file sets it", () => {
    expect(changedHere(plain("a", true, "global"), "global")).toBe(true);
    // Viewing one folder: the every-folder file's value is not this folder's change.
    expect(changedHere(plain("a", true, "global"), "project")).toBe(false);
    expect(changedHere(plain("a", true, "project"), "project")).toBe(true);
    expect(changedHere(plain("a", true, "default"), "global")).toBe(false);
    expect(changedHere(plain("a", true, "env"), "global")).toBe(false);
    expect(changedHere(undefined, "global")).toBe(false);
    // Removed, with nothing left to set it.
    expect(changedHere(plain("a", null, "global"), "global")).toBe(false);
    expect(changedHere(secret("k", true, "global"), "global")).toBe(true);
    expect(changedHere(secret("k", false, "global"), "global")).toBe(false);
  });

  test("the value in force falls back to omp's default; a secret's never shows", () => {
    const backend = def({ key: "memory.backend", type: "enum", default: "off" });
    expect(inForce(backend, new Map())).toBe("off");
    expect(
      inForce(
        backend,
        new Map([["memory.backend", plain("memory.backend", "hindsight", "global")]]),
      ),
    ).toBe("hindsight");
    expect(
      inForce(backend, new Map([["memory.backend", plain("memory.backend", null, "global")]])),
    ).toBe("off");
    const token = def({ key: "token", type: "string", secret: true });
    expect(inForce(token, new Map([["token", secret("token", true, "global")]]))).toBeUndefined();
  });

  test("omp's conditions read the values in force, defaults included; an unknown one shows the row", () => {
    const hindsight = def({ key: "hindsight.url", type: "string", condition: "hindsightActive" });
    const values = (backend: unknown) => (key: string) =>
      key === "memory.backend" ? backend : undefined;
    const none: Entries = new Map();
    expect(shown(hindsight, values("hindsight"), none)).toBe(true);
    expect(shown(hindsight, values("off"), none)).toBe(false);
    const autosave = def({
      key: "plan.autosaveDir",
      type: "string",
      condition: "planAutosaveEnabled",
    });
    const plan = (enabled: unknown, autosave: unknown) => (key: string) =>
      key === "plan.enabled" ? enabled : key === "plan.autosave" ? autosave : undefined;
    expect(shown(autosave, plan(true, true), none)).toBe(true);
    expect(shown(autosave, plan(true, false), none)).toBe(false);
    expect(shown(autosave, plan(false, true), none)).toBe(false);
    // omp edits this list in the global file only: hidden while a folder's own file sets it.
    const extra = def({
      key: "contextFiles.extra",
      type: "array",
      condition: "contextFilesExtraNotProject",
    });
    const folderSets: Entries = new Map([
      ["contextFiles.extra", plain("contextFiles.extra", ["a"], "project")],
    ]);
    expect(shown(extra, () => undefined, folderSets)).toBe(false);
    expect(shown(extra, () => undefined, none)).toBe(true);
    expect(shown(def({ key: "x", condition: "someNewCondition" }), () => undefined, none)).toBe(
      true,
    );
  });

  test("a value in words names a choice by its label, a number's choice too", () => {
    const delay = def({
      key: "delay",
      type: "number",
      choices: [
        { value: "0", label: "Off" },
        { value: "30", label: "30 seconds" },
      ],
    });
    expect(valueText(delay, 30)).toBe("30 seconds");
    expect(valueText(delay, 45)).toBe("45");
    expect(valueText(def({ key: "on" }), false)).toBe("off");
    expect(valueText(def({ key: "list", type: "array" }), [])).toBe("none");
    expect(valueText(def({ key: "list", type: "array" }), ["a", "b"])).toBe("a, b");
    expect(valueText(def({ key: "text", type: "string" }), undefined)).toBe("not set");
  });

  test("search finds a label, a description or a key; sections keep omp's order", () => {
    const one = def({
      key: "goal.enabled",
      label: "Goal Mode",
      description: "Enable per-session goal mode",
    });
    expect(matches(one, "goal mode")).toBe(true);
    expect(matches(one, "per-session")).toBe(true);
    expect(matches(one, "goal.enabled")).toBe(true);
    expect(matches(one, "plan")).toBe(false);
    const tab: SettingsTab = {
      id: "memory",
      label: "Memory",
      lead: "",
      groups: ["General", "Hindsight"],
    };
    const listed = sections(tab, [
      def({ key: "h", group: "Hindsight" }),
      def({ key: "new", group: "Brand New" }),
      def({ key: "g", group: "General" }),
      def({ key: "top", group: null }),
    ]);
    expect(listed.map((section) => section.group)).toEqual([
      null,
      "General",
      "Hindsight",
      "Brand New",
    ]);
  });
});

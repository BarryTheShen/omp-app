import type { JsonValue } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl, SettingValue } from "../../S1/settings-kit";
import { validate } from "../../S1/settings-kit";
import { CONTEXT_GENERAL_SETTINGS } from "./descriptors";

const snapshot: ConfigSnapshot = { folder: null, revision: "test-revision", entries: [] };

function extraFilesControl(): SettingControl {
  const control = CONTEXT_GENERAL_SETTINGS.controls.find(
    (candidate) => candidate.key === "contextFiles.extra",
  );
  if (!control) throw new Error("missing contextFiles.extra control");
  return control;
}

function check(value: JsonValue): string | null {
  const result = validate(extraFilesControl(), { secret: false, value } as SettingValue, snapshot);
  return result.valid ? null : result.message;
}

describe("contextFiles.extra", () => {
  test("is a list setting and accepts an empty list or extra filenames", () => {
    const control = extraFilesControl();
    expect(control.kind).toBe("list");
    expect(check([])).toBeNull();
    expect(check(["AGENTS.local.md", "project.instructions"])).toBeNull();
  });

  test("rejects empty names, built-in context names and paths in plain words", () => {
    expect(check([""])).toBe("Extra context filenames cannot be empty.");
    expect(check(["agents.md"])).toBe("Do not list a built-in context filename.");
    expect(check(["nested/extra.md"])).toBe("Enter filenames only, not paths.");
    expect(check([".."])).toBe("Enter filenames only, not paths.");
    expect(check(["extra\u0000.md"])).toBe("Enter filenames only, not paths.");
  });

  // omp trims each entry and compares built-in names in lower case (`contextFileNameError`,
  // session/context-settings.ts:33-46 @v18.9.1) and rejects the setting when one is listed; the app must refuse the same entries.
  test("judges an entry as omp does: trimmed, and built-in names in any letter case", () => {
    expect(check(["AGENTS.MD"])).toBe("Do not list a built-in context filename.");
    expect(check(["  agents.md  "])).toBe("Do not list a built-in context filename.");
    expect(check(["   "])).toBe("Extra context filenames cannot be empty.");
    expect(check(["  AGENTS.local.md  "])).toBeNull();
  });

  test("rejects non-list and non-text entries", () => {
    expect(check("AGENTS.local.md")).toBe("Enter a list of extra context filenames.");
    expect(check([42])).toBe("Each extra context filename must be text.");
  });
});

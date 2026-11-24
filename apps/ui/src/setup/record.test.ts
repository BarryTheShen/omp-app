import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Change } from "./plan";
import { applyChanges, keptRecord, type Setters, undoSetup } from "./record";

const CHANGES: readonly Change[] = [
  { where: "browser", setting: "themeMode", from: "system", to: "dark" },
  { where: "omp", key: "tools.approvalMode", from: "yolo", to: "write", theirs: false },
  { where: "omp", key: "defaultThinkingLevel", from: "low", to: "high", theirs: true },
];

/** Setters that keep what they were told, in order. */
function recording(failOn?: string): { readonly set: Setters; readonly done: string[] } {
  const done: string[] = [];
  return {
    done,
    set: {
      browser: (setting, value) => {
        done.push(`browser ${setting}=${String(value)}`);
      },
      omp: async (key, value) => {
        if (key === failOn) throw new Error("the file is read-only");
        done.push(`omp ${key}=${String(value)}`);
      },
    },
  };
}

describe("applying the setup and undoing it", () => {
  // This browser's storage as the tests see it.
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    });
  });

  test("undo puts back the person's own values and unsets omp's defaults, last first", async () => {
    const apply = recording();
    await applyChanges(CHANGES, apply.set);
    expect(apply.done).toEqual([
      "browser themeMode=dark",
      "omp tools.approvalMode=write",
      "omp defaultThinkingLevel=high",
    ]);
    const record = keptRecord();
    expect(record?.changes).toHaveLength(3);
    if (record === null) return;

    const undo = recording();
    await undoSetup(record, undo.set);
    expect(undo.done).toEqual([
      "omp defaultThinkingLevel=low",
      "omp tools.approvalMode=unset",
      "browser themeMode=system",
    ]);
    expect(keptRecord()).toBeNull();
  });

  test("a change that fails stops the rest, and what was made before it can still be undone", async () => {
    const apply = recording("tools.approvalMode");
    await expect(applyChanges(CHANGES, apply.set)).rejects.toThrow("the file is read-only");
    expect(apply.done).toEqual(["browser themeMode=dark"]);
    expect(keptRecord()?.changes).toEqual([CHANGES[0]]);
  });
});

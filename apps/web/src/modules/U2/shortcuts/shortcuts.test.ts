import { describe, expect, test, vi } from "vitest";
import { MemoryPreferenceStore, ShortcutRegistry } from "../../../shortcuts/registry";
import { U2Descriptors } from "../descriptors/descriptors";
import { registerComposerShortcutActions, U2_EXTERNAL_EDITOR_SHORTCUT } from "./shortcuts";

describe("U2.5 composer shortcut registration", () => {
  test("uses omp's external-editor chord and does not claim P6 follow-up", () => {
    expect(U2_EXTERNAL_EDITOR_SHORTCUT.chord).toBe("Mod+G");
    expect(U2_EXTERNAL_EDITOR_SHORTCUT.covers).toEqual([]);
    expect(
      U2Descriptors.some(
        (descriptor) => descriptor.kind === "shortcut" && descriptor.chord === "Mod+Enter",
      ),
    ).toBe(false);
  });

  test("registers and disposes host actions through U0.6", () => {
    const registry = new ShortcutRegistry([...U2Descriptors, U2_EXTERNAL_EDITOR_SHORTCUT], {
      preferenceStore: new MemoryPreferenceStore(),
    });
    const externalEditor = vi.fn();
    const dispose = registerComposerShortcutActions(registry, { externalEditor });
    expect(
      registry.bindings().some((binding) => binding.id === U2_EXTERNAL_EDITOR_SHORTCUT.id),
    ).toBe(true);
    dispose();
  });
});

import { normalizeChord } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { ShortcutRegistry } from "../../../shortcuts/registry";
import { D1_SHORTCUT_DESCRIPTORS } from "./descriptors";
import { registerD1ShortcutActions } from "./registry";

function event(key: string, options: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
}

describe("D1 model/thinking shortcuts", () => {
  test("uses the omp v18.6.1 chords without inventing replacements", () => {
    expect(D1_SHORTCUT_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.chord])).toEqual([
      ["D1.appModelCycleBackward", "Mod+Shift+P"],
      ["D1.appModelCycleForward", "Mod+P"],
      ["D1.appModelSelect", "Alt+M"],
      ["D1.appModelSelectTemporary", "Alt+P"],
      ["D1.appThinkingCycle", "Shift+Tab"],
    ]);
    expect(normalizeChord("Shift+Ctrl+P")).toBe("ctrl+shift+p");
  });

  test("registers actions through U0 ShortcutRegistry and dispatches global chords", () => {
    const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
    const actions = {
      cycleModelBackward: vi.fn(),
      cycleModelForward: vi.fn(),
      selectModel: vi.fn(),
      selectTemporaryModel: vi.fn(),
      cycleThinking: vi.fn(),
    };
    const dispose = registerD1ShortcutActions(registry, actions);
    expect(registry.dispatch(event("P", { ctrlKey: true }), "global")).toMatchObject({
      handled: true,
      binding: { id: "D1.appModelCycleForward" },
    });
    expect(actions.cycleModelForward).toHaveBeenCalledOnce();
    expect(registry.problems()).toContainEqual({
      kind: "reserved-chord",
      id: "D1.appThinkingCycle",
      chord: "Shift+Tab",
      detail: "Shift+Tab moves keyboard focus in the browser",
    });
    expect(registry.dispatch(event("Tab", { shiftKey: true }), "global")).toEqual({
      handled: false,
    });
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    dispose();
  });
});

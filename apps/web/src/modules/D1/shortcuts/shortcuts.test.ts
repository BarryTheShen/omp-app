import { normalizeChord } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { ShortcutRegistry } from "../../../shortcuts/registry";
import { D1_SHORTCUT_DESCRIPTORS } from "./descriptors";
import { registerD1ShortcutActions } from "./registry";

/** Dispatches a key press on `target` and runs the registry on it, the way the app's listeners do. */
function press(
  registry: ShortcutRegistry,
  init: KeyboardEventInit,
  target: EventTarget = document.body,
) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return registry.dispatch(event, "global");
}

function actions() {
  return {
    cycleModelForward: vi.fn(),
    selectModel: vi.fn(),
    selectTemporaryModel: vi.fn(),
    cycleThinking: vi.fn(),
  };
}

describe("D1 model/thinking shortcuts", () => {
  test("declares omp's chords the browser does not take, with the thinking cycle moved off Shift+Tab", () => {
    expect(D1_SHORTCUT_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.chord])).toEqual([
      ["D1.appModelCycleForward", "Mod+P"],
      ["D1.appModelSelect", "Alt+M"],
      ["D1.appModelSelectTemporary", "Alt+P"],
      ["D1.appThinkingCycle", "Alt+K"],
    ]);
    expect(normalizeChord("Shift+Ctrl+P")).toBe("ctrl+shift+p");
  });

  test("runs each action from its chord through the real registry", () => {
    const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
    const run = actions();
    const dispose = registerD1ShortcutActions(registry, run);

    expect(press(registry, { key: "p", ctrlKey: true })).toMatchObject({
      handled: true,
      binding: { id: "D1.appModelCycleForward" },
    });
    expect(press(registry, { key: "m", altKey: true })).toMatchObject({
      handled: true,
      binding: { id: "D1.appModelSelect" },
    });
    expect(press(registry, { key: "p", altKey: true })).toMatchObject({
      handled: true,
      binding: { id: "D1.appModelSelectTemporary" },
    });
    expect(press(registry, { key: "k", altKey: true })).toMatchObject({
      handled: true,
      binding: { id: "D1.appThinkingCycle" },
    });

    expect(run.cycleModelForward).toHaveBeenCalledOnce();
    expect(run.selectModel).toHaveBeenCalledOnce();
    expect(run.selectTemporaryModel).toHaveBeenCalledOnce();
    expect(run.cycleThinking).toHaveBeenCalledOnce();
    dispose();
  });

  test("keeps the chords working while the composer's text box has focus", () => {
    const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
    const run = actions();
    const dispose = registerD1ShortcutActions(registry, run);
    const composer = document.createElement("textarea");
    document.body.append(composer);

    expect(press(registry, { key: "m", altKey: true }, composer).handled).toBe(true);
    expect(press(registry, { key: "k", altKey: true }, composer).handled).toBe(true);
    expect(run.selectModel).toHaveBeenCalledOnce();
    expect(run.cycleThinking).toHaveBeenCalledOnce();
    composer.remove();
    dispose();
  });

  test("no declared chord is browser-reserved, so the shortcut sheet offers only chords that can run", () => {
    const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
    expect(registry.problems()).toEqual([]);
    for (const descriptor of D1_SHORTCUT_DESCRIPTORS) {
      expect(registry.isBrowserReserved(descriptor.chord, descriptor.scope)).toBe(false);
    }
  });

  test("a disposed registration stops its chord", () => {
    const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
    const run = actions();
    const dispose = registerD1ShortcutActions(registry, run);
    dispose();

    expect(press(registry, { key: "m", altKey: true }).handled).toBe(false);
    expect(run.selectModel).not.toHaveBeenCalled();
  });
});

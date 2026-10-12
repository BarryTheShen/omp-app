import type { Descriptor } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { MemoryPreferenceStore, ShortcutRegistry } from "./registry";

/** A chord that acts only inside the element that carries data-focus-scope="composer-input" (the message box). */
const boxChord: Descriptor & { readonly allowInEditable: true; readonly focus: string } = {
  id: "U2.boxChord",
  owner: "U2",
  title: "Box chord",
  kind: "shortcut",
  chord: "Mod+U",
  scope: "composer",
  covers: [],
  requires: [],
  allowInEditable: true,
  focus: "composer-input",
};

/** A chord with no focus scope, to show that ordinary chords still act outside text boxes. */
const anywhereChord: Descriptor = {
  id: "U2.anywhereChord",
  owner: "U2",
  title: "Anywhere chord",
  kind: "shortcut",
  chord: "Mod+M",
  scope: "composer",
  covers: [],
  requires: [],
};

const descriptors: readonly Descriptor[] = [boxChord, anywhereChord];

function newRegistry(): ShortcutRegistry {
  return new ShortcutRegistry(descriptors, { preferenceStore: new MemoryPreferenceStore() });
}

function ctrl(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
}

describe("a chord that names a focus scope", () => {
  test("outside that scope it is not handled, and the browser keeps the key", () => {
    const registry = newRegistry();
    const action = vi.fn();
    registry.registerAction("U2.boxChord", action);
    const sidebarSearch = document.createElement("input");
    document.body.append(sidebarSearch);
    const event = ctrl("u");
    sidebarSearch.dispatchEvent(event);
    expect(registry.dispatch(event, "composer")).toEqual({ handled: false });
    expect(action).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    sidebarSearch.remove();
  });

  test("inside that scope it acts and the key is prevented", () => {
    const registry = newRegistry();
    const action = vi.fn();
    registry.registerAction("U2.boxChord", action);
    const box = document.createElement("div");
    box.dataset.focusScope = "composer-input";
    const textarea = document.createElement("textarea");
    box.append(textarea);
    document.body.append(box);
    const event = ctrl("u");
    textarea.dispatchEvent(event);
    expect(registry.dispatch(event, "composer")).toMatchObject({
      handled: true,
      binding: { id: "U2.boxChord" },
    });
    expect(action).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    box.remove();
  });

  test("a chord with no focus scope still acts outside text boxes, as before", () => {
    const registry = newRegistry();
    const action = vi.fn();
    registry.registerAction("U2.anywhereChord", action);
    const button = document.createElement("button");
    document.body.append(button);
    const event = ctrl("m");
    button.dispatchEvent(event);
    expect(registry.dispatch(event, "composer")).toMatchObject({ handled: true });
    expect(action).toHaveBeenCalledOnce();
    button.remove();
  });
});

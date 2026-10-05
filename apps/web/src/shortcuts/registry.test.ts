import type { Descriptor } from "@omp-app/contracts";
import { normalizeChord } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { MemoryPreferenceStore, ShortcutRegistry } from "./registry";

const descriptors: readonly Descriptor[] = [
  {
    id: "U0.sheet",
    owner: "U0",
    title: "Shortcut sheet",
    kind: "shortcut",
    chord: "Mod+?",
    scope: "global",
    covers: [],
    requires: [],
  },
  {
    id: "U0.send",
    owner: "U0",
    title: "Send",
    kind: "shortcut",
    chord: "Mod+Enter",
    scope: "composer",
    covers: [],
    requires: [],
  },
  {
    id: "U1.toggle",
    owner: "U1",
    title: "Toggle thinking",
    kind: "shortcut",
    chord: "Alt+T",
    scope: "transcript",
    covers: [],
    requires: [],
  },
  {
    id: "U2.other",
    owner: "U2",
    title: "Other composer shortcut",
    kind: "shortcut",
    chord: "Mod+Shift+Enter",
    scope: "composer",
    covers: [],
    requires: [],
  },
];
const browserReservedDescriptor: Descriptor = {
  id: "U3.browser",
  owner: "U3",
  title: "Browser-owned shortcut",
  kind: "shortcut",
  chord: "Mod+T",
  scope: "global",
  covers: [],
  requires: [],
};

function keyEvent(key: string, options: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
}

describe("ShortcutRegistry", () => {
  test("normalizes and dispatches a scoped shortcut", () => {
    const registry = new ShortcutRegistry(descriptors);
    const action = vi.fn();
    registry.registerAction("U0.send", action);
    const event = keyEvent("Enter", { ctrlKey: true });

    const result = registry.dispatch(event, "composer");

    expect(result).toMatchObject({ handled: true, binding: { id: "U0.send" } });
    expect(action).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(normalizeChord("Shift+Mod+T")).toBe("mod+shift+t");
  });

  test("does not hijack editable fields", () => {
    const registry = new ShortcutRegistry(descriptors);
    const action = vi.fn();
    registry.registerAction("U0.send", action);
    const input = document.createElement("input");
    document.body.append(input);
    const event = keyEvent("Enter", { ctrlKey: true });
    Object.defineProperty(event, "target", { value: input });

    expect(registry.dispatch(event, "composer")).toEqual({ handled: false });
    expect(action).not.toHaveBeenCalled();
    input.remove();
  });

  test("captures action failures without an unhandled rejection", async () => {
    const registry = new ShortcutRegistry(descriptors);
    const failure = new Error("shortcut action failed");
    registry.registerAction("U0.send", async () => {
      throw failure;
    });

    registry.dispatch(keyEvent("Enter", { ctrlKey: true }), "composer");

    await vi.waitFor(() => expect(registry.lastError()?.error).toBe(failure));
    expect(registry.lastError()).toMatchObject({ binding: { id: "U0.send" } });
    registry.clearError();
    expect(registry.lastError()).toBeUndefined();
  });
  test("reports browser-reserved descriptor defaults", () => {
    const registry = new ShortcutRegistry([...descriptors, browserReservedDescriptor]);

    expect(registry.problems()).toEqual([
      {
        kind: "reserved-chord",
        id: "U3.browser",
        chord: "Mod+T",
        detail: "Your browser keeps Mod+T for itself",
      },
    ]);
  });

  test("keeps Tab and Shift+Tab for focus navigation outside editor fields", () => {
    const registry = new ShortcutRegistry([
      ...descriptors,
      {
        id: "U2.complete",
        owner: "U2",
        title: "Composer completion",
        kind: "shortcut",
        chord: "Tab",
        scope: "composer-input",
        covers: [],
        requires: [],
      },
    ]);

    expect(registry.isBrowserReserved("Shift+Tab")).toBe(true);
    expect(registry.isBrowserReserved("Tab", "composer-input")).toBe(false);
    expect(registry.rebind("U1.toggle", "Shift+Tab")).toMatchObject({
      ok: false,
      error: "Shift+Tab moves keyboard focus in the browser",
    });
    expect(registry.problems()).toEqual([]);
  });

  test("rejects rebinding to a browser-reserved chord", () => {
    const store = new MemoryPreferenceStore();
    const registry = new ShortcutRegistry(descriptors, { preferenceStore: store });
    const result = registry.rebind("U1.toggle", "Mod+T");

    expect(result).toEqual({
      ok: false,
      conflicts: [],
      error: "Your browser keeps Mod+T for itself",
    });
    expect(store.get("omp.app.shortcuts")).toBeUndefined();
    expect(registry.bindings().find((binding) => binding.id === "U1.toggle")?.chord).toBe("Alt+T");
  });

  test("reports conflicts with both owners in one scope", () => {
    const registry = new ShortcutRegistry([
      ...descriptors,
      {
        id: "U2.conflict",
        owner: "U2",
        title: "Conflicting shortcut",
        kind: "shortcut",
        chord: "Mod+Enter",
        scope: "composer",
        covers: [],
        requires: [],
      },
    ]);
    const conflicts = registry.conflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      first: { id: "U0.send", owner: "U0" },
      second: { id: "U2.conflict", owner: "U2" },
    });
  });
  test("does not dispatch an ambiguous shortcut", () => {
    const registry = new ShortcutRegistry([
      ...descriptors,
      {
        id: "U2.conflict",
        owner: "U2",
        title: "Conflicting shortcut",
        kind: "shortcut",
        chord: "Mod+Enter",
        scope: "composer",
        covers: [],
        requires: [],
      },
    ]);
    const action = vi.fn();
    registry.registerAction("U0.send", action);
    const event = keyEvent("Enter", { ctrlKey: true });

    expect(registry.dispatch(event, "composer")).toEqual({ handled: false });
    expect(action).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("persists a successful rebind and resets to the descriptor default", () => {
    const store = new MemoryPreferenceStore();
    const first = new ShortcutRegistry(descriptors, { preferenceStore: store });
    expect(first.rebind("U1.toggle", "Alt+Y").ok).toBe(true);
    expect(first.bindings().find((binding) => binding.id === "U1.toggle")?.chord).toBe("Alt+Y");

    const restored = new ShortcutRegistry(descriptors, { preferenceStore: store });
    expect(restored.bindings().find((binding) => binding.id === "U1.toggle")?.chord).toBe("Alt+Y");
    restored.reset("U1.toggle");
    expect(restored.bindings().find((binding) => binding.id === "U1.toggle")?.chord).toBe("Alt+T");
  });
  test("surfaces malformed stored overrides and clears them on reset all", () => {
    const store = new MemoryPreferenceStore();
    store.set("omp.app.shortcuts", "{");
    const registry = new ShortcutRegistry(descriptors, { preferenceStore: store });

    expect(registry.preferenceError()).toBeDefined();
    registry.resetAll();
    expect(registry.preferenceError()).toBeUndefined();
    expect(store.get("omp.app.shortcuts")).toBeUndefined();
  });
  test("surfaces preference read failures", () => {
    const failure = new Error("preferences unavailable");
    const store = {
      get: () => {
        throw failure;
      },
      set: () => undefined,
      delete: () => undefined,
    };
    const registry = new ShortcutRegistry(descriptors, { preferenceStore: store });

    expect(registry.preferenceError()?.error).toBe(failure);
  });

  test("rejects a conflicting rebind without changing persisted state", () => {
    const store = new MemoryPreferenceStore();
    const registry = new ShortcutRegistry(descriptors, { preferenceStore: store });
    const result = registry.rebind("U0.send", "Mod+Shift+Enter");

    expect(result.ok).toBe(false);
    expect(result.conflicts[0]).toMatchObject({
      first: { id: "U0.send" },
      second: { id: "U2.other" },
    });
    expect(store.get("omp.app.shortcuts")).toBeUndefined();
    expect(registry.bindings().find((binding) => binding.id === "U0.send")?.chord).toBe(
      "Mod+Enter",
    );
  });
});

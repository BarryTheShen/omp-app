import { normalizeChord } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ShortcutRegistry, ShortcutRegistryProvider } from "@/shortcuts";
import { U1ShortcutDescriptors } from "../../registry/shortcuts";
import { TranscriptShortcutScope } from "../../shortcuts";

function keyEvent(key: string, options: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
}

function createActions() {
  return {
    resetDisplay: vi.fn(),
    toggleThinking: vi.fn(),
    toggleToolExpansion: vi.fn(),
    toggleToolVisibility: vi.fn(),
  };
}

afterEach(cleanup);

describe("U1 transcript shortcuts", () => {
  test("claims the four F6 rows with conflict-free, capability-independent bindings", () => {
    expect(
      U1ShortcutDescriptors.map(({ id, chord, scope, covers, requires }) => ({
        id,
        chord,
        scope,
        covers,
        requires,
      })),
    ).toEqual([
      {
        id: "U1.appDisplayReset",
        chord: "Alt+L",
        scope: "transcript",
        covers: ["F6.app-display-reset"],
        requires: [],
      },
      {
        id: "U1.thinking.toggle",
        chord: "Alt+T",
        scope: "transcript",
        covers: ["F6.app-thinking-toggle"],
        requires: [],
      },
      {
        id: "U1.appToolsExpand",
        chord: "Mod+O",
        scope: "transcript",
        covers: ["F6.app-tools-expand"],
        requires: [],
      },
      {
        id: "U1.appToolsToggleVisibility",
        chord: "Mod+Shift+O",
        scope: "transcript",
        covers: ["F6.app-tools-togglevisibility"],
        requires: [],
      },
    ]);
    expect(normalizeChord("Shift+Mod+O")).toBe("mod+shift+o");

    const registry = new ShortcutRegistry(U1ShortcutDescriptors);
    expect(registry.conflicts()).toEqual([]);
    expect(registry.problems()).toEqual([]);
  });

  test("dispatches caller actions through U0 and unregisters them when the transcript unmounts", () => {
    const actions = createActions();
    const view = render(
      <ShortcutRegistryProvider descriptors={U1ShortcutDescriptors}>
        <TranscriptShortcutScope actions={actions}>
          <button type="button">Conversation</button>
        </TranscriptShortcutScope>
      </ShortcutRegistryProvider>,
    );

    const resetDisplay = keyEvent("L", { altKey: true });
    const toggleThinking = keyEvent("T", { altKey: true });
    const toggleToolExpansion = keyEvent("O", { ctrlKey: true });
    const toggleToolVisibility = keyEvent("O", { ctrlKey: true, shiftKey: true });
    window.dispatchEvent(resetDisplay);
    expect(resetDisplay.defaultPrevented).toBe(true);
    window.dispatchEvent(toggleThinking);
    expect(toggleThinking.defaultPrevented).toBe(true);
    window.dispatchEvent(toggleToolExpansion);
    expect(toggleToolExpansion.defaultPrevented).toBe(true);
    window.dispatchEvent(toggleToolVisibility);
    expect(toggleToolVisibility.defaultPrevented).toBe(true);

    expect(actions.resetDisplay).toHaveBeenCalledOnce();
    expect(actions.toggleThinking).toHaveBeenCalledOnce();
    expect(actions.toggleToolExpansion).toHaveBeenCalledOnce();
    expect(actions.toggleToolVisibility).toHaveBeenCalledOnce();
    const globalRegistry = new ShortcutRegistry(U1ShortcutDescriptors);
    const globalAction = keyEvent("L", { altKey: true });
    expect(globalRegistry.dispatch(globalAction, "global")).toEqual({ handled: false });

    view.unmount();
    const afterUnmount = keyEvent("L", { altKey: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
    expect(actions.resetDisplay).toHaveBeenCalledOnce();
  });

  test("does not take transcript chords from the message editor", () => {
    const actions = createActions();
    render(
      <ShortcutRegistryProvider descriptors={U1ShortcutDescriptors}>
        <TranscriptShortcutScope actions={actions}>
          <input aria-label="Message input" />
        </TranscriptShortcutScope>
      </ShortcutRegistryProvider>,
    );

    const event = keyEvent("T", { altKey: true });
    screen.getByRole("textbox", { name: "Message input" }).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(actions.toggleThinking).not.toHaveBeenCalled();
  });
});

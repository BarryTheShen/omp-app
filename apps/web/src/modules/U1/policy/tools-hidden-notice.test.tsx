import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MemoryPreferenceStore,
  SHORTCUT_PREFERENCES_KEY,
  ShortcutRegistryProvider,
} from "@/shortcuts";
import { U1ShortcutDescriptors } from "../registry/shortcuts";
import { TranscriptShortcuts } from "../shortcuts";
import { MemoryThinkingVisibilityStore, TranscriptDisplayPolicyProvider } from "./policy";
import { ToolsHiddenNotice } from "./tools-hidden-notice";

function keyEvent(key: string, options: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
}

function renderNotice(preferenceStore?: MemoryPreferenceStore) {
  return render(
    <ShortcutRegistryProvider descriptors={U1ShortcutDescriptors} preferenceStore={preferenceStore}>
      <TranscriptDisplayPolicyProvider
        storage={new MemoryThinkingVisibilityStore()}
        threadId="thread-tools-hidden"
      >
        <TranscriptShortcuts followLatest={vi.fn()}>
          <ToolsHiddenNotice />
        </TranscriptShortcuts>
      </TranscriptDisplayPolicyProvider>
    </ShortcutRegistryProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolsHiddenNotice", () => {
  test("says nothing while tool activity is shown, and keeps its live region in place for the change", () => {
    const { container } = renderNotice();
    const region = container.querySelector("[data-u1-tools-hidden-notice]");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
  });

  test("after the chord hides tool activity, names the chord, and goes away when it is shown again", () => {
    renderNotice();
    act(() => {
      window.dispatchEvent(keyEvent("O", { ctrlKey: true, shiftKey: true }));
    });
    expect(
      screen.getByText("Tool activity is hidden. Press Ctrl+Shift+O to show it."),
    ).toBeTruthy();
    act(() => {
      window.dispatchEvent(keyEvent("O", { ctrlKey: true, shiftKey: true }));
    });
    expect(screen.queryByText(/Tool activity is hidden/)).toBeNull();
  });

  test("names the chord the person has bound, and the chord it replaced no longer hides tool activity", () => {
    const store = new MemoryPreferenceStore();
    store.set(
      SHORTCUT_PREFERENCES_KEY,
      JSON.stringify({ "U1.appToolsToggleVisibility": "Mod+Shift+J" }),
    );
    renderNotice(store);
    act(() => {
      window.dispatchEvent(keyEvent("O", { ctrlKey: true, shiftKey: true }));
    });
    expect(screen.queryByText(/Tool activity is hidden/)).toBeNull();
    act(() => {
      window.dispatchEvent(keyEvent("J", { ctrlKey: true, shiftKey: true }));
    });
    expect(
      screen.getByText("Tool activity is hidden. Press Ctrl+Shift+J to show it."),
    ).toBeTruthy();
  });

  test("names the chord with Cmd on an Apple platform", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    );
    renderNotice();
    act(() => {
      window.dispatchEvent(keyEvent("O", { metaKey: true, shiftKey: true }));
    });
    expect(screen.getByText("Tool activity is hidden. Press Cmd+Shift+O to show it.")).toBeTruthy();
  });
});

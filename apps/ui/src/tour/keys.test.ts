import { describe, expect, test } from "vitest";
import { matchesHotkey } from "./keys";

type Held = "ctrl" | "meta" | "alt" | "shift";

/** A key event as `matchesHotkey` reads one: the key's code and which modifiers are down. */
function press(code: string, ...held: readonly Held[]): KeyboardEvent {
  return {
    code,
    ctrlKey: held.includes("ctrl"),
    metaKey: held.includes("meta"),
    altKey: held.includes("alt"),
    shiftKey: held.includes("shift"),
  } as KeyboardEvent;
}

describe("matchesHotkey", () => {
  test("a key with its modifiers, whatever the order they are listed in", () => {
    expect(matchesHotkey(press("KeyO", "ctrl", "shift"), "ctrl+shift+o")).toBe(true);
    expect(matchesHotkey(press("KeyO", "shift", "ctrl"), "shift+ctrl+o")).toBe(true);
    expect(matchesHotkey(press("Tab", "shift"), "shift+tab")).toBe(true);
    expect(matchesHotkey(press("KeyP", "alt", "shift"), "alt+shift+p")).toBe(true);
    expect(matchesHotkey(press("KeyT", "ctrl", "shift", "alt"), "ctrl+shift+alt+t")).toBe(true);
  });

  test("any alternative of a binding", () => {
    const cycle = "meta+ctrl+bracketleft, meta+ctrl+bracketright";
    expect(matchesHotkey(press("BracketLeft", "meta", "ctrl"), cycle)).toBe(true);
    expect(matchesHotkey(press("BracketRight", "meta", "ctrl"), cycle)).toBe(true);
    const keys = "ctrl+slash, meta+slash";
    expect(matchesHotkey(press("Slash", "ctrl"), keys)).toBe(true);
    expect(matchesHotkey(press("Slash", "meta"), keys)).toBe(true);
  });

  test("refuses a key with a modifier more than the binding lists", () => {
    expect(matchesHotkey(press("KeyO", "ctrl", "shift", "alt"), "ctrl+shift+o")).toBe(false);
    expect(matchesHotkey(press("Tab", "ctrl", "shift"), "shift+tab")).toBe(false);
    expect(matchesHotkey(press("Slash", "ctrl", "meta"), "ctrl+slash, meta+slash")).toBe(false);
  });

  test("refuses a key with a modifier fewer than the binding lists", () => {
    expect(matchesHotkey(press("KeyO", "ctrl"), "ctrl+shift+o")).toBe(false);
    expect(matchesHotkey(press("KeyP", "alt"), "alt+shift+p")).toBe(false);
    expect(matchesHotkey(press("KeyT", "ctrl", "shift"), "ctrl+shift+alt+t")).toBe(false);
    expect(matchesHotkey(press("BracketLeft", "meta"), "meta+ctrl+bracketleft")).toBe(false);
  });

  test("refuses a different key", () => {
    expect(matchesHotkey(press("KeyE", "ctrl", "shift"), "ctrl+shift+o")).toBe(false);
    expect(matchesHotkey(press("Enter", "shift"), "shift+tab")).toBe(false);
    expect(matchesHotkey(press("BracketLeft", "meta", "ctrl"), "meta+ctrl+bracketright")).toBe(
      false,
    );
  });
});

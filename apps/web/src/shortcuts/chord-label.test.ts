import { describe, expect, test } from "vitest";
import { chordHasKey, chordLabel, isApplePlatform, storedChord } from "./chord-label";

const MAC = { mac: true } as const;
const OTHER = { mac: false } as const;

describe("chordLabel", () => {
  test.each([
    ["Mod+Shift+H", "Cmd+Shift+H", "Ctrl+Shift+H"],
    ["Mod+K", "Cmd+K", "Ctrl+K"],
    ["Mod+Enter", "Cmd+Enter", "Ctrl+Enter"],
    ["Mod+?", "Cmd+?", "Ctrl+?"],
    ["Mod+Shift+Enter", "Cmd+Shift+Enter", "Ctrl+Shift+Enter"],
    ["Alt+T", "Option+T", "Alt+T"],
    ["Alt+Shift+L", "Option+Shift+L", "Alt+Shift+L"],
    ["Ctrl+B", "Ctrl+B", "Ctrl+B"],
    ["Meta+B", "Cmd+B", "Meta+B"],
    ["Shift+Tab", "Shift+Tab", "Shift+Tab"],
    ["Alt+ArrowUp", "Option+↑", "Alt+↑"],
    ["Mod+ArrowLeft", "Cmd+←", "Ctrl+←"],
    ["Alt+Down", "Option+↓", "Alt+↓"],
    ["Esc", "Esc", "Esc"],
    ["Space", "Space", "Space"],
    ["Mod+K Mod+C", "Cmd+K Cmd+C", "Ctrl+K Ctrl+C"],
  ])("%s reads as %s on a Mac and as %s elsewhere", (chord, onMac, elsewhere) => {
    expect(chordLabel(chord, MAC)).toBe(onMac);
    expect(chordLabel(chord, OTHER)).toBe(elsewhere);
  });

  test("a chord with a single key keeps the key as the stored chord names it", () => {
    expect(chordLabel("F5", OTHER)).toBe("F5");
    expect(chordLabel("Mod+F5", MAC)).toBe("Cmd+F5");
  });
});

describe("isApplePlatform", () => {
  test.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", true],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15", true],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)", false],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", false],
  ])("reads %s as Apple: %s", (userAgent, expected) => {
    expect(isApplePlatform(userAgent)).toBe(expected);
  });
});

describe("storedChord", () => {
  test.each([
    ["Ctrl+Shift+J", "Mod+Shift+J"],
    ["Cmd+Shift+J", "Mod+Shift+J"],
    ["ctrl+shift+j", "Mod+Shift+J"],
    ["Option+T", "Alt+T"],
    ["Alt+↑", "Alt+ArrowUp"],
    ["Ctrl+←", "Mod+ArrowLeft"],
    ["Escape", "Esc"],
    ["Mod+Shift+Enter", "Mod+Shift+Enter"],
    ["Mod+K Mod+C", "Mod+K Mod+C"],
    ["Control+Shift+L", "Mod+Shift+L"],
    ["Meta+Shift+M", "Mod+Shift+M"],
    ["Command+K", "Mod+K"],
    ["Control+K", "Mod+K"],
    ["Win+K", "Mod+K"],
    ["Windows+K", "Mod+K"],
    ["Super+K", "Mod+K"],
    ["Ctrl+Cmd+K", "Mod+K"],
    ["Shift+Ctrl+K", "Mod+Shift+K"],
    ["Shift+Option+K", "Alt+Shift+K"],
    ["Alt+Ctrl+K", "Mod+Alt+K"],
  ])("%s is stored as %s", (typed, stored) => {
    expect(storedChord(typed)).toBe(stored);
  });
});

describe("chordHasKey", () => {
  test.each(["Ctrl", "Ctrl+Shift", "Ctrl+Shift+", "Ctrl++", "Shift+Meta", "Ctrl+K Ctrl", ""])(
    "%j has no key, so the sheet refuses it",
    (typed) => {
      expect(chordHasKey(storedChord(typed))).toBe(false);
    },
  );
  test.each(["Ctrl+K", "Ctrl+Shift+Enter", "F5", "Alt+ArrowUp", "Esc", "Mod+K Mod+C"])(
    "%s has a key",
    (typed) => {
      expect(chordHasKey(storedChord(typed))).toBe(true);
    },
  );
});

describe("the chord the field shows is the chord it stores again", () => {
  const stored = [
    "Mod+Shift+H",
    "Mod+Enter",
    "Alt+T",
    "Shift+Tab",
    "Alt+ArrowUp",
    "Mod+ArrowLeft",
    "Esc",
    "Space",
    "Mod+K Mod+C",
    "Mod+Shift+Enter",
    "F5",
    "PageDown",
  ];
  test.each(stored)("%s on a Mac", (chord) => {
    expect(storedChord(chordLabel(chord, MAC))).toBe(chord);
  });
  test.each(stored)("%s on other systems", (chord) => {
    expect(storedChord(chordLabel(chord, OTHER))).toBe(chord);
  });
});

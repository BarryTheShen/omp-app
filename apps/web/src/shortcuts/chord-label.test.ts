import { describe, expect, test } from "vitest";
import { chordLabel, isApplePlatform } from "./chord-label";

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

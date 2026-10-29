import { describe, expect, test } from "vitest";
import { BINDINGS, collisions, keycap, normalize } from "./table";

describe("the app's keys", () => {
  test("no two bindings that act at once share a key", () => {
    expect(collisions(BINDINGS)).toEqual([]);
  });

  test("a collision is found across scopes that act together, not between ones that never do", () => {
    const tab = {
      id: "tab",
      hotkey: "ctrl+shift+t",
      scope: "workspace",
      group: "Tabs",
      label: "",
    } as const;
    const thinking = {
      id: "thinking",
      hotkey: "shift+ctrl+t",
      scope: "box",
      group: "Message box",
      label: "",
    } as const;
    expect(collisions([tab, thinking])).toEqual(["tab and thinking: ctrl+shift+t"]);
    const fold = {
      id: "fold",
      hotkey: "ctrl+o",
      scope: "pane",
      group: "Transcript",
      label: "",
    } as const;
    const send = {
      id: "send",
      hotkey: "enter",
      scope: "box",
      group: "Message box",
      label: "",
    } as const;
    expect(collisions([fold, send])).toEqual([]);
  });

  test("keys compare by their modifiers whatever the order, and read as keycaps", () => {
    expect(normalize("Shift+Ctrl+O")).toBe(normalize("ctrl+shift+o"));
    expect(normalize("up")).toBe("arrowup");
    expect(keycap({ hotkey: "ctrl+shift+o" })).toBe("Ctrl+Shift+O");
    expect(keycap({ hotkey: "meta+ctrl+bracketleft, meta+ctrl+bracketright" })).toBe(
      "Super+Ctrl+[",
    );
  });
});

import { describe, expect, test } from "vitest";
import { BINDINGS, collisions, keycap, normalize, withCommand } from "./table";

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

  test("on an Apple device each Ctrl chord is also a ⌘ chord, and no two keys collide then either (#2775)", () => {
    expect(withCommand("ctrl+shift+o")).toBe("ctrl+shift+o, meta+shift+o");
    expect(withCommand("ctrl+tab, ctrl+shift+right")).toBe(
      "ctrl+tab, ctrl+shift+right, meta+tab, meta+shift+right",
    );
    // The pane keys hold Super (⌘) already, and a key listed with ⌘ is not listed twice.
    expect(withCommand("meta+ctrl+left, meta+ctrl+right")).toBe("meta+ctrl+left, meta+ctrl+right");
    expect(withCommand("ctrl+k, meta+k")).toBe("ctrl+k, meta+k");
    expect(withCommand("alt+p")).toBe("alt+p");
    const apple = BINDINGS.map((binding) => ({ ...binding, hotkey: withCommand(binding.hotkey) }));
    expect(collisions(apple)).toEqual([]);
  });

  test("on an Apple device a keycap shows the ⌘ chord in Apple's signs", () => {
    expect(keycap({ hotkey: withCommand("ctrl+shift+o") }, true)).toBe("⌘⇧O");
    expect(keycap({ hotkey: "meta+ctrl+bracketleft, meta+ctrl+bracketright" }, true)).toBe("⌘⌃[");
    expect(keycap({ hotkey: "alt+p" }, true)).toBe("⌥P");
    expect(keycap({ hotkey: withCommand("ctrl+enter") }, true)).toBe("⌘↩");
  });
});

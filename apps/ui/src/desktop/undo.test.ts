import { describe, expect, test, vi } from "vitest";
import { runUndoKeys, type UndoTarget } from "./undo";

/** A window with one key listener, whose document records the editing commands it is asked to run. */
function fakeWindow() {
  let listener: ((event: KeyboardEvent) => void) | null = null;
  const execCommand = vi.fn((_command: string) => true);
  const target: UndoTarget = {
    addEventListener: (_type, added) => {
      listener = added;
    },
    removeEventListener: (_type, removed) => {
      if (listener === removed) listener = null;
    },
    document: { execCommand },
  };
  runUndoKeys(target);
  /** Presses `key` in `field`; whether the page took the key (its default prevented). */
  const press = (
    key: string,
    field: object,
    held: Partial<KeyboardEvent> = {},
    handled = false,
  ) => {
    const preventDefault = vi.fn();
    listener?.({
      key,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      defaultPrevented: handled,
      target: field,
      preventDefault,
      ...held,
    } as unknown as KeyboardEvent);
    return preventDefault.mock.calls.length > 0;
  };
  return { execCommand, press };
}

const textarea = { tagName: "TEXTAREA" };

describe("the desktop window's undo and redo keys (#2792)", () => {
  test("Ctrl+Z undoes, and Ctrl+Shift+Z or Ctrl+Y redo, in a text area, a text input and an edited element", () => {
    const { execCommand, press } = fakeWindow();
    expect(press("z", textarea)).toBe(true);
    expect(press("Z", { tagName: "INPUT", type: "search" }, { shiftKey: true })).toBe(true);
    expect(press("y", { tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(execCommand.mock.calls.map(([command]) => command)).toEqual(["undo", "redo", "redo"]);
  });

  test("a key the page took first, one outside a text field, or another combination is left alone", () => {
    const { execCommand, press } = fakeWindow();
    expect(press("z", textarea, {}, true)).toBe(false);
    expect(press("z", { tagName: "BUTTON" })).toBe(false);
    expect(press("z", { tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(press("z", textarea, { ctrlKey: false })).toBe(false);
    expect(press("z", textarea, { altKey: true })).toBe(false);
    expect(press("y", textarea, { shiftKey: true })).toBe(false);
    expect(press("z", textarea, { isComposing: true })).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });
});

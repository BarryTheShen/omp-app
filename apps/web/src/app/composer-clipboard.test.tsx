import { afterEach, describe, expect, test, vi } from "vitest";
import { U2Descriptors } from "@/modules/U2/descriptors/descriptors";
import { MemoryPreferenceStore, ShortcutRegistry } from "@/shortcuts/registry";
import { registerComposerClipboardShortcuts } from "./composer-clipboard";

afterEach(() => {
  document.body.innerHTML = "";
});

/** The composer's textarea, focused, with the caret (or selection) set. */
function draft(value: string, start: number, end = start): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.setAttribute("aria-label", "Message input");
  document.body.append(textarea);
  textarea.value = value;
  textarea.setSelectionRange(start, end);
  textarea.focus();
  return textarea;
}

/** A key press on the textarea, as the registry's global listener sees it. */
function press(textarea: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  textarea.dispatchEvent(event);
  return event;
}

function clipboard(read = "pasted text", writeError: Error | null = null) {
  const writeText = vi.fn(async (_text: string) => {
    if (writeError !== null) throw writeError;
  });
  const readText = vi.fn(async () => read);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText, readText },
    configurable: true,
  });
  return { writeText, readText };
}

function setup() {
  const registry = new ShortcutRegistry(U2Descriptors, {
    preferenceStore: new MemoryPreferenceStore(),
  });
  const notify = vi.fn();
  const fail = vi.fn();
  const dispose = registerComposerClipboardShortcuts({ registry, notify, fail });
  return { registry, notify, fail, dispose };
}

describe("composer clipboard shortcuts", () => {
  test("Alt+Shift+L copies the line the caret is on", async () => {
    const { writeText } = clipboard();
    const { registry, notify } = setup();
    const textarea = draft("first line\nsecond line", 15);
    const event = press(textarea, { key: "L", altKey: true, shiftKey: true });
    expect(registry.dispatch(event, "global").handled).toBe(true);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("second line"));
    expect(notify).toHaveBeenCalledWith("Copied the current line.");
  });

  test("Alt+Shift+C copies the whole prompt", async () => {
    const { writeText } = clipboard();
    const { registry, notify } = setup();
    const textarea = draft("first line\nsecond line", 2);
    const event = press(textarea, { key: "C", altKey: true, shiftKey: true });
    expect(registry.dispatch(event, "global").handled).toBe(true);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("first line\nsecond line"));
    expect(notify).toHaveBeenCalledWith("Copied the prompt.");
  });

  test("Alt+Shift+V and Ctrl+Shift+V paste the clipboard text in place of the selection, without formatting", async () => {
    const { readText } = clipboard("pasted text");
    const { registry } = setup();
    const textarea = draft("ab", 1);
    const input = vi.fn();
    textarea.addEventListener("input", input);
    const alt = press(textarea, { key: "V", altKey: true, shiftKey: true });
    expect(registry.dispatch(alt, "global").handled).toBe(true);
    await vi.waitFor(() => expect(textarea.value).toBe("apasted textb"));
    expect(input).toHaveBeenCalledTimes(1);
    textarea.setSelectionRange(0, 0);
    const ctrl = press(textarea, { key: "V", ctrlKey: true, shiftKey: true });
    expect(registry.dispatch(ctrl, "global").handled).toBe(true);
    await vi.waitFor(() => expect(textarea.value).toBe("pasted textapasted textb"));
    expect(readText).toHaveBeenCalledTimes(2);
  });

  test("the copy keys do nothing while the composer is not focused", () => {
    const { writeText } = clipboard();
    const { registry, notify } = setup();
    const textarea = draft("first line", 3);
    textarea.blur();
    const event = press(textarea, { key: "L", altKey: true, shiftKey: true });
    registry.dispatch(event, "global");
    expect(writeText).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test("copying an empty line says there is nothing to copy and writes nothing", () => {
    const { writeText } = clipboard();
    const { registry, notify } = setup();
    const textarea = draft("", 0);
    registry.dispatch(press(textarea, { key: "L", altKey: true, shiftKey: true }), "global");
    expect(writeText).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("There is nothing to copy.");
  });

  test("a refused clipboard write is reported in plain English", async () => {
    clipboard("", new Error("denied"));
    const { registry, fail, notify } = setup();
    const textarea = draft("prompt", 0);
    registry.dispatch(press(textarea, { key: "C", altKey: true, shiftKey: true }), "global");
    await vi.waitFor(() =>
      expect(fail).toHaveBeenCalledWith("The browser would not write to the clipboard."),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  test("disposing removes the actions, so the chords no longer run", () => {
    clipboard();
    const { registry, dispose, notify } = setup();
    dispose();
    const textarea = draft("prompt", 0);
    const result = registry.dispatch(
      press(textarea, { key: "C", altKey: true, shiftKey: true }),
      "global",
    );
    expect(result.handled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});

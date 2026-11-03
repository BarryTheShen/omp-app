/**
 * Undo and redo in the desktop window's text fields (#2792). WebKitGTK maps no key to Undo or Redo (its GTK key bindings
 * have none, WebKit's `KeyBindingTranslator.cpp`), and Tauri adds the Edit menu that would map them on macOS only
 * (tauri-apps/tauri#16299): Ctrl+Z did nothing in the message box, though the field keeps its undo history. So the page
 * runs the command itself. A browser maps these keys on its own, so this runs in the window only.
 */

/** Inputs that take typed text: undo and redo act in these, as in a text area. */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** What a key event's target tells: its tag, an input's type, and whether it is edited in place. */
interface Field {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
}

function isTextField(target: EventTarget | null): boolean {
  const field = target as Field | null;
  if (field === null) return false;
  if (field.tagName === "TEXTAREA" || field.isContentEditable === true) return true;
  return field.tagName === "INPUT" && TEXT_INPUTS.has(field.type ?? "text");
}

/** The editing command a key asks for: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo; null for any other key. */
export function editingCommand(
  key: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): "undo" | "redo" | null {
  if (!key.ctrlKey || key.altKey || key.metaKey) return null;
  const name = key.key.toLowerCase();
  if (name === "z") return key.shiftKey ? "redo" : "undo";
  return name === "y" && !key.shiftKey ? "redo" : null;
}

/** The window the keys run in: its key events, and its document's editing commands. */
export interface UndoTarget {
  addEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
  readonly document: { execCommand(command: string): boolean };
}

/**
 * Runs undo and redo in the window's text fields, for a key nothing in the page handled first (an editor with its own
 * undo keeps it). Returns the function that stops it.
 */
export function runUndoKeys(target: UndoTarget = window): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || !isTextField(event.target)) return;
    const command = editingCommand(event);
    if (command === null) return;
    event.preventDefault();
    target.document.execCommand(command);
  };
  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}

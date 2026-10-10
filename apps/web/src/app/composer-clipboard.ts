import { useEffect } from "react";
import { executePromptAction } from "@/modules/D2/mentions";
import { useShortcutRegistry } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";
import { composerInput } from "./composer-input";

/** U2's clipboard rows: omp's copy-line, copy-prompt and paste-as-text chords, all acting on the draft. */
export const COMPOSER_CLIPBOARD_SHORTCUTS = {
  copyLine: "U2.clipboardCopyLine",
  copyPrompt: "U2.clipboardCopyPrompt",
  pasteTextRaw: "U2.clipboardPasteTextRaw",
  pasteTextRawAlt: "U2.clipboardPasteTextRawAlt",
} as const;

export interface ComposerClipboardOptions {
  readonly registry: ShortcutRegistry;
  /** Says what was copied, in plain English. */
  readonly notify: (message: string) => void;
  /** Says why the browser refused the clipboard, in plain English. */
  readonly fail: (message: string) => void;
}

/** The draft's textarea, only while it has focus: these keys act on the text being typed. */
function focusedDraft(): HTMLTextAreaElement | null {
  const input = composerInput();
  return input instanceof HTMLTextAreaElement && document.activeElement === input ? input : null;
}

/** Registers the four actions; the returned function removes them. */
export function registerComposerClipboardShortcuts({
  registry,
  notify,
  fail,
}: ComposerClipboardOptions): () => void {
  const copy =
    (action: "copy-current-line" | "copy-prompt", done: string) => async (): Promise<void> => {
      const draft = focusedDraft();
      if (draft === null) return;
      const { copyText } = executePromptAction(action, draft.value, draft.selectionStart);
      if (!copyText) {
        notify("There is nothing to copy.");
        return;
      }
      try {
        await navigator.clipboard.writeText(copyText);
        notify(done);
      } catch {
        fail("The browser would not write to the clipboard.");
      }
    };
  const pasteAsText = async (): Promise<void> => {
    const draft = focusedDraft();
    if (draft === null) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      fail("The browser would not read the clipboard.");
      return;
    }
    // Replaces the selection with the plain text, then tells React the draft changed.
    draft.setRangeText(text, draft.selectionStart, draft.selectionEnd, "end");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const disposers = [
    registry.registerAction(
      COMPOSER_CLIPBOARD_SHORTCUTS.copyLine,
      copy("copy-current-line", "Copied the current line."),
    ),
    registry.registerAction(
      COMPOSER_CLIPBOARD_SHORTCUTS.copyPrompt,
      copy("copy-prompt", "Copied the prompt."),
    ),
    registry.registerAction(COMPOSER_CLIPBOARD_SHORTCUTS.pasteTextRaw, pasteAsText),
    registry.registerAction(COMPOSER_CLIPBOARD_SHORTCUTS.pasteTextRawAlt, pasteAsText),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Keeps the composer's clipboard actions registered while the open chat is mounted. */
export function useComposerClipboardShortcuts(
  options: Omit<ComposerClipboardOptions, "registry">,
): void {
  const registry = useShortcutRegistry();
  const { notify, fail } = options;
  useEffect(
    () => registerComposerClipboardShortcuts({ registry, notify, fail }),
    [fail, notify, registry],
  );
}

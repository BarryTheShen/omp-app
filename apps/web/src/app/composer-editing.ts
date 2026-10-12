import { useEffect } from "react";
import { useShortcutRegistry } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";
import { focusedComposerInput } from "./composer-input";

/** The U2 descriptor ids of the two editing keys this file answers. */
export const COMPOSER_EDITING_SHORTCUTS = {
  deleteToLineStart: "U2.deleteToLineStart",
  yank: "U2.yank",
} as const;

/** What the two keys say, in plain English. */
export const COMPOSER_EDITING_MESSAGES = {
  nothingToYank: "Nothing to put back yet.",
} as const;

/** The stretch of text one delete removes: `value.slice(start, end)`. */
export interface DeleteRange {
  readonly start: number;
  readonly end: number;
  readonly deleted: string;
}

/**
 * The text Ctrl+U removes: from the start of the caret's line up to the caret (omp's deleteToLineStart). At the start
 * of a line it removes the line break before the caret, which joins the line above. Null when the caret is at the very
 * start of the text.
 */
export function deleteToLineStartRange(value: string, caret: number): DeleteRange | null {
  const lineStart = value.slice(0, caret).lastIndexOf("\n") + 1;
  if (caret > lineStart)
    return { start: lineStart, end: caret, deleted: value.slice(lineStart, caret) };
  if (caret > 0) return { start: caret - 1, end: caret, deleted: "\n" };
  return null;
}

/**
 * The kill ring holds the last deleted text, which Ctrl+Y puts back. Deletes made one after another add up into one
 * entry, and a backward delete goes in front of what is there, as in omp.
 */
export function accumulateKill(ring: string, deleted: string, consecutive: boolean): string {
  return consecutive ? deleted + ring : deleted;
}

/** The kill ring, and the message box as it was right after the last delete, so a delete that follows can add up. */
const kills: {
  ring: string;
  afterLastDelete: { readonly value: string; readonly caret: number } | null;
} = { ring: "", afterLastDelete: null };

function deleteToLineStart(): void {
  const draft = focusedComposerInput();
  if (draft === null) return;
  const caret = draft.selectionEnd;
  const range = deleteToLineStartRange(draft.value, caret);
  if (range === null) return;
  const last = kills.afterLastDelete;
  const consecutive = last !== null && last.value === draft.value && last.caret === caret;
  kills.ring = accumulateKill(kills.ring, range.deleted, consecutive);
  draft.setRangeText("", range.start, range.end, "end");
  kills.afterLastDelete = { value: draft.value, caret: draft.selectionEnd };
  draft.dispatchEvent(new Event("input", { bubbles: true }));
}

function yank(notify: (message: string) => void): void {
  const draft = focusedComposerInput();
  if (draft === null) return;
  if (kills.ring === "") {
    notify(COMPOSER_EDITING_MESSAGES.nothingToYank);
    return;
  }
  draft.setRangeText(kills.ring, draft.selectionStart, draft.selectionEnd, "end");
  kills.afterLastDelete = null;
  draft.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Registers Ctrl+U and Ctrl+Y; the returned function removes them. */
export function registerComposerEditingShortcuts(
  registry: ShortcutRegistry,
  options: { readonly notify: (message: string) => void },
): () => void {
  const disposers = [
    registry.registerAction(COMPOSER_EDITING_SHORTCUTS.deleteToLineStart, deleteToLineStart),
    registry.registerAction(COMPOSER_EDITING_SHORTCUTS.yank, () => yank(options.notify)),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * Keeps Ctrl+U and Ctrl+Y registered while the open chat is mounted. Their chords act only while the message box has
 * focus (their descriptors say so), and their composer scope is listened to by the Alt+Up hook in the same component,
 * so this hook does not mount it again.
 */
export function useComposerEditingShortcuts(options: {
  readonly notify: (message: string) => void;
}): void {
  const registry = useShortcutRegistry();
  const { notify } = options;
  useEffect(() => registerComposerEditingShortcuts(registry, { notify }), [notify, registry]);
}

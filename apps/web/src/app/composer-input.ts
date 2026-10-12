/**
 * The chat's composer text box. A dialog that a palette command opens returns focus here when it closes,
 * because the palette has already closed (and taken its own return point with it) by then.
 */
export function composerInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>('textarea[aria-label="Message input"]');
}

/** The message box itself, only while it has focus: the keys that act on the text being typed check this first. */
export function focusedComposerInput(): HTMLTextAreaElement | null {
  const input = composerInput();
  return input instanceof HTMLTextAreaElement && document.activeElement === input ? input : null;
}

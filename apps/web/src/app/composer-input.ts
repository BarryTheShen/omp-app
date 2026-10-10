/**
 * The chat's composer text box. A dialog that a palette command opens returns focus here when it closes,
 * because the palette has already closed (and taken its own return point with it) by then.
 */
export function composerInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>('textarea[aria-label="Message input"]');
}

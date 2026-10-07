export interface MessageScrollAnchor {
  readonly row: HTMLElement;
  /** The row's distance from the viewport's top edge when it was captured. */
  readonly offset: number;
  /** The viewport's scroll position when it was captured. */
  readonly scrollTop: number;
}

export function captureVisibleMessageAnchor(viewport: HTMLElement): MessageScrollAnchor | null {
  const viewportBounds = viewport.getBoundingClientRect();
  if (viewportBounds.width === 0 || typeof document.elementFromPoint !== "function") return null;

  const target = document.elementFromPoint(
    viewportBounds.left + viewportBounds.width / 2,
    viewportBounds.top + viewportBounds.height * 0.05,
  );
  const row = target?.closest("[data-message-id]");
  // Skip misses instead of scanning descendants: a turn can hold thousands of parts.
  if (!(row instanceof HTMLElement) || !viewport.contains(row)) return null;
  return {
    row,
    offset: row.getBoundingClientRect().top - viewportBounds.top,
    scrollTop: viewport.scrollTop,
  };
}

/**
 * Moves the viewport back by whatever the layout shifted the anchored row, and by nothing else: the
 * reader's own scrolling since the capture (a wheel, a drag, an animated jump to the latest message)
 * moved the row too, and undoing that would fight the reader.
 */
export function retainVisibleMessageAnchor(
  viewport: HTMLElement,
  anchor: MessageScrollAnchor | null,
): void {
  if (anchor === null || !anchor.row.isConnected || !viewport.contains(anchor.row)) return;
  const offset = anchor.row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  const scrolledSince = viewport.scrollTop - anchor.scrollTop;
  const adjustment = Math.round(offset - (anchor.offset - scrolledSince));
  if (adjustment !== 0) viewport.scrollTop += adjustment;
}

export interface MessageScrollAnchor {
  readonly row: HTMLElement;
  /** The row's distance from the viewport's top edge when it was captured. */
  readonly offset: number;
  /** The viewport's scroll position when it was captured. */
  readonly scrollTop: number;
}

/** Where the view is probed for a message row, as fractions of its height: where the reader is first, the top edge after. */
const PROBE_FRACTIONS = [0.5, 0.05] as const;

/**
 * The reader's place per viewport: the row the reader is on, kept across the layout changes the reader did not make. Every
 * retain records the place it kept, so the scroll controller and the paging restore share one place (issue 1165).
 */
const readerPlaces = new WeakMap<HTMLElement, MessageScrollAnchor>();
/** The scroll position the last retain set, per viewport: a scroll to exactly that position is the app's move. */
const retainedScrolls = new WeakMap<HTMLElement, number>();
/** Input that is the reader steering: a held place is theirs from then on. */
const READER_STEERING = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function anchorOn(
  viewport: HTMLElement,
  row: HTMLElement,
  viewportTop: number,
): MessageScrollAnchor {
  return {
    row,
    offset: row.getBoundingClientRect().top - viewportTop,
    scrollTop: viewport.scrollTop,
  };
}

/** The row is still drawn inside the viewport. */
function isInViewport(viewport: HTMLElement, row: HTMLElement): boolean {
  return row.isConnected && viewport.contains(row);
}

/** The row is drawn at least partly inside the viewport's visible box. */
function isOnScreen(viewport: HTMLElement, row: HTMLElement): boolean {
  const view = viewport.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  return bounds.bottom > view.top && bounds.top < view.bottom;
}

export function captureVisibleMessageAnchor(viewport: HTMLElement): MessageScrollAnchor | null {
  const viewportBounds = viewport.getBoundingClientRect();
  if (viewportBounds.width === 0 || typeof document.elementFromPoint !== "function") return null;

  // The middle of the view is where the reader is: a change between the top edge and it moves the reader's row, so
  // the middle is probed first. The top edge is the fallback (a control can sit in the middle of a short transcript).
  for (const fraction of PROBE_FRACTIONS) {
    const target = document.elementFromPoint(
      viewportBounds.left + viewportBounds.width / 2,
      viewportBounds.top + viewportBounds.height * fraction,
    );
    const row = target?.closest("[data-message-id]");
    // Skip misses instead of scanning descendants: a turn can hold thousands of parts.
    if (row instanceof HTMLElement && viewport.contains(row)) {
      return anchorOn(viewport, row, viewportBounds.top);
    }
  }
  // Neither probe lands on a row: a short newest message at the top of a mostly empty view. The first row that reaches
  // into the view is then the place. Rows are in order, so the scan stops at the first one below the view.
  for (const row of viewport.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom <= viewportBounds.top) continue;
    if (bounds.top >= viewportBounds.bottom) break;
    return anchorOn(viewport, row, viewportBounds.top);
  }
  return null;
}

/** Records the place the reader is on; null forgets it. */
export function rememberReaderPlace(
  viewport: HTMLElement,
  anchor: MessageScrollAnchor | null,
): void {
  if (anchor === null) readerPlaces.delete(viewport);
  else readerPlaces.set(viewport, anchor);
}

/**
 * Moves the viewport back by whatever the layout shifted the anchored row, and by nothing else: the reader's own scrolling
 * since the capture (a wheel, a drag, an animated jump to the latest message) moved the row too, and undoing that would
 * fight the reader. The place then keeps the row and the offset it was given, even when the scroll fell short (at the top
 * of the chat a scroll cannot go above zero), so the next layout change restores that place and not the short one.
 */
export function retainVisibleMessageAnchor(
  viewport: HTMLElement,
  anchor: MessageScrollAnchor | null,
): void {
  if (anchor === null || !isInViewport(viewport, anchor.row)) return;
  const offset = anchor.row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  const scrolledSince = viewport.scrollTop - anchor.scrollTop;
  const adjustment = Math.round(offset - (anchor.offset - scrolledSince));
  if (adjustment !== 0) {
    viewport.scrollTop += adjustment;
    retainedScrolls.set(viewport, viewport.scrollTop);
  }
  readerPlaces.set(viewport, { ...anchor, scrollTop: viewport.scrollTop });
}

/**
 * Keeps the reader's place where it is after a layout change. When the row of the place has left the transcript, the row
 * now at the reader's place becomes the place (issue 1165).
 *
 * A jump the reader made (the Home key, a drag of the scroll bar) can move the view off the place before the browser's
 * scroll event for it is handled. The layout change that follows would then be retained against a place the reader is no
 * longer on, and the view would snap back to it. Once the view has moved off the place, the place is taken again where the
 * reader is. A held place is left alone: the app keeps it wherever the browser scrolls.
 */
export function keepReaderPlace(viewport: HTMLElement): void {
  const place = readerPlaces.get(viewport);
  const readerLeftPlace =
    place !== undefined &&
    !isHoldingPlace(viewport) &&
    viewport.scrollTop !== place.scrollTop &&
    !isOnScreen(viewport, place.row);
  if (place === undefined || readerLeftPlace || !isInViewport(viewport, place.row)) {
    rememberReaderPlace(viewport, captureVisibleMessageAnchor(viewport));
    return;
  }
  retainVisibleMessageAnchor(viewport, place);
}

/**
 * True when the scroll is the one a retain just made: the app's move, not the reader's. The scroll that reports it consumes
 * the mark, so a later scroll to the same position is the reader's. A scroll to another position leaves the mark alone, so
 * the retain's own scroll is still recognised when its event comes after an unrelated one.
 */
export function takeRetainedScroll(viewport: HTMLElement): boolean {
  if (retainedScrolls.get(viewport) !== viewport.scrollTop) return false;
  retainedScrolls.delete(viewport);
  return true;
}

/** The reader steered: the next scroll is theirs, even one that lands on a retained position. */
export function forgetRetainedScroll(viewport: HTMLElement): void {
  retainedScrolls.delete(viewport);
}

/**
 * A claim is open from the call that takes it until the release that call returns, which works once. Claims on a viewport
 * count up while open, and the entry is removed when the last one is released.
 */
function takeClaim(claims: WeakMap<HTMLElement, number>, viewport: HTMLElement): () => void {
  claims.set(viewport, (claims.get(viewport) ?? 0) + 1);
  let open = true;
  return (): void => {
    if (!open) return;
    open = false;
    const left = (claims.get(viewport) ?? 1) - 1;
    if (left > 0) claims.set(viewport, left);
    else claims.delete(viewport);
  };
}

/** Open claims on the browser's scroll anchoring, per viewport. */
const anchoringClaims = new WeakMap<HTMLElement, number>();

/** Open holds, per viewport: the scrolls the app did not make are put back while any is open. */
const openHolds = new WeakMap<HTMLElement, number>();

/**
 * The app does the scroll anchoring for the viewport while a claim is open: the browser's own would move the transcript during
 * the layout a held change makes, and the app would then take that move for the reader's (issue 1165). Claims nest, and the
 * browser's anchoring returns when the last one is released. The returned function releases this claim; calling it again does nothing.
 */
export function claimOwnAnchoring(viewport: HTMLElement): () => void {
  const release = takeClaim(anchoringClaims, viewport);
  viewport.style.overflowAnchor = "none";
  return (): void => {
    release();
    if (!anchoringClaims.has(viewport)) viewport.style.overflowAnchor = "";
  };
}

/** Whether the app is holding the reader's place in this viewport right now. */
export function isHoldingPlace(viewport: HTMLElement): boolean {
  return openHolds.has(viewport);
}

/**
 * Keeps the place on every resize of the transcript until the reader steers or `settleMs` passes, then runs `onEnd`. Returns
 * the function that ends the hold early; calling it again does nothing.
 */
function holdPlace(viewport: HTMLElement, settleMs: number, onEnd: () => void): () => void {
  const releaseAnchoring = claimOwnAnchoring(viewport);
  const releaseHold = takeClaim(openHolds, viewport);
  const content = viewport.firstElementChild;
  const resizes =
    typeof ResizeObserver === "undefined" || !(content instanceof HTMLElement)
      ? null
      : new ResizeObserver(() => keepReaderPlace(viewport));
  if (content instanceof HTMLElement) resizes?.observe(content);
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    releaseAnchoring();
    releaseHold();
    resizes?.disconnect();
    window.clearTimeout(timer);
    for (const name of READER_STEERING) viewport.removeEventListener(name, end);
    onEnd();
  };
  const timer = window.setTimeout(end, settleMs);
  for (const name of READER_STEERING) viewport.addEventListener(name, end, { passive: true });
  return end;
}

/**
 * Holds the reader's place while the transcript settles after a change above it: rows above take their real heights, and a
 * control leaves. The place is kept on every resize of the transcript until the reader steers or `settleMs` passes.
 * Returns the function that ends the hold early.
 */
export function holdReaderPlace(viewport: HTMLElement, settleMs: number): () => void {
  keepReaderPlace(viewport);
  return holdPlace(viewport, settleMs, () => undefined);
}

/**
 * Holds a toggle the reader pressed (a card's header) where it is while the rows around it change: the reader must see what
 * they pressed. When the hold ends, the reader's row is the place again, where it now is; a row that has left the transcript
 * is replaced by the row at the reader's place. `reader` is the place before the press. Returns the function that ends it.
 */
export function holdPressedToggle(
  viewport: HTMLElement,
  toggle: HTMLElement,
  reader: MessageScrollAnchor | null,
  settleMs: number,
): () => void {
  rememberReaderPlace(viewport, anchorOn(viewport, toggle, viewport.getBoundingClientRect().top));
  return holdPlace(viewport, settleMs, () => {
    const top = viewport.getBoundingClientRect().top;
    if (reader !== null && isInViewport(viewport, reader.row)) {
      rememberReaderPlace(viewport, anchorOn(viewport, reader.row, top));
    } else {
      rememberReaderPlace(viewport, captureVisibleMessageAnchor(viewport));
    }
  });
}

/** The reader's place in the viewport: the row and offset the app keeps, or null before one is known. */
export function readerPlaceOf(viewport: HTMLElement): MessageScrollAnchor | null {
  return readerPlaces.get(viewport) ?? null;
}

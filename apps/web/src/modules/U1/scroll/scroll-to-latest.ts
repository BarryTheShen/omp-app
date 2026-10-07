/** Frames to keep scrolling before giving up on a bottom that never stops moving (about half a second). */
const MAX_FRAMES = 30;
/** Frames the bottom must stay put before the scroll counts as landed. */
const STABLE_FRAMES = 2;
/** What a reader does to scroll or to take over: any of these ends the follow-up scrolling. */
const READER_INPUT = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;

/**
 * Scrolls to the newest message, and again for as long as the bottom keeps moving.
 *
 * Rows far from the reader are drawn lazily (`content-visibility: auto`): until a row is reached its
 * height is an estimate, so a single scroll to the bottom lands short of the real one. Scrolling
 * again each frame follows the bottom until it stops. The scroll is immediate, never animated: an
 * animation aims at the bottom as it was when it started, and a reader who asks for the latest
 * message wants to be there.
 *
 * Returns a function that stops it. It also stops by itself when the reader takes over (wheel,
 * touch, a press on the scrollbar or the page, a key), so it never fights the reader.
 */
export function scrollToLatest(viewport: HTMLElement): () => void {
  let frame: number | null = null;
  let stopped = false;
  let framesLeft = MAX_FRAMES;
  let stableFrames = 0;
  let previousBottom = Number.NaN;

  const stop = (): void => {
    stopped = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    for (const name of READER_INPUT) viewport.removeEventListener(name, stop);
  };
  const step = (): void => {
    frame = null;
    if (stopped) return;
    const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    stableFrames = bottom === previousBottom ? stableFrames + 1 : 0;
    previousBottom = bottom;
    viewport.scrollTo({ top: bottom, behavior: "instant" });
    framesLeft -= 1;
    if (stableFrames >= STABLE_FRAMES || framesLeft <= 0) {
      stop();
      return;
    }
    frame = window.requestAnimationFrame(step);
  };

  for (const name of READER_INPUT) viewport.addEventListener(name, stop, { passive: true });
  step();
  return stop;
}

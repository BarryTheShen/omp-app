import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  captureVisibleMessageAnchor,
  dropPlaceUntilLayout,
  forgetRetainedScroll,
  holdPressedToggle,
  isHoldingPlace,
  keepReaderPlace,
  keepUnheldReaderPlace,
  readerPlaceOf,
  rememberReaderPlace,
  takePlaceAfterLayout,
  takeRetainedScroll,
} from "./anchor";
import { isViewportAtBottom } from "./reading-place";
import { READER_INPUT, scrollToLatest } from "./scroll-to-latest";

const VIEWPORT_SELECTOR = '[data-slot="u1-thread-viewport"]';
/** Typing in a text field does not take the transcript from the follow (the composer may sit inside it). */
const TEXT_ENTRY_SELECTOR =
  "textarea, input, select, [contenteditable]:not([contenteditable='false'])";

/**
 * How far from the bottom a reader who scrolls down is back at the bottom, and the follow resumes. assistant-ui accepts one
 * pixel, but a reader chasing a growing reply ends each wheel gesture some pixels above the moving end, which that test
 * never accepts (issue 1183). A step up off the bottom still pauses the follow from the exact bottom.
 */
const RESUME_PX = 64;

/** How long a toggle the reader pressed is held where it was pressed, while the card it opens or closes settles (issue 1165). */
const PRESS_SETTLE_MS = 2_000;

/** A press ends when the pointer or the finger is released, wherever that is. */
const PRESS_END = ["pointerup", "pointercancel", "touchend", "touchcancel"] as const;

/** The content below the viewport's bottom edge, in pixels. */
function distanceFromBottom(viewport: HTMLElement): number {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
}

export interface ThreadScrollController {
  /** True while the reader is at the newest message. The controller reads it from the viewport, so the Jump control agrees with the transcript. */
  readonly isAtBottom: boolean;
  /**
   * True while the reader has scrolled away from the bottom. assistant-ui's `autoScroll` is off then, so a streamed reply
   * cannot pull the reader back (issue 1183). The app passes `!followPaused` as `autoScroll`.
   */
  readonly followPaused: boolean;
  /** Scrolls to the newest message and focuses the transcript (the Jump to latest button). */
  readonly followLatest: () => void;
  /** Scrolls to the newest message and leaves the focus alone (a message was just sent). */
  readonly jumpToLatest: () => void;
}

/**
 * assistant-ui owns the bottom state. The custom observers retain the visible row when content-visibility changes row
 * sizes while the reader is away from the latest message, and `jumpToLatest` scrolls to the real bottom (rows far away
 * are drawn lazily). While the reader is away the thread's own follow is paused (`followPaused`), so a stream cannot pull
 * them back (issue 1183).
 */
export function useThreadScrollController(
  transcriptRootRef: RefObject<HTMLElement | null>,
): ThreadScrollController {
  const viewportRef = useRef<HTMLElement | null>(null);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  /** True from a send, or Jump to latest, until the reader scrolls or steers: the newest message stays in view. */
  const followingRef = useRef(false);
  /** The state above, read by the scroll listeners, which must not wait for a render. */
  const followPausedRef = useRef(false);
  const [followPaused, setFollowPaused] = useState(false);
  /**
   * The reader scrolled away from the bottom. The state is committed at once, so assistant-ui's follow is off before the
   * next layout: a content resize in the same frame must not scroll the reader back down. The bottom state says so too:
   * assistant-ui's own check skips a step up when the stream grew since its last check, and then "Jump to latest" would
   * stay hidden (issue 1183).
   */
  const pauseFollowing = useCallback(() => {
    if (followPausedRef.current) return;
    followPausedRef.current = true;
    isAtBottomRef.current = false;
    flushSync(() => {
      setIsAtBottom(false);
      setFollowPaused(true);
    });
  }, []);
  /** The reader is back at the bottom, or has sent a message: assistant-ui's own follow may run again. */
  const resumeFollowing = useCallback(() => {
    if (!followPausedRef.current) return;
    followPausedRef.current = false;
    setFollowPaused(false);
  }, []);

  useEffect(() => {
    const transcriptRoot = transcriptRootRef.current;
    if (transcriptRoot === null) return;
    const viewport = transcriptRoot.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (viewport === null) return;
    const content = viewport.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    const messageList = viewport.querySelector<HTMLElement>('[data-slot="u1-thread-messages"]');

    viewportRef.current = viewport;
    rememberReaderPlace(viewport, captureVisibleMessageAnchor(viewport));
    // After a send the transcript follows the newest message. assistant-ui's own follow stops when a scroll it
    // did not make moves the viewport (its reader-scroll test reads that as the reader scrolling up), so the
    // bottom is put back here, while the reader has not taken over.
    let followFrame: number | null = null;
    const followBottom = (element: HTMLElement): void => {
      if (!followingRef.current || isViewportAtBottom(element)) return;
      element.scrollTo({
        top: Math.max(0, element.scrollHeight - element.clientHeight),
        behavior: "instant",
      });
    };
    const scheduleFollow = (): void => {
      if (followFrame !== null) return;
      followFrame = window.requestAnimationFrame(() => {
        followFrame = null;
        followBottom(viewport);
      });
    };
    // The reader's own wheel gestures, by direction. An upward one holds the follow off while it lasts; a downward one
    // resumes it near the bottom. A scroll down that the reader did not make (assistant-ui following a streamed reply during
    // the reader's upward gesture) resumes nothing (issue 1183).
    const READER_GESTURE_MS = 250;
    // The reader's input (a wheel step, a key, a touch or a press) is their scroll while it lasts; a press lasts until released.
    let readerInputAt = Number.NEGATIVE_INFINITY;
    let pressHeld = false;
    const readerIsScrolling = (): boolean =>
      pressHeld || performance.now() - readerInputAt <= READER_GESTURE_MS;
    // The layout that draws the rows of a scroll the reader did not make has run two frames later at the latest.
    let takeFrames = false;
    const scheduleTakePlace = (): void => {
      if (takeFrames) return;
      takeFrames = true;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          takeFrames = false;
          if (viewport.isConnected) takePlaceAfterLayout(viewport);
        });
      });
    };
    let readerUpUntil = 0;
    let readerDownUntil = 0;
    // The scroll position at the previous scroll tells a step up, which is the reader's: a step up off the bottom pauses
    // the follow.
    let previousScrollTop = viewport.scrollTop;
    const handleScroll = (): void => {
      // While the app holds a place (a pressed toggle, older messages landing), a scroll the app did not make is put back: the
      // browser scrolls a card's body into view when it opens, and the held place is the reader's (issue 1165).
      if (isHoldingPlace(viewport)) {
        if (!takeRetainedScroll(viewport)) keepReaderPlace(viewport);
        previousScrollTop = viewport.scrollTop;
        return;
      }
      // A scroll a retain made is the app moving the reader's row back, not the reader: the place stays (issue 1165). The
      // reader's own scroll is placed where it lands. Any other scroll (the app's move, a jump) may land on rows the browser
      // has not drawn yet, so its place is taken again after the layout that draws them.
      if (!takeRetainedScroll(viewport)) {
        if (readerIsScrolling())
          rememberReaderPlace(viewport, captureVisibleMessageAnchor(viewport));
        else {
          dropPlaceUntilLayout(viewport);
          scheduleTakePlace();
        }
      }
      const steppedUp = viewport.scrollTop < previousScrollTop;
      previousScrollTop = viewport.scrollTop;
      const now = performance.now();
      // The bottom state is the controller's own, read from the viewport on every scroll: assistant-ui's check can miss a
      // step up when the stream grew since its last check, and then the Jump control would stay hidden (issue 1183).
      const atBottom = isViewportAtBottom(viewport);
      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
      if (steppedUp) {
        // A step up within the pixel of tolerance is not the reader leaving the bottom: the follow stays as it is.
        if (!isViewportAtBottom(viewport)) {
          followingRef.current = false;
          pauseFollowing();
        }
      } else if (now <= readerDownUntil && distanceFromBottom(viewport) <= RESUME_PX) {
        // The reader scrolled down into the bottom area: the follow resumes.
        followingRef.current = true;
        resumeFollowing();
      } else if (!followPausedRef.current && now > readerUpUntil && isViewportAtBottom(viewport)) {
        // At the bottom, not paused, and the reader is not scrolling up: the follow runs.
        followingRef.current = true;
      }
      if (followingRef.current) scheduleFollow();
    };
    // A change in the transcript's size is corrected inside the observer's callback, before the browser paints the layout the
    // change made: a correction in a later frame paints the reader's row once in the wrong place (issue 1165).
    const handleResize = (): void => {
      if (followingRef.current) {
        followBottom(viewport);
        rememberReaderPlace(viewport, captureVisibleMessageAnchor(viewport));
        return;
      }
      if (isViewportAtBottom(viewport)) return;
      // The place keeps the offset it was given, even when the retain fell short: the next layout change restores it.
      keepUnheldReaderPlace(viewport);
    };
    // Track the viewport and direct message rows, never tool-card descendants.
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    resizeObserver?.observe(viewport);
    resizeObserver?.observe(content);
    if (messageList !== null && resizeObserver !== null) {
      for (const child of messageList.children) {
        if (child instanceof HTMLElement && child.hasAttribute("data-message-id")) {
          resizeObserver.observe(child);
        }
      }
    }
    const mutationObserver =
      typeof MutationObserver === "undefined" || messageList === null
        ? null
        : new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.removedNodes) {
                if (node instanceof HTMLElement) resizeObserver?.unobserve(node);
              }
              for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.hasAttribute("data-message-id")) {
                  resizeObserver?.observe(node);
                }
              }
            }
          });
    if (mutationObserver !== null && messageList !== null) {
      mutationObserver.observe(messageList, { childList: true });
    }
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    // The reader's own scrolling or steering ends the follow; typing in a text field does not.
    const stopFollowing = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest(TEXT_ENTRY_SELECTOR) !== null)
        return;
      readerInputAt = performance.now();
      if (event.type === "pointerdown" || event.type === "touchstart") pressHeld = true;
      followingRef.current = false;
      // The reader's input supersedes the place the app kept: the next scroll is theirs (issue 1165).
      forgetRetainedScroll(viewport);
      if (event instanceof WheelEvent) {
        if (event.deltaY < 0) readerUpUntil = performance.now() + READER_GESTURE_MS;
        if (event.deltaY > 0) readerDownUntil = performance.now() + READER_GESTURE_MS;
      }
    };
    for (const name of READER_INPUT)
      viewport.addEventListener(name, stopFollowing, { passive: true });

    // A press ends wherever the pointer or the finger is released, so its release is listened for on the window.
    const releasePress = (): void => {
      pressHeld = false;
    };
    for (const name of PRESS_END) window.addEventListener(name, releasePress, { passive: true });

    // A toggle above the reader's row changes its card at once while the reader is away: an animated change there moves the
    // reader's row frame by frame, and the scroll correction does not keep up (issue 1240). The card's panel reads the mark
    // and does not transition until the mark is taken away.
    let endInstant: (() => void) | null = null;
    const markInstantToggle = (toggle: HTMLElement): void => {
      endInstant?.();
      const card = toggle.closest<HTMLElement>('[data-slot="u3-tool-card"]');
      const row = toggle.closest("[data-message-id]");
      const reader = readerPlaceOf(viewport)?.row;
      if (card === null || row === null || reader === undefined || row === reader) return;
      // The row comes before the reader's row: the change lies above the place the reader is on.
      if ((reader.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) === 0) return;
      card.setAttribute("data-instant-toggle", "");
      const timer = window.setTimeout(() => endInstant?.(), PRESS_SETTLE_MS);
      endInstant = (): void => {
        window.clearTimeout(timer);
        card.removeAttribute("data-instant-toggle");
        endInstant = null;
      };
    };
    // A press on a toggle (a card's header, a disclosure) holds the toggle where the reader pressed it while the rows around it
    // change: the reader must see what they pressed. The reader's row is the place again once the change settles (issue 1165).
    let pressHold: (() => void) | null = null;
    const handlePress = (event: PointerEvent): void => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const toggle = event.target.closest("[aria-expanded]");
      if (!(toggle instanceof HTMLElement) || !viewport.contains(toggle)) return;
      // While the view follows the newest message, the card's change is followed as before: nothing is held.
      if (!followPausedRef.current) return;
      // A press while the last toggle is still held ends that hold first: the reader's row is then the place again.
      pressHold?.();
      markInstantToggle(toggle);
      pressHold = holdPressedToggle(viewport, toggle, readerPlaceOf(viewport), PRESS_SETTLE_MS);
    };
    viewport.addEventListener("pointerdown", handlePress, { passive: true });
    // Enter or Space on a focused toggle changes its card as a press does: at once while the reader is away (issue 1240).
    const handleToggleKey = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const toggle = event.target;
      if (!(toggle instanceof HTMLElement) || !toggle.hasAttribute("aria-expanded")) return;
      if (viewport.contains(toggle) && followPausedRef.current) markInstantToggle(toggle);
    };
    viewport.addEventListener("keydown", handleToggleKey, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("pointerdown", handlePress);
      viewport.removeEventListener("keydown", handleToggleKey);
      for (const name of READER_INPUT) viewport.removeEventListener(name, stopFollowing);
      for (const name of PRESS_END) window.removeEventListener(name, releasePress);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      pressHold?.();
      endInstant?.();
      if (followFrame !== null) window.cancelAnimationFrame(followFrame);
      viewportRef.current = null;
    };
  }, [transcriptRootRef, pauseFollowing, resumeFollowing]);
  const stopScrollRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopScrollRef.current?.(), []);
  /**
   * Shows the newest message: scrolls there at once and keeps scrolling until it really is the
   * bottom (see scrollToLatest). Used when the person sends a message, which is when they want the
   * answer; a run starting is not that, because runs also start in the middle of an answer.
   * The transcript then follows the newest message until the reader scrolls or steers.
   */
  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    followingRef.current = true;
    resumeFollowing();
    stopScrollRef.current?.();
    stopScrollRef.current = scrollToLatest(viewport);
  }, [resumeFollowing]);
  /** The "Jump to latest" action: scroll there and put the keyboard focus back on the transcript. */
  const followLatest = useCallback(() => {
    jumpToLatest();
    viewportRef.current?.focus({ preventScroll: true });
  }, [jumpToLatest]);
  return useMemo(
    () => ({ isAtBottom, followPaused, followLatest, jumpToLatest }),
    [followLatest, followPaused, isAtBottom, jumpToLatest],
  );
}

import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureVisibleMessageAnchor, retainVisibleMessageAnchor } from "./anchor";
import { isViewportAtBottom } from "./reading-place";
import { READER_INPUT, scrollToLatest } from "./scroll-to-latest";

const VIEWPORT_SELECTOR = '[data-slot="u1-thread-viewport"]';
/** Typing in a text field does not take the transcript from the follow (the composer may sit inside it). */
const TEXT_ENTRY_SELECTOR =
  "textarea, input, select, [contenteditable]:not([contenteditable='false'])";

export interface ThreadScrollController {
  readonly isAtBottom: boolean;
  /** Scrolls to the newest message and focuses the transcript (the Jump to latest button). */
  readonly followLatest: () => void;
  /** Scrolls to the newest message and leaves the focus alone (a message was just sent). */
  readonly jumpToLatest: () => void;
  readonly onAtBottomChange: (isAtBottom: boolean) => void;
}

/**
 * assistant-ui owns the bottom state. The custom observers retain the visible row when
 * content-visibility changes row sizes while the reader is away from the latest message, and
 * `jumpToLatest` scrolls to the real bottom (rows far away are drawn lazily).
 */
export function useThreadScrollController(
  transcriptRootRef: RefObject<HTMLElement | null>,
): ThreadScrollController {
  const viewportRef = useRef<HTMLElement | null>(null);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  /** True from a send, or Jump to latest, until the reader scrolls or steers: the newest message stays in view. */
  const followingRef = useRef(false);
  const onAtBottomChange = useCallback((next: boolean) => {
    isAtBottomRef.current = next;
    setIsAtBottom(next);
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
    let anchor = captureVisibleMessageAnchor(viewport);
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
    const handleScroll = (): void => {
      anchor = captureVisibleMessageAnchor(viewport);
      if (followingRef.current) scheduleFollow();
    };
    let resizeFrame: number | null = null;
    const handleResize = (): void => {
      if (resizeFrame !== null) return;
      // Wait for content-visibility to settle before restoring the visible row.
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (followingRef.current) {
          followBottom(viewport);
          anchor = captureVisibleMessageAnchor(viewport);
          return;
        }
        if (isAtBottomRef.current) return;
        retainVisibleMessageAnchor(viewport, anchor);
        anchor = captureVisibleMessageAnchor(viewport);
      });
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
            handleResize();
          });
    if (mutationObserver !== null && messageList !== null) {
      mutationObserver.observe(messageList, { childList: true });
    }
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    // The reader's own scrolling or steering ends the follow; typing in a text field does not.
    const stopFollowing = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest(TEXT_ENTRY_SELECTOR) !== null)
        return;
      followingRef.current = false;
    };
    for (const name of READER_INPUT)
      viewport.addEventListener(name, stopFollowing, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      for (const name of READER_INPUT) viewport.removeEventListener(name, stopFollowing);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (followFrame !== null) window.cancelAnimationFrame(followFrame);
      viewportRef.current = null;
    };
  }, [transcriptRootRef]);
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
    stopScrollRef.current?.();
    stopScrollRef.current = scrollToLatest(viewport);
  }, []);
  /** The "Jump to latest" action: scroll there and put the keyboard focus back on the transcript. */
  const followLatest = useCallback(() => {
    jumpToLatest();
    viewportRef.current?.focus({ preventScroll: true });
  }, [jumpToLatest]);
  return useMemo(
    () => ({ isAtBottom, followLatest, jumpToLatest, onAtBottomChange }),
    [followLatest, isAtBottom, jumpToLatest, onAtBottomChange],
  );
}

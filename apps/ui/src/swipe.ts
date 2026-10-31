import { type PointerEvent, useRef, useState } from "react";

/** How far a finger moves before its drag counts as a swipe, or as the list's scroll. */
const SLOP_PX = 8;

/** The handlers a swipe needs on its element, where its content is, and the check its click makes. */
export interface Swipe {
  /** How far the content is moved to the left, in px: 0 shut, the actions' width open. */
  readonly offset: number;
  /** A finger is moving the content: it follows without an animation then. */
  readonly dragging: boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  /** Whether the click that follows ended a swipe, or shut an open row: the element's own click is skipped then. */
  readonly endsSwipe: () => boolean;
}

/**
 * A row a finger swipes to the left to show the actions behind it, `width` px of them, as Apple's swipe actions do but
 * without a full swipe, so nothing runs without a tap. The row stays open when the finger lifts past half way, and shuts
 * otherwise; a tap on an open row shuts it. A drag that starts up or down is the list's scroll and moves nothing (the
 * element sets `touch-action: pan-y`). `onStart` runs as a swipe begins (a touch-and-hold stops then). Only touch and
 * pen: a mouse has the row's buttons.
 */
export function useSwipe(
  width: number,
  open: boolean,
  onOpenChange: (open: boolean) => void,
  onStart: () => void,
): Swipe {
  const start = useRef<{ readonly x: number; readonly y: number; readonly from: number } | null>(
    null,
  );
  const swiping = useRef(false);
  const skipClick = useRef(false);
  /** The distance the last move reached, for a lift that comes before React has drawn it. */
  const moved = useRef<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const reset = (): void => {
    start.current = null;
    swiping.current = false;
    moved.current = null;
    setDrag(null);
  };
  return {
    offset: drag ?? (open ? width : 0),
    dragging: drag !== null,
    onPointerDown: (event) => {
      skipClick.current = false;
      if (event.pointerType === "mouse") return;
      start.current = { x: event.clientX, y: event.clientY, from: open ? width : 0 };
      swiping.current = false;
    },
    onPointerMove: (event) => {
      const from = start.current;
      if (from === null) return;
      const left = from.x - event.clientX;
      if (!swiping.current) {
        const down = Math.abs(event.clientY - from.y);
        if (Math.abs(left) < SLOP_PX && down < SLOP_PX) return;
        if (down >= Math.abs(left)) {
          // The list's scroll.
          start.current = null;
          return;
        }
        swiping.current = true;
        onStart();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is gone already; the moves that still come keep the swipe going.
        }
      }
      moved.current = Math.min(width, Math.max(0, from.from + left));
      setDrag(moved.current);
    },
    onPointerUp: () => {
      const from = start.current;
      if (from === null) return;
      if (swiping.current) {
        onOpenChange((moved.current ?? from.from) > width / 2);
        skipClick.current = true;
      } else if (open) {
        onOpenChange(false);
        skipClick.current = true;
      }
      reset();
    },
    onPointerCancel: reset,
    endsSwipe: () => {
      const was = skipClick.current;
      skipClick.current = false;
      return was;
    },
  };
}

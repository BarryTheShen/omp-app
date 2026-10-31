import { type PointerEvent, type SyntheticEvent, useRef } from "react";

/** How long a press lasts before it counts as a touch-and-hold. */
export const HOLD_MS = 450;

/** The handlers a touch-and-hold needs on its element, and the check its click makes. */
export interface LongPress {
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onPointerLeave: () => void;
  readonly onPointerCancel: () => void;
  readonly onContextMenu: (event: SyntheticEvent) => void;
  /** Whether the click that follows ends a touch-and-hold: the element's own click is skipped then. */
  readonly endsHold: () => boolean;
}

/**
 * A touch-and-hold on an element (a phone's long press): `onHold` runs when the finger lifts after a press of `HOLD_MS`
 * or longer, within the touch, where a phone brings its keyboard up or a menu takes the focus. A finger that leaves the
 * element or starts a scroll ends it without a hold. Only touch and pen count: a mouse has its own buttons.
 */
export function useLongPress(onHold: () => void): LongPress {
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const stop = (): void => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    onPointerDown: (event) => {
      held.current = false;
      stop();
      if (event.pointerType === "mouse") return;
      timer.current = window.setTimeout(() => {
        held.current = true;
      }, HOLD_MS);
    },
    onPointerUp: () => {
      stop();
      if (held.current) onHold();
    },
    onPointerLeave: () => {
      stop();
      held.current = false;
    },
    onPointerCancel: () => {
      stop();
      held.current = false;
    },
    // A phone's own long-press menu (copy, look up) would cover the app's.
    onContextMenu: (event) => event.preventDefault(),
    endsHold: () => {
      const was = held.current;
      held.current = false;
      return was;
    },
  };
}

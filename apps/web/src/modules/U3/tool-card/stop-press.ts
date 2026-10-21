import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useRef } from "react";

/** How far outside the box a press began on a release may land and still stop the job: a few pixels of slop. */
const RELEASE_SLOP_PX = 4;

export interface StopPress {
  /** The Stop control's ref: attach it to the button the container holds. */
  readonly control: RefObject<HTMLButtonElement | null>;
  /** Spread on the container that holds the Stop control and the text beside it. */
  readonly container: {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  };
}

/**
 * A Stop control acts on a pointer click whose press began on it and whose release lands inside the box the control had
 * when the press began, give or take a few pixels. A card can re-render between a press and its release and move the
 * control out from under a still pointer. The browser then sends the click to the nearest common ancestor of the press
 * and the release targets, which is the container, so the container listens (issue 2255). A pointer that slid off the
 * place it pressed cancels, as a normal button does. Keyboard and assistive-technology activation (a click with no
 * pointer, detail 0) acts on the control as before.
 */
export function useStopPress(stop: () => void, pending: boolean): StopPress {
  const control = useRef<HTMLButtonElement | null>(null);
  // The control's box when the current press began on it; null when the press began anywhere else.
  const pressedBox = useRef<DOMRect | null>(null);
  return {
    control,
    container: {
      onPointerDown: (event) => {
        const target = event.target;
        const pressed = control.current;
        if (pressed !== null && target instanceof Node && pressed.contains(target)) {
          pressedBox.current = pressed.getBoundingClientRect();
        } else {
          pressedBox.current = null;
        }
      },
      onClick: (event) => {
        const box = pressedBox.current;
        pressedBox.current = null;
        if (pending) return;
        if (event.detail === 0) {
          // Keyboard and assistive-technology activation: the control acts on its own click.
          const target = event.target;
          if (target instanceof Node && control.current?.contains(target) === true) stop();
          return;
        }
        // A pointer click acts only when it was released inside the box its press began on.
        if (box === null) return;
        const { clientX: x, clientY: y } = event;
        const inside =
          x >= box.left - RELEASE_SLOP_PX &&
          x <= box.right + RELEASE_SLOP_PX &&
          y >= box.top - RELEASE_SLOP_PX &&
          y <= box.bottom + RELEASE_SLOP_PX;
        if (inside) stop();
      },
    },
  };
}

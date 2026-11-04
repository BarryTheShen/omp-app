import { type ReactNode, useRef } from "react";
import { clampListWidth, LIST_MAX_PX, LIST_MIN_PX, LIST_STEP_PX } from "./size";

/**
 * The chat list's right edge, which resizes it (#2805), as a window splitter: a drag moves it, the arrow keys move it
 * when it has the keyboard, and a double click puts the layout's own width back. It sits over the list's edge, inside the
 * list's box (the list is `relative`). While it is dragged it moves the columns itself, a frame at a time, and gives the
 * new width once, when it is let go: given on every move, the whole app drew again each time and the drag lagged (#2826).
 */
export function ListEdge({
  width,
  onResize,
}: {
  /** The width the list was given; null while it has the layout's own. */
  readonly width: number | null;
  readonly onResize: (px: number | null) => void;
}): ReactNode {
  const drag = useRef<{
    readonly x: number;
    readonly width: number;
    /** The element whose `--list-width` sets the list's column. */
    readonly grid: HTMLElement | null;
    latest: number;
    moved: boolean;
    frame: number;
  } | null>(null);
  /** The list's width on screen: the given one, or the layout's own, measured. */
  const shown = (edge: HTMLElement): number =>
    width ?? edge.parentElement?.getBoundingClientRect().width ?? LIST_MIN_PX;
  /** The drag is over: the width it reached is given once. */
  const end = (): void => {
    const done = drag.current;
    drag.current = null;
    if (done === null) return;
    cancelAnimationFrame(done.frame);
    if (done.moved && done.latest !== done.width) onResize(done.latest);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter is a `separator` with a value; no element is one
    <div
      data-tour="chat-list-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the chat list"
      aria-valuemin={LIST_MIN_PX}
      aria-valuemax={LIST_MAX_PX}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title="Drag to resize the chat list; double click for its own width"
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-l2 focus-visible:bg-l3"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = shown(event.currentTarget);
        drag.current = {
          x: event.clientX,
          width: start,
          grid: event.currentTarget.closest<HTMLElement>("[data-app-root]"),
          latest: start,
          moved: false,
          frame: 0,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === null) return;
        if (!current.moved) {
          current.moved = true;
          // The layout's own width becomes a given one, so the list's column reads `--list-width`.
          if (width === null) onResize(current.width);
        }
        current.latest = clampListWidth(current.width + event.clientX - current.x);
        if (current.frame !== 0) return;
        current.frame = requestAnimationFrame(() => {
          current.frame = 0;
          current.grid?.style.setProperty("--list-width", `${current.latest}px`);
        });
      }}
      onPointerUp={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowLeft" ? -LIST_STEP_PX : event.key === "ArrowRight" ? LIST_STEP_PX : 0;
        if (step === 0) return;
        event.preventDefault();
        onResize(shown(event.currentTarget) + step);
      }}
    />
  );
}

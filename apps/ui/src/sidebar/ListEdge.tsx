import { type ReactNode, useRef } from "react";
import { LIST_MAX_PX, LIST_MIN_PX, LIST_STEP_PX } from "./size";

/**
 * The chat list's right edge, which resizes it (#2805), as a window splitter: a drag moves it, the arrow keys move it
 * when it has the keyboard, and a double click puts the layout's own width back. It sits over the list's edge, inside the
 * list's box (the list is `relative`).
 */
export function ListEdge({
  width,
  onResize,
}: {
  /** The width the list was given; null while it has the layout's own. */
  readonly width: number | null;
  readonly onResize: (px: number | null) => void;
}): ReactNode {
  const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
  /** The list's width on screen: the given one, or the layout's own, measured. */
  const shown = (edge: HTMLElement): number =>
    width ?? edge.parentElement?.getBoundingClientRect().width ?? LIST_MIN_PX;
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
        drag.current = { x: event.clientX, width: shown(event.currentTarget) };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start !== null) onResize(start.width + event.clientX - start.x);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
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

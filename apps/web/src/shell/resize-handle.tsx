import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cn } from "@/lib/utils";

export type ResizeSide = "left" | "right";

export interface ResizeHandleProps {
  readonly side: ResizeSide;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly onChange: (value: number) => void;
}

interface PointerResizeState {
  readonly pointerId: number;
  readonly coordinate: number;
  readonly width: number;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** A pointer- and keyboard-operable separator whose value is measured in rem. */
export function ResizeHandle({ side, value, minimum, maximum, onChange }: ResizeHandleProps) {
  const pointerState = useRef<PointerResizeState | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    pointerState.current = {
      pointerId: event.pointerId,
      coordinate: event.clientX,
      width: value,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = pointerState.current;
    if (start === null || start.pointerId !== event.pointerId) return;

    const pixelsPerRem = Number.parseFloat(
      window.getComputedStyle(document.documentElement).fontSize,
    );
    const delta =
      (event.clientX - start.coordinate) / (Number.isFinite(pixelsPerRem) ? pixelsPerRem : 16);
    onChange(
      bounded(side === "left" ? start.width + delta : start.width - delta, minimum, maximum),
    );
  };

  const stopPointerResize = (event: PointerEvent<HTMLElement>) => {
    if (pointerState.current?.pointerId !== event.pointerId) return;
    pointerState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 2 : 1;
    let next: number | undefined;
    if (event.key === "Home") next = minimum;
    else if (event.key === "End") next = maximum;
    else if (event.key === "ArrowLeft") next = side === "left" ? value - step : value + step;
    else if (event.key === "ArrowRight") next = side === "left" ? value + step : value - step;
    if (next === undefined) return;

    event.preventDefault();
    onChange(bounded(next, minimum, maximum));
  };

  return (
    <hr
      aria-label={`Resize ${side === "left" ? "sessions" : "panels"} sidebar`}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={value}
      className={cn(
        "absolute inset-y-0 h-auto border-0 z-sticky w-1 cursor-col-resize outline-none focus-visible:bg-ring/50",
        // The grip sits on the sidebar's inner border: Sessions draws its border on the end edge, Panels on the start edge.
        side === "left" ? "end-0" : "start-0",
      )}
      data-shell-resize-handle={side}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerCancel={stopPointerResize}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopPointerResize}
    />
  );
}

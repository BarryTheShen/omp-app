import { type RefObject, useEffect, useState } from "react";

/**
 * Re-renders the caller whenever the element's width changes.
 *
 * `react-textarea-autosize` sizes its box when it renders and when the window fires `resize`; an empty box
 * is sized to its placeholder at the width it has at that moment. When the window narrows, `resize` fires
 * while the sidebars are still open, so the column is tiny and the placeholder wraps; the sidebars fold a
 * moment later and the box is wide again, but nothing renders it, so it keeps the tall height until the
 * next keystroke. Observing the box's own width and rendering when it changes makes the library measure
 * again at the settled width. Height changes are ignored: the library causes them, so reacting to them
 * would loop.
 */
export function useRemeasureOnWidthChange(ref: RefObject<HTMLElement | null>): void {
  const [, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    let last = element.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (width === last) return;
      last = width;
      setWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
}

import { type RefCallback, useCallback, useEffect, useRef } from "react";

/** A wheel's line in pixels, for a wheel that reports lines (`deltaMode` 1). */
const LINE_PX = 16;
/** Room left beside a tab brought into view, so the next one shows the row goes on. */
const EDGE_ROOM_PX = 24;

/**
 * A row of tabs or chips that scrolls sideways, styled `row-scroll` (#2802): it draws no scroll bar, since the desktop
 * window draws its own over the labels. A mouse wheel turned over the row scrolls it sideways (a touchpad's sideways
 * swipe already does), leaving the wheel to the page at either end; and the selected tab (`[aria-selected="true"]`) is
 * brought into view each time `selected` changes. The returned ref goes on the row.
 */
export function useSidewaysRow(selected: unknown): RefCallback<HTMLElement> {
  const shown = useRef<HTMLElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each newly selected tab is brought into view
  useEffect(() => {
    const row = shown.current;
    const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row == null || tab == null) return;
    const view = row.getBoundingClientRect();
    const place = tab.getBoundingClientRect();
    if (place.left < view.left) row.scrollLeft -= view.left - place.left + EDGE_ROOM_PX;
    else if (place.right > view.right) row.scrollLeft += place.right - view.right + EDGE_ROOM_PX;
  }, [selected]);

  return useCallback((row: HTMLElement | null) => {
    shown.current = row;
    if (row === null) return;
    // Not React's `onWheel`: React listens to the wheel passively, so it could not keep the page from scrolling too.
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaMode === 1 ? event.deltaY * LINE_PX : event.deltaY;
      const end = row.scrollWidth - row.clientWidth;
      if ((delta < 0 && row.scrollLeft <= 0) || (delta > 0 && row.scrollLeft >= end - 1)) return;
      event.preventDefault();
      row.scrollLeft += delta;
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      row.removeEventListener("wheel", onWheel);
      shown.current = null;
    };
  }, []);
}

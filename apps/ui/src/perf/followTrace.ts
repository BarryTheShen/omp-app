import type { ClientTraceReport } from "@omp-app/contracts";
import type { Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useEffect, useRef } from "react";
import { clientTags } from "./frames";

/** How long the transcript must stay away from its end before it counts as lost: a write on its way lands sooner. */
const SETTLE_MS = 600;
/** The reader's input this long before the view left the end explains it. */
const INPUT_MS = 1_000;
/** At most this many reports per page load, at least this far apart, so the log keeps a sample, not a stream. */
const MOST_REPORTS = 12;
const APART_MS = 5_000;
/** Keys that scroll the element with the focus. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

let sink: ((trace: ClientTraceReport) => void) | null = null;
let reports = 0;
let lastReport = Number.NEGATIVE_INFINITY;

/**
 * Sends each report of a transcript that left its end by itself (no wheel, touch, press or scroll key) to `report`, the
 * server's debug log. Returns the function that stops it.
 */
export function traceFollow(report: (trace: ClientTraceReport) => void): () => void {
  sink = report;
  return () => {
    if (sink === report) sink = null;
  };
}

/** TanStack Virtual 3.19.9's state behind following, read for the report only; a name a later version drops is left out. */
interface Internals {
  readonly _holdOffset?: number;
  readonly scrollState?: { readonly behavior?: string; readonly phase?: string } | null;
  readonly _clampedAdjustment?: unknown;
  readonly getVirtualDistanceFromEnd?: () => number;
  readonly _getLayoutTotalSize?: () => number;
  readonly getSize?: () => number;
  /** The last position read was past an edge (a bounce): nothing is written meanwhile. */
  readonly _reportedOverscroll?: boolean;
  /** The iOS touch gesture: a finger down, the glide after it, or a glide that may still report. */
  readonly _iosGesture?: {
    readonly touch?: { readonly phase?: string; readonly moved?: boolean } | null;
  };
}

/** Where the list and its last drawn row are, from TanStack's numbers and the page's, each name led by `prefix`. */
function layout(
  element: HTMLElement,
  instance: Virtualizer<HTMLDivElement, Element>,
  prefix: string,
): Record<string, number> {
  const internals = instance as unknown as Internals;
  const items = instance.getVirtualItems();
  const last = items.at(-1);
  const hold = internals._holdOffset ?? 0;
  const marks: Record<string, number> = {
    distance_px: instance.getDistanceFromEnd(),
    scroll_top: element.scrollTop,
    scroll_height: element.scrollHeight,
    client_height: element.clientHeight,
    offset_px: instance.scrollOffset ?? 0,
    total_px: instance.getTotalSize(),
    hold_px: Math.abs(hold),
    hold_up: hold < 0 ? 1 : 0,
    smooth: internals.scrollState?.behavior === "smooth" ? 1 : 0,
    scroll_command: internals.scrollState === null || internals.scrollState === undefined ? 0 : 1,
    clamped:
      internals._clampedAdjustment === null || internals._clampedAdjustment === undefined ? 0 : 1,
    scrolling: instance.isScrolling ? 1 : 0,
    rows: instance.options.count,
    last_drawn: last?.index ?? 0,
    unmeasured_drawn: items.filter((item) => !instance.itemSizeCache.has(item.key)).length,
  };
  const virtualDistance = internals.getVirtualDistanceFromEnd?.();
  if (virtualDistance !== undefined) marks.virtual_distance_px = virtualDistance;
  const layoutTotal = internals._getLayoutTotalSize?.();
  if (layoutTotal !== undefined) marks.layout_total_px = layoutTotal;
  const size = internals.getSize?.();
  if (size !== undefined) marks.size_px = size;
  // How far the last drawn row ends below the view's bottom (or above it): the latest rows on screen or not.
  const row =
    last === undefined
      ? null
      : element.querySelector<HTMLElement>(`[data-index="${String(last.index)}"]`);
  if (row !== null) {
    const below = row.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
    marks[below >= 0 ? "last_row_below_px" : "last_row_above_px"] = Math.abs(below);
  }
  return Object.fromEntries(
    Object.entries(marks).map(([name, value]) => [
      `${prefix}${name}`,
      Math.round(Math.max(0, value)),
    ]),
  );
}

/**
 * Reports the transcript leaving its end with nothing from the reader to explain it (#2778: "Jump to latest" showed
 * during a long turn, with the latest rows on screen): when the list stops being at its end and is still away after
 * `SETTLE_MS`, with no wheel, touch, press or scroll key in the `INPUT_MS` before, it sends TanStack's numbers and the
 * page's at that moment (`at_`) and after the wait (`after_`), the hold on corrections, and what happened last.
 */
export function useFollowTrace(
  scrollRef: RefObject<HTMLElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
  state: {
    readonly atEnd: boolean;
    readonly rows: number;
    readonly working: boolean;
    /** The reader's wheel or key holds the list's corrections (`useHoldCorrectionsWhileReading`). */
    readonly holding: RefObject<boolean>;
    /** The reader follows the latest output (`useFollowLatest`): a lost end with this on was not the reader's doing. */
    readonly following: RefObject<boolean>;
  },
): void {
  const lastInput = useRef(Number.NEGATIVE_INFINITY);
  const lastKey = useRef(Number.NEGATIVE_INFINITY);
  const lastAppend = useRef(performance.now());
  const lastShown = useRef(performance.now());
  const wasAtEnd = useRef(state.atEnd);
  const working = useRef(state.working);
  working.current = state.working;

  useEffect(() => {
    const input = (): void => {
      lastInput.current = performance.now();
    };
    const onKey = (event: KeyboardEvent): void => {
      lastKey.current = performance.now();
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea") !== null)
      )
        return;
      if (SCROLL_KEYS.has(event.key)) input();
    };
    const onVisible = (): void => {
      if (!document.hidden) lastShown.current = performance.now();
    };
    const listening = { capture: true, passive: true } as const;
    document.addEventListener("wheel", input, listening);
    document.addEventListener("touchstart", input, listening);
    document.addEventListener("pointerdown", input, listening);
    document.addEventListener("keydown", onKey, listening);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("wheel", input, { capture: true });
      document.removeEventListener("touchstart", input, { capture: true });
      document.removeEventListener("pointerdown", input, { capture: true });
      document.removeEventListener("keydown", onKey, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const { atEnd, holding, following, rows } = state;
  const rowCount = useRef(rows);
  useEffect(() => {
    if (rowCount.current === rows) return;
    rowCount.current = rows;
    lastAppend.current = performance.now();
  }, [rows]);

  useEffect(() => {
    const was = wasAtEnd.current;
    wasAtEnd.current = atEnd;
    const element = scrollRef.current;
    if (atEnd || !was || element === null || sink === null) return;
    const left = performance.now();
    if (left - lastInput.current < INPUT_MS) return;
    const at = layout(element, instance, "at_");
    const since = (time: number): number =>
      Number.isFinite(time) ? Math.round(left - time) : 3_600_000;
    const context = {
      working: working.current ? 1 : 0,
      holding: holding.current ? 1 : 0,
      following: following.current ? 1 : 0,
      hidden: document.hidden ? 1 : 0,
      focused: document.hasFocus() ? 1 : 0,
      since_append_ms: since(lastAppend.current),
      since_key_ms: since(lastKey.current),
      since_input_ms: since(lastInput.current),
      since_shown_ms: since(lastShown.current),
    };
    const check = window.setTimeout(() => {
      const report = sink;
      if (report === null || instance.isAtEnd() || lastInput.current >= left - INPUT_MS) return;
      if (reports >= MOST_REPORTS || performance.now() - lastReport < APART_MS) return;
      reports += 1;
      lastReport = performance.now();
      report({
        marks: {
          ...at,
          ...layout(element, instance, "after_"),
          ...context,
          after_holding: holding.current ? 1 : 0,
        },
        gaps: [],
        supported: ["follow-lost", ...clientTags()],
      });
    }, SETTLE_MS);
    return () => window.clearTimeout(check);
  }, [atEnd, scrollRef, instance, holding, following]);
}

/** A correction held this long, with no scroll event for as long, is reported: it keeps rows out of the scroll's reach. */
const HELD_MS = 1_500;
const TOUCH_PHASES = ["down", "tail", "lateFling"];

/**
 * Reports a correction TanStack has held for `HELD_MS` while the transcript sat still: the rows above are drawn above
 * its top then, out of reach. The report says what kept the write back (the last read past an edge, a touch gesture
 * not over) and where the transcript is, so a case that still sticks on a device can be told from the log.
 */
export function useHoldTrace(
  scrollRef: RefObject<HTMLElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): void {
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let lastScroll = performance.now();
    let heldSince: number | null = null;
    let reported = false;
    const onScroll = (): void => {
      lastScroll = performance.now();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const timer = window.setInterval(() => {
      const internals = instance as unknown as Internals;
      const now = performance.now();
      if ((internals._holdOffset ?? 0) === 0) {
        heldSince = null;
        reported = false;
        return;
      }
      heldSince ??= now;
      const report = sink;
      if (report === null || reported || now - heldSince < HELD_MS || now - lastScroll < HELD_MS)
        return;
      if (reports >= MOST_REPORTS || now - lastReport < APART_MS) return;
      reported = true;
      reports += 1;
      lastReport = now;
      const touch = internals._iosGesture?.touch;
      const top = element.scrollTop;
      report({
        marks: {
          ...layout(element, instance, "at_"),
          held_ms: Math.round(now - heldSince),
          since_scroll_ms: Math.round(now - lastScroll),
          overscroll: internals._reportedOverscroll === true ? 1 : 0,
          touch:
            touch === null || touch === undefined ? 0 : TOUCH_PHASES.indexOf(touch.phase ?? "") + 1,
          touch_moved: touch?.moved === true ? 1 : 0,
          past_top: top < 0 ? 1 : 0,
          past_top_px: Math.round(Math.max(0, -top)),
        },
        gaps: [],
        supported: ["hold-held", ...clientTags()],
      });
    }, 500);
    return () => {
      window.clearInterval(timer);
      element.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, instance]);
}

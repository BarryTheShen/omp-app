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

/** What the transcript knows about its top that TanStack does not, read at each sample of `useTopTrace`. */
export interface TopState {
  /** The spare room above the first row (`spareFor`), px. */
  readonly spare: number;
  /** Older entries read but waiting for the scroll to rest. */
  readonly waiting: number;
  /** The read of the next older window: 0 none under way, 1 under way, 2 failed. */
  readonly load: number;
  /** Older entries remain in the chat's file. */
  readonly older: boolean;
  /** Entries drawn, and entries read. */
  readonly shown: number;
  readonly read: number;
  /** Windows of entries read so far. */
  readonly windows: number;
  /** The reader's scroll has not rested (`useReaderRest`). */
  readonly moving: boolean;
  /** The rests so far: each sets the spare room again. */
  readonly rests: number;
}

/** How often the top's state is sampled while the reader touches or scrolls the transcript. */
const TOP_SAMPLE_MS = 100;
/** Sampling goes on this long after the last touch or scroll. */
const TOP_ACTIVE_MS = 6_000;
/** The samples from before a stall that its report carries. */
const TOP_BEFORE_MS = 3_000;
/** A stall shorter than this is not reported; one that lasts `TOP_CAP_MS` is reported while it lasts. */
const TOP_MIN_STALL_MS = 200;
const TOP_CAP_MS = 5_000;
/** A finger that moved this far toward older messages in `TOP_DRAG_MS` while the view moved less than `TOP_DRAG_MOVED_PX`. */
const TOP_DRAG_PX = 60;
const TOP_DRAG_MS = 300;
const TOP_DRAG_MOVED_PX = 10;
/** Stall reports per page load, at least this far apart. */
const TOP_MOST = 40;
const TOP_APART_MS = 1_000;
let topReports = 0;
let lastTopReport = Number.NEGATIVE_INFINITY;

type TopSample = Record<string, number>;

/**
 * The transcript's top at one moment: the scroll position (`past`: how far a bounce has pulled it past the top), the
 * finger (`fy`: where it last was), the spare room, the correction TanStack holds, the rows drawn above the top (out of
 * every scroll's reach), where the top band is from the view's top (`band_up`: above it), the older entries' state and
 * whether the last read position was past an edge (`over`).
 */
function topSample(
  element: HTMLElement,
  instance: Virtualizer<HTMLDivElement, Element>,
  state: TopState,
  finger: { readonly count: number; readonly y: number },
): TopSample {
  const internals = instance as unknown as Internals;
  const top = element.scrollTop;
  const box = element.getBoundingClientRect();
  const sizer = element.firstElementChild?.getBoundingClientRect().top ?? box.top;
  let above = 0;
  for (const row of element.querySelectorAll<HTMLElement>("[data-index]"))
    if (row.getBoundingClientRect().top < sizer - 1) above += 1;
  const band = element.querySelector<HTMLElement>("[data-transcript-edge]");
  const bandAt = band === null ? 0 : band.getBoundingClientRect().top - box.top;
  return {
    top: Math.round(Math.max(0, top)),
    past: Math.round(Math.max(0, -top)),
    finger: finger.count,
    fy: Math.round(Math.max(0, finger.y)),
    spare: Math.round(Math.max(0, state.spare)),
    hold: Math.round(Math.abs(internals._holdOffset ?? 0)),
    above,
    band: Math.round(Math.abs(bandAt)),
    band_up: bandAt < 0 ? 1 : 0,
    waiting: state.waiting,
    load: state.load,
    older: state.older ? 1 : 0,
    shown: state.shown,
    read: state.read,
    windows: state.windows,
    moving: state.moving ? 1 : 0,
    rests: state.rests,
    over: internals._reportedOverscroll === true ? 1 : 0,
  };
}

/**
 * Reports the reader held up at the transcript's top, where a swipe stops though earlier messages remain above and goes
 * on only after a pause: the view at its top with more above it (older entries in the file, read ones waiting, a held
 * correction, rows drawn above the top), or a finger dragging toward older messages while the view does not move. While
 * the reader touches or scrolls the transcript its state is sampled every `TOP_SAMPLE_MS`. When a stall ends, or has
 * lasted `TOP_CAP_MS`, one report carries the samples from `TOP_BEFORE_MS` before it (`s<n>_t` from the first sample,
 * then only the values that changed since the sample before), when it began (`stall_at_ms`), how long it lasted, its
 * kind (1 at the top, 2 a drag the view did not follow), how it ended (`end`: 1 the view could go on, 2 the chat's
 * beginning, 3 still held at the cap) and TanStack's numbers then (`at_`). `on`: an iPhone's or an iPad's transcript,
 * where the spare room is kept.
 */
export function useTopTrace(
  scrollRef: RefObject<HTMLElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
  state: RefObject<() => TopState>,
  on: boolean,
): void {
  useEffect(() => {
    const element = scrollRef.current;
    if (!on || element === null) return;
    const finger = { count: 0, y: 0 };
    let activeUntil = Number.NEGATIVE_INFINITY;
    const wake = (): void => {
      activeUntil = performance.now() + TOP_ACTIVE_MS;
    };
    const touched = (event: TouchEvent): void => {
      finger.count = event.touches.length;
      const first = event.touches[0];
      if (first !== undefined) finger.y = first.clientY;
      wake();
    };
    const kept: { readonly at: number; readonly values: TopSample }[] = [];
    let stall: { readonly since: number; readonly kind: number; reported: boolean } | null = null;
    const send = (since: number, kind: number, end: number, now: number): void => {
      const report = sink;
      if (report === null || topReports >= TOP_MOST || now - lastTopReport < TOP_APART_MS) return;
      topReports += 1;
      lastTopReport = now;
      const samples = kept.filter((sample) => sample.at >= since - TOP_BEFORE_MS);
      const first = samples[0]?.at ?? since;
      const marks: Record<string, number> = {
        ...layout(element, instance, "at_"),
        kind,
        end,
        stall_ms: Math.round(now - since),
        stall_at_ms: Math.round(Math.max(0, since - first)),
        samples: samples.length,
        sample_ms: TOP_SAMPLE_MS,
      };
      let previous: TopSample | null = null;
      for (const [index, sample] of samples.entries()) {
        marks[`s${index}_t`] = Math.round(sample.at - first);
        for (const [name, value] of Object.entries(sample.values))
          if (previous === null || previous[name] !== value) marks[`s${index}_${name}`] = value;
        previous = sample.values;
      }
      report({ marks, gaps: [], supported: ["top-stall", ...clientTags()] });
    };
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now > activeUntil && stall === null) return;
      const values = topSample(element, instance, state.current(), finger);
      kept.push({ at: now, values });
      while (now - (kept[0]?.at ?? now) > TOP_BEFORE_MS + TOP_CAP_MS) kept.shift();
      // More above the view: older entries in the file, read ones waiting, a held correction, rows drawn above the top.
      const moreAbove =
        values.older === 1 ||
        (values.waiting ?? 0) > 0 ||
        (values.hold ?? 0) > 0 ||
        (values.above ?? 0) > 0;
      const atTop = element.scrollTop <= 0.5 && moreAbove;
      // The oldest sample within the drag window: a finger that went toward older messages since, with the view still.
      const back = kept.find((sample) => now - sample.at <= TOP_DRAG_MS);
      const dragged =
        back !== undefined &&
        back !== kept.at(-1) &&
        (back.values.finger ?? 0) > 0 &&
        (values.finger ?? 0) > 0 &&
        (values.fy ?? 0) - (back.values.fy ?? 0) >= TOP_DRAG_PX &&
        (back.values.top ?? 0) - (values.top ?? 0) < TOP_DRAG_MOVED_PX &&
        (values.top ?? 0) > 0;
      if (atTop || dragged) {
        if (stall === null) stall = { since: now, kind: atTop ? 1 : 2, reported: false };
        else if (!stall.reported && now - stall.since >= TOP_CAP_MS) {
          send(stall.since, stall.kind, 3, now);
          stall.reported = true;
        }
        return;
      }
      if (stall !== null && !stall.reported && now - stall.since >= TOP_MIN_STALL_MS)
        send(stall.since, stall.kind, values.older === 0 && values.waiting === 0 ? 2 : 1, now);
      stall = null;
    }, TOP_SAMPLE_MS);
    const listening = { capture: true, passive: true } as const;
    element.addEventListener("touchstart", touched, listening);
    element.addEventListener("touchmove", touched, listening);
    element.addEventListener("touchend", touched, listening);
    element.addEventListener("touchcancel", touched, listening);
    element.addEventListener("scroll", wake, listening);
    return () => {
      window.clearInterval(timer);
      element.removeEventListener("touchstart", touched, { capture: true });
      element.removeEventListener("touchmove", touched, { capture: true });
      element.removeEventListener("touchend", touched, { capture: true });
      element.removeEventListener("touchcancel", touched, { capture: true });
      element.removeEventListener("scroll", wake, { capture: true });
    };
  }, [scrollRef, instance, state, on]);
}

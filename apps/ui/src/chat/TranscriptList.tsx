import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import {
  elementScroll,
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { ArrowDown, LoaderCircle } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { LiteContext } from "../lite/LiteContext";
import { useFollowTrace, useHoldTrace } from "../perf/followTrace";
import { noteScrollWrite } from "../perf/scrollTrace";
import { usePhone } from "../phone";
import { ToolCard } from "../vendor/collab-web/components/transcript/ToolCard";
import {
  AssistantBody,
  EntryRow,
  Row,
} from "../vendor/collab-web/components/transcript/Transcript";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import type { ToolRenderHost } from "../vendor/collab-web/tool-render/types";
import { FailureRow } from "./FailureRow";
import { MessageActions, userText } from "./MessageActions";
import { buildRows, type TranscriptRow, toolResults } from "./rows";
import { NoticeRow, ShellBlock } from "./ShellBlock";
import type { ChatSnapshot } from "./store";

/**
 * A first guess at a row's height; every row is measured once drawn. A guess too large is harmless at the end, where the
 * view stops at the real end; one too small leaves the view short of it, as near the end counts as at it (`AT_END_PX`).
 */
const ESTIMATED_ROW_PX = 72;

/** The mean height of the rows measured so far, or nothing before any is. */
function meanHeight(
  rows: readonly TranscriptRow[],
  sizes: ReadonlyMap<unknown, number>,
): number | undefined {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const size = sizes.get(row.key);
    if (size === undefined) continue;
    total += size;
    count += 1;
  }
  return count === 0 ? undefined : Math.round(total / count);
}

/**
 * The height a row not measured yet starts at, kept until it is measured. A reply's saved entry takes its stream's place
 * with the same text, and drawn at the guess for a frame it moved the view (211 px short at the end of a reply): it
 * starts at the stream's measured height instead. A row of an older window put in front starts at the mean height of
 * the rows measured, so that it takes about the room it will be drawn in (`spareFor`); its guess stays its own, as one
 * that changed would move the rows below it. Any other row starts at the guess. `measured` is TanStack's size cache as
 * of the last render, which still holds the stream.
 */
function useFirstHeights(
  rows: readonly TranscriptRow[],
  measured: RefObject<ReadonlyMap<unknown, number>>,
): (index: number) => number {
  const last = useRef<{
    rows: readonly TranscriptRow[];
    placed: readonly Pick<TranscriptRow, "key" | "kind">[];
  } | null>(null);
  const inherited = useRef(new Map<string, number>());
  if (last.current?.rows !== rows) {
    const before = last.current?.placed ?? [];
    const now = new Set(rows.map((row) => row.key));
    rows.forEach((row, index) => {
      const was = before[index];
      if (was?.kind !== "stream" || row.kind !== "entry" || now.has(was.key)) return;
      if (measured.current.has(row.key)) return;
      const size = measured.current.get(was.key);
      if (size !== undefined) inherited.current.set(row.key, size);
    });
    const oldFirst = before[0]?.key;
    const at = oldFirst === undefined ? -1 : rows.findIndex((row) => row.key === oldFirst);
    const mean = at > 0 ? meanHeight(rows, measured.current) : undefined;
    if (mean !== undefined)
      for (const row of rows.slice(0, at))
        if (!measured.current.has(row.key)) inherited.current.set(row.key, mean);
    for (const key of [...inherited.current.keys()])
      if (!now.has(key) || measured.current.has(key)) inherited.current.delete(key);
    last.current = { rows, placed: rows.map(({ key, kind }) => ({ key, kind })) };
  }
  return (index) => {
    const row = rows[index];
    return (row === undefined ? undefined : inherited.current.get(row.key)) ?? ESTIMATED_ROW_PX;
  };
}

/**
 * Which resized rows move the scroll position with them, so that the line being read stays where it is. TanStack's
 * rule, read against the layout as it is now:
 * - A row measured for the first time moves it when the row starts above the top of the view: its estimate was wrong
 *   above the line being read. That includes a row across the top edge: older entries that land while the first row is
 *   read put a new row in the space above it, and its height pushed the first row down by the difference (165 px).
 * - A row measured again moves it only when it lies wholly above the view, and not while the reader scrolls up: a row
 *   across the top edge changed below the part being read.
 *
 * TanStack reads the row's place from a cache that an earlier row in the same batch of measurements may have made stale
 * (its correction moved the scroll position and the rows after it), which moved the line read by 332 px in WebKit.
 * Here `getVirtualItems()` rebuilds the places first; `measurementsCache` then holds the layout's places, as
 * `scrollOffset` is one (the drawn places differ while a correction is held: each row shifted back by the held amount).
 */
function movesView(
  item: VirtualItem,
  _delta: number,
  instance: Virtualizer<HTMLDivElement, Element>,
): boolean {
  instance.getVirtualItems();
  const row = instance.measurementsCache[item.index] ?? item;
  const top = instance.scrollOffset ?? 0;
  if (!instance.itemSizeCache.has(item.key)) return row.start < top;
  return row.end <= top && instance.scrollDirection !== "backward";
}

/** How near the end still counts as at the end: the list then follows new output. */
const AT_END_PX = 80;

/** The band at the top of a chat's transcript: Loading earlier messages, Try again, or the chat's beginning. */
const EDGE_PX = 44;

/**
 * How far from the top, in screens, the next older window is read: a fling on a phone reaches the top in a moment, and
 * the window is there by then.
 */
const NEAR_TOP_SCREENS = 2;

/** The day a chat began, under its first entry. */
const START_DATE = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Keys that scroll the transcript when it has the focus: WebKit animates them, as it does the wheel. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** How long a wheel or a scroll key may go without scrolling before it counts as one at an edge, which moves nothing. */
const NO_SCROLL_MS = 150;

/**
 * Holds the list's position corrections while the reader scrolls with the wheel or the keys, and writes them once the
 * scroll has ended. A correction (for a row above the view measured for the first time) is a `scrollTop` write, and
 * WebKit stops a running scroll animation at such a write (`ScrollAnimator::scrollToPositionWithoutAnimation`): a wheel
 * step in the desktop window fell short by up to two thirds whenever a row above was measured. TanStack already holds
 * corrections while a write cannot land (`_canWriteScroll`, for a touch on iOS): it shows the rows shifted back by the
 * amount held, so the line being read stays put, and writes the whole amount in one paint once a write can land. The
 * reader's own scroll is one of those times here; the list's own writes (following new output, jumping to the end) are
 * not, and neither is a scroll that already ended. A wheel at an edge scrolls nothing: the hold ends after
 * `NO_SCROLL_MS`, and a render writes what it held. The hook is TanStack's own; should a new version drop it, the page
 * says so in the console (which fails every end-to-end spec) and scrolls as it did before.
 */
function useHoldCorrectionsWhileReading(
  scrollRef: RefObject<HTMLDivElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): RefObject<boolean> {
  const [, render] = useReducer((count: number) => count + 1, 0);
  /** The hold, as the follow trace reads it. */
  const holding = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const internals = instance as unknown as { _canWriteScroll?: () => boolean };
    const canWrite = internals._canWriteScroll;
    if (typeof canWrite !== "function") {
      console.error(
        "TanStack Virtual has no _canWriteScroll: the transcript writes its corrections during scrolls again.",
      );
      return;
    }
    /** The reader's wheel or key started a scroll that has not ended yet. */
    let reading = false;
    const setReading = (value: boolean): void => {
      reading = value;
      holding.current = value;
    };
    /** The element scrolled since that wheel or key. */
    let moved = false;
    let idle = 0;
    const input = (): void => {
      setReading(true);
      moved = false;
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (!reading || moved) return;
        setReading(false);
        render();
      }, NO_SCROLL_MS);
    };
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea") !== null)
      )
        return;
      if (SCROLL_KEYS.has(event.key)) input();
    };
    const onScroll = (): void => {
      if (reading) moved = true;
    };
    element.addEventListener("wheel", input, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("scroll", onScroll, { passive: true });
    // TanStack asks before every correction and flush; a scroll that moved and then ended ends the hold.
    internals._canWriteScroll = () => {
      if (reading && moved && !instance.isScrolling) setReading(false);
      return canWrite() && !reading;
    };
    return () => {
      window.clearTimeout(idle);
      setReading(false);
      element.removeEventListener("wheel", input);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("scroll", onScroll);
      internals._canWriteScroll = canWrite;
    };
  }, [scrollRef, instance]);
  return holding;
}

/**
 * Keeps a reader who is at the end at the end when the list gets shorter (the working row and the box grow as the chat
 * goes live): the list follows output that grows, not a view that shrinks.
 */
function useStayAtEndWhenShorter(
  scrollRef: RefObject<HTMLDivElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): void {
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const before = height;
      height = element.clientHeight;
      if (height >= before) return;
      if (element.scrollHeight - element.scrollTop - before <= AT_END_PX) instance.scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, instance]);
}

/**
 * How long the transcript goes without a touch, a wheel or a scroll before it counts as at rest. Longer than the 150 ms
 * TanStack waits after a touch's last scroll event, so its touch gesture has ended too and a write can land.
 */
const REST_MS = 250;

/**
 * Follows the reader's scroll. `moving` while a finger is on the transcript, a touch, a wheel or a scroll came less than
 * `REST_MS` ago, the position still changes (the end of a glide can move less than a pixel a frame with no scroll event
 * for a while), or it is past an edge (a bounce that has not settled). Once the scroll rests, `atRest` runs and the
 * transcript is drawn again.
 */
function useReaderRest(
  scrollRef: RefObject<HTMLDivElement | null>,
  atRest: RefObject<() => void>,
): RefObject<boolean> {
  const [, rest] = useReducer((count: number) => count + 1, 0);
  const moving = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let fingers = 0;
    let last = Number.NEGATIVE_INFINITY;
    let top = element.scrollTop;
    let timer = 0;
    const moved = (): void => {
      last = performance.now();
      top = element.scrollTop;
      moving.current = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(check, REST_MS);
    };
    const check = (): void => {
      if (fingers > 0) return;
      const now = element.scrollTop;
      const pastEdge = now < 0 || now > element.scrollHeight - element.clientHeight + 1;
      if (pastEdge || Math.abs(now - top) >= 1) {
        moved();
        return;
      }
      const quiet = performance.now() - last;
      if (quiet < REST_MS) {
        timer = window.setTimeout(check, REST_MS - quiet);
        return;
      }
      moving.current = false;
      atRest.current();
      rest();
    };
    const touched = (event: TouchEvent): void => {
      fingers = event.touches.length;
      moved();
    };
    const listening = { capture: true, passive: true } as const;
    element.addEventListener("touchstart", touched, listening);
    element.addEventListener("touchend", touched, listening);
    element.addEventListener("touchcancel", touched, listening);
    element.addEventListener("wheel", moved, listening);
    element.addEventListener("scroll", moved, listening);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("touchstart", touched, { capture: true });
      element.removeEventListener("touchend", touched, { capture: true });
      element.removeEventListener("touchcancel", touched, { capture: true });
      element.removeEventListener("wheel", moved, { capture: true });
      element.removeEventListener("scroll", moved, { capture: true });
    };
  }, [scrollRef, atRest]);
  return moving;
}

/**
 * Spare room kept above the first row on an iPhone or an iPad. iOS ignores a scroll position written under a finger, a
 * glide overrides one written while it runs, and a bounce drops it, so rows put in or measured above the line being read
 * could only be kept where they were by a write held until the scroll rested; the rows stayed drawn above the
 * transcript's top meanwhile, out of reach, and a fast swipe up stopped there until the reader paused. With spare room
 * above, they go into it: the list's top padding gives way by as much as they take, nothing below moves, and no position
 * is written. Once the scroll rests the spare room is set again with one write, which lands. Its size is what can still
 * come before the next rest (`spareFor`): the next two older windows, each as tall as the windows read so far, and what
 * the rows not measured yet will grow by, with a quarter more for rows taller than the mean. Once the chat's beginning
 * is read, only the growth is left.
 */
function spareFor(
  rows: readonly TranscriptRow[],
  sizes: ReadonlyMap<unknown, number>,
  firstHeight: (index: number) => number,
  hasOlder: boolean,
  windows: number,
): number {
  let measuredPx = 0;
  let measuredRows = 0;
  let guessedPx = 0;
  let guessedRows = 0;
  rows.forEach((row, index) => {
    const size = sizes.get(row.key);
    if (size === undefined) {
      guessedPx += firstHeight(index);
      guessedRows += 1;
    } else {
      measuredPx += size;
      measuredRows += 1;
    }
  });
  // A row not measured yet grows to the mean of the rows measured, and to a typical row's height before any is.
  const mean = measuredRows === 0 ? TYPICAL_ROW_PX : measuredPx / measuredRows;
  const growth = Math.max(0, mean * guessedRows - guessedPx);
  if (!hasOlder) return Math.round(growth);
  const perWindow = (mean * rows.length) / Math.max(1, windows);
  return Math.round(SPARE_WINDOWS * perWindow + 1.25 * growth);
}

/** How many older windows the spare room takes before the next rest: a long swipe up reads one after another. */
const SPARE_WINDOWS = 2;

/** A row's height before any row of the chat has been measured: the app's traces showed means of 110 to 180 px a row. */
const TYPICAL_ROW_PX = 160;

/** A change of the wanted spare room smaller than this waits for a bigger one: each change is a write at rest. */
const SPARE_DRIFT_PX = 500;

/** iOS's WebKit, as TanStack Virtual tells it: an iPhone or an iPod, or an iPad (a Mac with a touch screen). */
function iosWebKit(): boolean {
  return (
    /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 0)
  );
}

/** TanStack Virtual 3.19.9's record that the last position it read was past an edge (a bounce). */
interface BounceInternals {
  _reportedOverscroll?: unknown;
}

/**
 * Tells TanStack the bounce is over once the transcript rests within its bounds. TanStack reads the position only at
 * scroll events and once more 150 ms after the last of them, and writes nothing while that read was past an edge, since
 * WebKit drops a write during a bounce. On an iPhone the end of a bounce at the top could settle after both reads, with
 * no event: TanStack kept the read past the top, and a correction it held during the swipe (rows measured above,
 * earlier messages put in) was never written. The rows above stayed drawn above the top, seen in each new bounce and out
 * of reach, until a scroll down sent a new event or the chat was opened again. The draw that follows writes it.
 */
function settleBounce(
  element: HTMLElement | null,
  instance: Virtualizer<HTMLDivElement, Element>,
): void {
  const internals = instance as unknown as BounceInternals;
  if (element === null || internals._reportedOverscroll !== true) return;
  const top = element.scrollTop;
  if (top >= 0 && top <= element.scrollHeight - element.clientHeight + 1)
    internals._reportedOverscroll = false;
}

/** How long after the reader's wheel, touch, scroll key or scrollbar press a scroll still counts as the reader's. */
const READER_SCROLL_MS = 1_000;

/**
 * Keeps a reader who follows the latest output at the end (#2778). Following is the reader's own choice: it changes
 * only with a scroll the reader makes (a wheel, a touch, a scroll key, the scrollbar), off when it leaves the end and on
 * when it comes back, and with Jump to latest. TanStack's own following decides from how far the view is from the end
 * at the moment output arrives, and that distance is wrong while rows grew and their new height is not measured yet: in
 * the desktop window, without the focus, the view was left 100 to 240 px short for good, with no input. So after every
 * render, a reader who follows and is not at the end itself is taken there, unless the reader's own scroll is under
 * way. Near the end (`AT_END_PX`) decides only whether a reader's scroll follows: a view short of the end
 * by less stayed short for a whole reply (30 px, when a message's copy shown as it was sent and the working line gave
 * way to omp's copy and the reply in one render, which TanStack does not take for new output). Returns `follow`, which
 * starts following (Jump to latest), whether the reader follows, for the trace, and the same as state, for Jump to
 * latest: it is offered only to a reader who does not follow (#2821).
 */
function useFollowLatest(
  scrollRef: RefObject<HTMLDivElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): {
  readonly follow: () => void;
  readonly following: RefObject<boolean>;
  readonly follows: boolean;
} {
  const following = useRef(true);
  // While a reader follows, output arriving leaves the end for one render, and the view is taken back after it.
  const [follows, setFollows] = useState(true);
  const lastReader = useRef(Number.NEGATIVE_INFINITY);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const input = (): void => {
      lastReader.current = performance.now();
    };
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea") !== null)
      )
        return;
      if (SCROLL_KEYS.has(event.key)) input();
    };
    // A press on the scrollbar (outside the content box) can drag the view; a press on the content cannot.
    const onPointer = (event: PointerEvent): void => {
      if (event.offsetX > element.clientWidth || event.offsetY > element.clientHeight) input();
    };
    // A scroll soon after the reader's input is the reader's, and so is the rest of that scroll (a fling glides on).
    const onScroll = (): void => {
      if (performance.now() - lastReader.current > READER_SCROLL_MS) return;
      lastReader.current = performance.now();
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END_PX;
      setFollows(following.current);
    };
    const passive = { passive: true } as const;
    element.addEventListener("wheel", input, passive);
    element.addEventListener("touchstart", input, passive);
    element.addEventListener("touchmove", input, passive);
    element.addEventListener("keydown", onKey);
    element.addEventListener("pointerdown", onPointer, passive);
    element.addEventListener("scroll", onScroll, passive);
    return () => {
      element.removeEventListener("wheel", input);
      element.removeEventListener("touchstart", input);
      element.removeEventListener("touchmove", input);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("pointerdown", onPointer);
      element.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef]);

  // After every render: rows added or measured, the box resized, a scroll ended.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!following.current || element === null) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 1) return;
    if (performance.now() - lastReader.current < READER_SCROLL_MS) return;
    instance.scrollToEnd();
  });

  const follow = (): void => {
    following.current = true;
    setFollows(true);
  };
  return { follow, following, follows };
}

/**
 * The transcript as a virtual list in TanStack Virtual's chat mode (https://tanstack.com/virtual/latest/docs/chat.md):
 * anchored to the end, it follows new output only while the reader is at the end, keeps the reader's place when older
 * entries are added on top, and draws only the rows on screen. The rows are collab-web's.
 */
export function TranscriptList({
  snapshot,
  onNearTop,
  actions,
  welcome,
  host,
  label = "Transcript",
  edge = false,
}: {
  readonly snapshot: ChatSnapshot;
  /** Reads the next older window (the chat's `loadOlder`); also Try again's. */
  readonly onNearTop: () => void;
  readonly actions: RowActions;
  /**
   * A new chat's greeting while it is empty, and what a suggestion row does when picked (the lite view's, #2845); null
   * for a saved chat, which shows its entries as they load.
   */
  readonly welcome: { readonly folder: string; readonly onSuggest: (text: string) => void } | null;
  /** What the tool cards may open (a task card's subagents, in the Agent Hub). */
  readonly host?: ToolRenderHost;
  /** The list's name for a screen reader. */
  readonly label?: string;
  /**
   * A chat's transcript shows its top: Loading earlier messages while older entries are left to read, Try again once
   * a read of them failed, and the chat's beginning once its first entry is shown. An agent's log does not.
   */
  readonly edge?: boolean;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { stream, streamDone, activeTools, jobs, working, olderLoad, shell } = snapshot;
  /** What the transcript does once the reader's scroll rests; set below, once the list exists. */
  const atRest = useRef<() => void>(() => undefined);
  const moving = useReaderRest(scrollRef, atRest);
  const { entries, hasOlder } = snapshot;
  // The lite view (#2844) leaves out omp's status lines: at each start they list the tools it mounted, which would fill
  // an empty chat in a side panel. A warning or an error stays.
  const lite = use(LiteContext) !== null;
  const notices = useMemo(
    () =>
      lite ? snapshot.notices.filter((notice) => notice.level !== "status") : snapshot.notices,
    [lite, snapshot.notices],
  );
  const rows = useMemo(
    () =>
      buildRows({ entries, stream, streamDone, activeTools, working, shell, notices, hasOlder }),
    [entries, stream, streamDone, activeTools, working, shell, notices, hasOlder],
  );
  const results = useMemo(() => toolResults(entries, jobs), [entries, jobs]);
  const measured = useRef<ReadonlyMap<unknown, number>>(new Map());
  const firstHeight = useFirstHeights(rows, measured);
  // A phone's screen is small: the chat starts right under its top bar (each row keeps its own 10 px).
  const phone = usePhone();
  // The room above the first row: a computer's 24 px, and a chat's top band.
  const headRoom = (phone ? 0 : 24) + (edge && rows.length > 0 ? EDGE_PX : 0);
  // The spare room above the first row (`spareFor`): on iOS, in a chat's transcript. Read at rest with the sizes measured
  // since this draw.
  const ios = useMemo(iosWebKit, []);
  const spare = useRef(0);
  /** The windows of entries read so far: the first, and each older one put in front. */
  const windows = useRef(0);
  const spareWanted = (sizes: ReadonlyMap<unknown, number>): number =>
    ios && edge ? spareFor(rows, sizes, firstHeight, hasOlder, windows.current) : 0;
  const wanted = useRef(spareWanted);
  wanted.current = spareWanted;
  // Older rows put in front take spare room in place of a scroll position: the rows already drawn keep their places.
  // A chat opens with none: the first rest, after its move to the end, sets it with one write once the rows in view are
  // measured, so a chat shorter than the screen (which never scrolls, so never rests) keeps its first row at the top.
  const front = useRef<string | undefined>(undefined);
  const firstKey = rows[0]?.key;
  if (firstKey !== front.current) {
    const at =
      front.current === undefined ? -1 : rows.findIndex((row) => row.key === front.current);
    if (front.current === undefined) windows.current = 1;
    else if (at > 0) {
      windows.current += 1;
      let added = 0;
      for (let index = 0; index < at; index += 1)
        added += measured.current.get(rows[index]?.key) ?? firstHeight(index);
      spare.current -= Math.min(spare.current, added);
    }
    front.current = firstKey;
  }
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: firstHeight,
    getItemKey: (index) => rows[index]?.key ?? index,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: AT_END_PX,
    overscan: 6,
    paddingStart: headRoom + spare.current,
    paddingEnd: 16,
    // Each write is noted for the scroll trace, which tells a jump the list wrote from one the browser made.
    scrollToFn: (offset, options, instance) => {
      const from = instance.scrollElement?.scrollTop ?? offset;
      noteScrollWrite(offset + (options.adjustments ?? 0) - from);
      elementScroll(offset, options, instance);
    },
  });
  // During the reader's scroll, a row measured above the view takes spare room too, while some is left.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    if (!movesView(item, delta, instance)) return false;
    if (spare.current <= 0 || !moving.current || delta > spare.current) return true;
    spare.current -= delta;
    instance.options.paddingStart = headRoom + spare.current;
    return false;
  };
  measured.current = virtualizer.itemSizeCache;
  atRest.current = () => {
    const element = scrollRef.current;
    if (element === null) return;
    const held = (): number =>
      (virtualizer as unknown as { _holdOffset?: number })._holdOffset ?? 0;
    // A correction held during the swipe is written first: `settleBounce`, then the draw's `_willUpdate`.
    settleBounce(element, virtualizer);
    if (held() !== 0) flushSync(redraw);
    // The spare room set again (or taken away once the chat's beginning is shown and every row above is measured):
    // every row moves by the same amount and the scroll position with them, in one paint. A small drift waits.
    const target = wanted.current(virtualizer.itemSizeCache);
    const change = target - spare.current;
    if (change === 0 || (target !== 0 && Math.abs(change) < SPARE_DRIFT_PX) || held() !== 0) return;
    spare.current += change;
    virtualizer.scrollOffset = Math.max(0, (virtualizer.scrollOffset ?? 0) + change);
    flushSync(redraw);
    noteScrollWrite(change);
    element.scrollTop += change;
  };
  useLayoutEffect(() => {
    if (typeof (virtualizer as unknown as BounceInternals)._reportedOverscroll !== "boolean")
      console.error(
        "TanStack Virtual has no _reportedOverscroll: a bounce at the top can leave the rows above out of reach again.",
      );
  }, [virtualizer]);
  const holding = useHoldCorrectionsWhileReading(scrollRef, virtualizer);
  useStayAtEndWhenShorter(scrollRef, virtualizer);
  const { follow, following, follows } = useFollowLatest(scrollRef, virtualizer);
  const atEnd = virtualizer.isAtEnd();
  useFollowTrace(scrollRef, virtualizer, {
    atEnd,
    rows: rows.length,
    working,
    holding,
    following,
  });
  useHoldTrace(scrollRef, virtualizer);

  // Start at the latest entry once the first window is there.
  const empty = rows.length === 0;
  useLayoutEffect(() => {
    if (!empty) virtualizer.scrollToEnd();
  }, [virtualizer, empty]);
  // The render that first shows a window is drawn from the top, before the list has moved to the latest entry: its
  // first rows are not the reader near the top, and taking them so read 1 MB of older entries on every open (#2768). One
  // frame on, the move's scroll event has come (a frame's scroll events run before its animation frames).
  const [positioned, setPositioned] = useState(false);
  useEffect(() => {
    if (empty) return;
    const frame = requestAnimationFrame(() => setPositioned(true));
    return () => cancelAnimationFrame(frame);
  }, [empty]);

  const items = virtualizer.getVirtualItems();
  // Older entries are read while the reader is within two screens of the top, again after each window read, so a
  // window shorter than that fills the screen from older entries once positioned. A read that failed waits for Try again
  // or for the link to come back (the chat's `loadOlder`).
  const offset = virtualizer.scrollOffset;
  const screen = scrollRef.current?.clientHeight ?? 0;
  // Measured from the first row: the spare room above it is not content.
  const nearTop =
    positioned && offset !== null && offset - spare.current < NEAR_TOP_SCREENS * screen;
  const oldestKey = rows[0]?.key;
  useEffect(() => {
    if (nearTop && hasOlder && olderLoad === "idle" && oldestKey !== undefined) onNearTop();
  }, [nearTop, hasOlder, olderLoad, oldestKey, onNearTop]);
  const firstAt = entries[0]?.timestamp;
  const began = firstAt === undefined ? null : new Date(firstAt);

  return (
    // At least a quarter of the chat stays the conversation's, under questions or an approval too (#2795). A chat
    // too short for that, a quarter and the message box and a question's choices (a phone held sideways, a window about
    // 400 px high), keeps 20rem for the message box and the question instead, so their choices stay in view (#2807).
    <div className="relative min-h-[min(25%,max(0px,calc(100%_-_20rem)))] flex-1">
      <section
        ref={scrollRef}
        className="tr-root tl-scroll"
        aria-label={label}
        data-tour={edge ? "transcript" : undefined}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {edge && rows.length > 0 && (
            <div
              className="absolute top-0 left-0 flex w-full items-center justify-center gap-2 px-3 text-t3 text-xs"
              // Drawn from the first row's place: while a correction is held the rows are drawn shifted back by it
              // (`useHoldCorrectionsWhileReading`), and the band stays above the first row.
              style={{
                height: EDGE_PX,
                transform: `translateY(${items[0]?.index === 0 ? items[0].start - headRoom : 0}px)`,
              }}
              data-transcript-edge={hasOlder ? olderLoad : "start"}
            >
              {!hasOlder ? (
                <span>
                  Beginning of the chat
                  {began !== null && !Number.isNaN(began.getTime())
                    ? ` · ${START_DATE.format(began)}`
                    : ""}
                </span>
              ) : olderLoad === "failed" ? (
                <>
                  <span>Couldn't load earlier messages.</span>
                  <Button size="sm" variant="secondary" className="max-sm:h-11" onClick={onNearTop}>
                    Try again
                  </Button>
                </>
              ) : (
                <>
                  <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                  <span>Loading earlier messages…</span>
                </>
              )}
            </div>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                // The row's own key, which a prepend does not shift: the scroll trace follows a row by it.
                data-key={String(item.key)}
                // What the row is: the scroll trace names a row that grows or shrinks by it.
                data-kind={row.kind}
                className="tl-item group/msg absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <RowView
                  row={row}
                  results={results}
                  active={activeTools}
                  actions={actions}
                  host={host}
                />
              </div>
            );
          })}
        </div>
      </section>
      {empty && welcome !== null && (
        <Welcome folder={welcome.folder} onSuggest={welcome.onSuggest} />
      )}
      {!empty && !atEnd && !follows && (
        // Only for a reader who left the end; on a phone a round button in the corner, clear of the text being read.
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-l2 px-3 shadow-md max-sm:right-3 max-sm:left-auto max-sm:size-11 max-sm:translate-x-0 max-sm:px-0"
          aria-label="Jump to latest"
          onClick={() => {
            follow();
            // At once, not smooth: during a smooth scroll TanStack measures only the rows near its end and drops the
            // others' sizes, so a row drawn on the way kept the estimated height for good, drawn over the next row or
            // apart from it (#2839).
            virtualizer.scrollToEnd();
          }}
        >
          <ArrowDown />
          <span className="max-sm:sr-only">Jump to latest</span>
        </Button>
      )}
    </div>
  );
}

/** The end of a folder's path, which names it: `…/projects/omp-app` for a long one. */
function folderTail(folder: string): string {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts.length <= 2 ? folder : `…/${parts.slice(-2).join("/")}`;
}

/** The greeting of an empty chat where the framing app sets none. */
const GREETING = "What are we working on?";

/**
 * A new chat's first screen: where omp will work, and the keys of the message box (a phone's return key adds a line).
 * In the lite view, another app's assistant (#2845), the framing app's greeting and suggestions instead.
 */
function Welcome({
  folder,
  onSuggest,
}: {
  readonly folder: string;
  readonly onSuggest: (text: string) => void;
}): ReactNode {
  const phone = usePhone();
  const lite = use(LiteContext);
  if (lite !== null)
    return (
      <LiteWelcome
        greeting={lite.greeting ?? GREETING}
        suggestions={lite.suggestions}
        onSuggest={onSuggest}
      />
    );
  const keys: readonly (readonly [string, string])[] = [
    ["/", "commands"],
    ["@", "files"],
    ["!", "shell"],
    ...(phone ? [] : ([["Enter", "send"]] as const)),
  ];
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-9 opacity-90" />
      <p className="text-base font-medium text-t1">{GREETING}</p>
      <p className="max-w-full truncate font-mono text-xs text-t3">{folderTail(folder)}</p>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-t3">
        {keys.map(([key, label]) => (
          <li key={key}>
            <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px] text-t2">
              {key}
            </kbd>{" "}
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The lite view's empty chat (#2845): the framing app's greeting, at its text size, and the suggestions it passed as
 * rows; a row picked is sent as the message. No folder and no keys: there it is that app's assistant, not a terminal.
 */
function LiteWelcome({
  greeting,
  suggestions,
  onSuggest,
}: {
  readonly greeting: string;
  readonly suggestions: readonly string[];
  readonly onSuggest: (text: string) => void;
}): ReactNode {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-9 opacity-90" />
      <p className="text-[length:calc(var(--host-text-size,14px)*8/7)] font-medium text-t1">
        {greeting}
      </p>
      {suggestions.length > 0 && (
        <ul
          aria-label="Suggestions"
          className="pointer-events-auto flex w-full max-w-80 flex-col gap-1.5"
        >
          {suggestions.map((text) => (
            <li key={text}>
              <button
                type="button"
                className="w-full rounded-lg border border-l2 bg-card px-3 py-2 text-left text-[length:var(--host-text-size,14px)] text-t1 outline-none hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSuggest(text)}
              >
                {text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What rows offer: a failed request's Retry, Switch model and the app's own continue after a usage limit, stopping a `!`
 * command, dismissing a notice, and Edit on your messages (only while omp is idle).
 */
export interface RowActions {
  readonly onRetry: () => Promise<void>;
  /** When the app continues the chat by itself after a usage limit (#2781); null when it will not. */
  readonly continuesAt: number | null;
  /** "Don't continue": the chat stays stopped after its usage limit. */
  readonly onDontContinue: () => Promise<void>;
  readonly onSwitchModel: () => void;
  readonly onStopShell: () => Promise<void>;
  readonly onDismissNotice: (id: number) => void;
  /** A shared service's link in the chat was followed (#2788). */
  readonly onShareOpened: (shareId: string) => void;
  /**
   * A chat that could not open: open it afresh (Try again), or a new chat in its place. Absent where no chat opens (a
   * subagent's transcript).
   */
  readonly onReopen?: () => void;
  readonly onNewChat?: () => void;
  readonly onEdit: (entryId: string) => void;
  readonly canEdit: boolean;
}

function RowView({
  row,
  results,
  active,
  actions,
  host,
}: {
  readonly row: TranscriptRow;
  readonly results: ReadonlyMap<string, ToolResultMessage>;
  readonly active: ReadonlyMap<string, ActiveTool>;
  readonly actions: RowActions;
  readonly host: ToolRenderHost | undefined;
}): ReactNode {
  switch (row.kind) {
    case "entry": {
      const text = userText(row.entry);
      // A message read from the stream has no id of omp's until the file is read back after the turn.
      const editable = actions.canEdit && !row.entry.id.startsWith("live-");
      const { id } = row.entry;
      const message = <EntryRow entry={row.entry} results={results} active={active} host={host} />;
      return text === null ? (
        message
      ) : (
        <MessageActions text={text} onEdit={editable ? () => actions.onEdit(id) : null}>
          {message}
        </MessageActions>
      );
    }
    case "failure":
      return (
        <Row kind="assistant" gutter="">
          <FailureRow
            error={row.error}
            latest={row.latest}
            continuesAt={actions.continuesAt}
            onRetry={actions.onRetry}
            onSwitchModel={actions.onSwitchModel}
            onDontContinue={actions.onDontContinue}
          />
        </Row>
      );
    case "stream":
      return (
        <Row kind="assistant" gutter="agent">
          <AssistantBody
            message={row.message}
            results={results}
            active={active}
            pending={row.pending}
            host={host}
          />
        </Row>
      );
    case "tools":
      return (
        <Row kind="assistant" gutter={row.first ? "agent" : ""}>
          {row.tools.map((tool) => (
            <ToolCard
              key={tool.toolCallId}
              toolCallId={tool.toolCallId}
              name={tool.toolName}
              intent={tool.intent}
              args={tool.args}
              running
              partialResult={tool.partialResult}
              host={host}
            />
          ))}
        </Row>
      );
    case "working":
      return (
        <Row kind="assistant" gutter="agent">
          <div className="tr-shimmer">thinking…</div>
        </Row>
      );
    case "shell":
      return (
        <Row kind="assistant" gutter="">
          <ShellBlock run={row.run} onStop={actions.onStopShell} />
        </Row>
      );
    case "notice":
      return (
        <Row kind="assistant" gutter="">
          <NoticeRow
            notice={row.notice}
            onDismiss={actions.onDismissNotice}
            onShareOpened={actions.onShareOpened}
            onReopen={actions.onReopen}
            onNewChat={actions.onNewChat}
          />
        </Row>
      );
  }
}

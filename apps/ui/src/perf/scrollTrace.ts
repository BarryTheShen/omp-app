import type { ClientTraceReport } from "@omp-app/contracts";
import {
  biggestJumps,
  clientTags,
  frameMarks,
  runningAnimations,
  type ScrollFrame,
  scrollMoves,
  watchFrames,
} from "./frames";

/** A scroll has ended when no scroll event came for this long. */
const QUIET_MS = 300;
/** The longest one report watches; a longer scroll is reported as two. */
const LONGEST_MS = 4_000;
/** At most this many reports per page load, at least this far apart, so the log keeps a sample, not a stream. */
const MOST_REPORTS = 12;
const APART_MS = 5_000;
/** A scroll this short in frames or distance says nothing about how scrolling feels... */
const FEWEST_FRAMES = 10;
const LEAST_PX = 200;
/** ...unless the reader's input made it jump this far in one frame (a chat opening at its end jumps with none). */
const JUMP_PX = 600;
/** Inputs this long before a scroll's first event count as what started it. */
const LEAD_MS = 400;
/** How many of the largest one-frame jumps a report lists. */
const JUMPS = 3;
/** Keys that scroll the element with the focus. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** An input that can scroll the page: a wheel or touchpad step (its size in pixels), a scroll key, a scrollbar press. */
interface Input {
  readonly at: number;
  readonly kind: "wheel" | "key" | "bar";
  readonly px: number;
}

interface Gesture {
  readonly target: Element;
  readonly started: number;
  readonly frames: ScrollFrame[];
  readonly watch: ReturnType<typeof watchFrames>;
  /** Animations running when the gesture began. */
  readonly animationsAtStart: number;
  quiet: ReturnType<typeof setTimeout> | undefined;
}

/** The transcript row under the middle of the view, by its key, and where it is on screen. */
interface Anchor {
  readonly key: string;
  readonly top: number;
}

function middleRow(target: Element): Anchor | null {
  const box = target.getBoundingClientRect();
  const row = document
    .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    ?.closest<HTMLElement>("[data-key]");
  const key = row?.dataset.key;
  if (row === null || row === undefined || key === undefined || !target.contains(row)) return null;
  return { key, top: row.getBoundingClientRect().top };
}

/**
 * Measures how the page scrolls: for a sample of scroll gestures, how often it drew a frame, how long its longest
 * frames were, how far the scrolled element jumped between two frames, with the window's size and the engine; what
 * started the gesture (wheel steps and their size, scroll keys, a scrollbar press, or nothing: the app scrolled); and
 * for the largest one-frame jumps, how far the transcript's content moved on screen and how much it grew in that
 * frame, which tells a correction the reader never sees from the view jumping. `report` sends each to the server's
 * debug log. Returns the function that stops it.
 */
export function traceScrolling(report: (trace: ClientTraceReport) => void): () => void {
  let gesture: Gesture | null = null;
  let reports = 0;
  let lastReport = Number.NEGATIVE_INFINITY;
  /** The latest inputs, newest last. */
  const inputs: Input[] = [];
  const note = (input: Input): void => {
    inputs.push(input);
    if (inputs.length > 64) inputs.shift();
  };

  const finish = (): void => {
    const ended = gesture;
    if (ended === null) return;
    gesture = null;
    clearTimeout(ended.quiet);
    const stats = ended.watch.stop();
    const moves = scrollMoves(ended.frames.map((frame) => frame.top));
    const during = inputs.filter((input) => input.at >= ended.started - LEAD_MS);
    const felt = stats.frames >= FEWEST_FRAMES && moves.movedPx >= LEAST_PX;
    if (!felt && (moves.maxJumpPx < JUMP_PX || during.length === 0)) return;
    reports += 1;
    lastReport = performance.now();
    const inTranscript = ended.target.closest("section[aria-label='Transcript']") !== null;
    const wheels = during.filter((input) => input.kind === "wheel").map((input) => input.px);
    const jumps: Record<string, number> = {};
    biggestJumps(ended.frames, JUMPS).forEach((jump, index) => {
      const name = `jump${index + 1}`;
      jumps[`${name}_px`] = Math.abs(jump.movedPx);
      jumps[`${name}_up`] = jump.movedPx < 0 ? 1 : 0;
      jumps[`${name}_frame`] = jump.frame;
      if (jump.seenPx !== null) jumps[`${name}_seen_px`] = Math.abs(jump.seenPx);
      if (jump.grewPx !== 0)
        jumps[`${name}_${jump.grewPx > 0 ? "grew" : "shrank"}_px`] = Math.abs(jump.grewPx);
    });
    report({
      marks: {
        ...frameMarks(stats),
        scroll_ms: Math.round(performance.now() - ended.started),
        animations_start: ended.animationsAtStart,
        moved_px: moves.movedPx,
        max_jump_px: moves.maxJumpPx,
        still_frames: moves.stillFrames,
        wheel_events: wheels.length,
        ...(wheels.length > 0
          ? {
              wheel_px: Math.round(wheels.reduce((sum, px) => sum + px, 0)),
              wheel_min_px: Math.round(Math.min(...wheels) * 100) / 100,
              wheel_max_px: Math.round(Math.max(...wheels)),
            }
          : {}),
        keys: during.filter((input) => input.kind === "key").length,
        bar_presses: during.filter((input) => input.kind === "bar").length,
        ...jumps,
      },
      gaps: [...stats.longGaps],
      supported: ["scroll-frames", ...clientTags(), inTranscript ? "transcript" : "elsewhere"],
    });
  };

  const onScroll = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : document.scrollingElement;
    if (target === null) return;
    if (gesture !== null && gesture.target !== target) finish();
    if (gesture === null) {
      if (reports >= MOST_REPORTS || performance.now() - lastReport < APART_MS) return;
      const inTranscript = target.closest("section[aria-label='Transcript']") !== null;
      let anchor = inTranscript ? middleRow(target) : null;
      const frames: ScrollFrame[] = [
        { top: target.scrollTop, height: target.scrollHeight, seen: null },
      ];
      gesture = {
        target,
        started: performance.now(),
        frames,
        watch: watchFrames(() => {
          let seen: number | null = null;
          if (anchor !== null) {
            const row = target.querySelector<HTMLElement>(`[data-key="${CSS.escape(anchor.key)}"]`);
            if (row !== null) seen = anchor.top - row.getBoundingClientRect().top;
          }
          frames.push({ top: target.scrollTop, height: target.scrollHeight, seen });
          if (inTranscript) anchor = middleRow(target);
        }),
        animationsAtStart: runningAnimations(),
        quiet: undefined,
      };
    }
    const current = gesture;
    clearTimeout(current.quiet);
    if (performance.now() - current.started > LONGEST_MS) {
      finish();
      return;
    }
    current.quiet = setTimeout(finish, QUIET_MS);
  };

  const onWheel = (event: WheelEvent): void => {
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? window.innerHeight : 1;
    note({
      at: performance.now(),
      kind: "wheel",
      px: Math.abs(event.deltaY || event.deltaX) * unit,
    });
  };
  const onKey = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea") !== null)
    )
      return;
    if (SCROLL_KEYS.has(event.key)) note({ at: performance.now(), kind: "key", px: 0 });
  };
  // A press on an element outside its content box (its scrollbar) can drag or page it.
  const onPointer = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (event.offsetX > target.clientWidth || event.offsetY > target.clientHeight)
      note({ at: performance.now(), kind: "bar", px: 0 });
  };

  const listening = { capture: true, passive: true } as const;
  document.addEventListener("scroll", onScroll, listening);
  document.addEventListener("wheel", onWheel, listening);
  document.addEventListener("keydown", onKey, listening);
  document.addEventListener("pointerdown", onPointer, listening);
  return () => {
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.removeEventListener("keydown", onKey, { capture: true });
    document.removeEventListener("pointerdown", onPointer, { capture: true });
    if (gesture !== null) {
      clearTimeout(gesture.quiet);
      gesture.watch.stop();
      gesture = null;
    }
  };
}

import type { ClientTraceReport } from "@omp-app/contracts";
import { clientTags, frameMarks, scrollMoves, watchFrames } from "./frames";

/** A scroll has ended when no scroll event came for this long. */
const QUIET_MS = 300;
/** The longest one report watches; a longer scroll is reported as two. */
const LONGEST_MS = 4_000;
/** At most this many reports per page load, at least this far apart, so the log keeps a sample, not a stream. */
const MOST_REPORTS = 12;
const APART_MS = 5_000;
/** A scroll this short in frames or distance says nothing about how scrolling feels. */
const FEWEST_FRAMES = 10;
const LEAST_PX = 200;

interface Gesture {
  readonly target: Element;
  readonly started: number;
  readonly tops: number[];
  readonly frames: ReturnType<typeof watchFrames>;
  quiet: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Measures how the page scrolls: for a sample of scroll gestures, how often it drew a frame, how long its longest
 * frames were, and how far the scrolled element jumped between two frames, with the window's size and the engine.
 * `report` sends each to the server's debug log. Returns the function that stops it.
 */
export function traceScrolling(report: (trace: ClientTraceReport) => void): () => void {
  let gesture: Gesture | null = null;
  let reports = 0;
  let lastReport = Number.NEGATIVE_INFINITY;

  const finish = (): void => {
    const ended = gesture;
    if (ended === null) return;
    gesture = null;
    clearTimeout(ended.quiet);
    const stats = ended.frames.stop();
    const moves = scrollMoves(ended.tops);
    if (stats.frames < FEWEST_FRAMES || moves.movedPx < LEAST_PX) return;
    reports += 1;
    lastReport = performance.now();
    const inTranscript = ended.target.closest("section[aria-label='Transcript']") !== null;
    report({
      marks: {
        ...frameMarks(stats),
        scroll_ms: Math.round(performance.now() - ended.started),
        moved_px: moves.movedPx,
        max_jump_px: moves.maxJumpPx,
        still_frames: moves.stillFrames,
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
      const tops: number[] = [target.scrollTop];
      gesture = {
        target,
        started: performance.now(),
        tops,
        frames: watchFrames(() => tops.push(target.scrollTop)),
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

  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener("scroll", onScroll, { capture: true });
    if (gesture !== null) {
      clearTimeout(gesture.quiet);
      gesture.frames.stop();
      gesture = null;
    }
  };
}

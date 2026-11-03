import { desktopBridge } from "../desktop/bridge";

/** A frame longer than this blocked the page: whatever it had to draw or answer waited for it. */
const LONG_FRAME_MS = 50;
/** The most long-frame gaps one report carries (the server takes 200 numbers). */
const MAX_GAPS = 100;
/** Frames up to this long count toward the steady mean: one or two frames of any screen, not a stall. */
const STEADY_FRAME_MS = 25;

/** How the page drew frames over a span: from the time of each frame as `requestAnimationFrame` ran it. */
export interface FrameStats {
  readonly frames: number;
  /** The median and the 95th percentile of the time between frames, and the longest. */
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** Frames longer than LONG_FRAME_MS, and the time spent in them beyond one 60 Hz frame. */
  readonly longFrames: number;
  readonly blockedMs: number;
  /** Each long frame's length, in the order they came. */
  readonly longGaps: readonly number[];
  /**
   * The mean time between frames, stalls left out (up to STEADY_FRAME_MS), to 0.01 ms. A screen's own pace shows: 6.94 at
   * 144 Hz, 16.67 at 60 Hz; WebKitGTK's fallback timer sleeps 16 ms a frame, about 16.1 to 16.3 with its work.
   */
  readonly steadyMean: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** The statistics of frames drawn at `times` (milliseconds, in order). */
export function frameStats(times: readonly number[]): FrameStats {
  const gaps = times.slice(1).map((time, index) => time - (times[index] ?? time));
  const sorted = [...gaps].sort((a, b) => a - b);
  const long = gaps.filter((gap) => gap > LONG_FRAME_MS);
  return {
    frames: gaps.length,
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
    longFrames: long.length,
    blockedMs: Math.round(long.reduce((sum, gap) => sum + gap - 1000 / 60, 0)),
    longGaps: long.slice(0, MAX_GAPS).map(Math.round),
    steadyMean: meanOf(gaps.filter((gap) => gap <= STEADY_FRAME_MS)),
  };
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

/** How far a scrolled element moved between frames, from its `scrollTop` at each frame. */
export interface ScrollMoves {
  readonly movedPx: number;
  /** The largest move between two frames: a large one is the content jumping instead of gliding. */
  readonly maxJumpPx: number;
  /** Frames in which it did not move, between its first and last move. */
  readonly stillFrames: number;
}

export function scrollMoves(tops: readonly number[]): ScrollMoves {
  const moves = tops.slice(1).map((top, index) => Math.abs(top - (tops[index] ?? top)));
  const first = moves.findIndex((move) => move > 0);
  const last = moves.length - 1 - [...moves].reverse().findIndex((move) => move > 0);
  return {
    movedPx: Math.round(moves.reduce((sum, move) => sum + move, 0)),
    maxJumpPx: Math.round(Math.max(0, ...moves)),
    stillFrames: first < 0 ? 0 : moves.slice(first, last + 1).filter((move) => move === 0).length,
  };
}

/**
 * One frame of a scroll as the page drew it: the element's position and scroll height, and how far the content under
 * the middle of the view moved on screen since the frame before (up positive, as the position; null when unknown).
 */
export interface ScrollFrame {
  readonly top: number;
  readonly height: number;
  readonly seen: number | null;
}

/**
 * A frame in which the position changed: by how much (down positive), how far the content on screen moved, and how much
 * the scrolled content grew in that frame. A position change the screen did not show (`seenPx` near 0, the content
 * grown by about as much) is a correction for content added or measured above; one it showed is the view jumping.
 */
export interface ScrollJump {
  readonly frame: number;
  readonly movedPx: number;
  readonly seenPx: number | null;
  readonly grewPx: number;
}

/** The `count` frames whose position changed most, largest first. */
export function biggestJumps(frames: readonly ScrollFrame[], count: number): readonly ScrollJump[] {
  const jumps: ScrollJump[] = [];
  frames.forEach((frame, index) => {
    const before = frames[index - 1];
    if (before === undefined || frame.top === before.top) return;
    jumps.push({
      frame: index,
      movedPx: Math.round(frame.top - before.top),
      seenPx: frame.seen === null ? null : Math.round(frame.seen),
      grewPx: Math.round(frame.height - before.height),
    });
  });
  return jumps
    .sort((a, b) => Math.abs(b.movedPx) - Math.abs(a.movedPx) || a.frame - b.frame)
    .slice(0, count);
}

/** A transcript row's height in one frame, and what it is: its kind and its place in the list. */
export interface RowSize {
  readonly height: number;
  readonly kind: string;
  readonly index: number;
}

/** The row drawn in both frames whose height changed most between them (grew positive); null when none changed. */
export function biggestRowChange(
  before: ReadonlyMap<string, RowSize>,
  after: ReadonlyMap<string, RowSize>,
): { readonly kind: string; readonly index: number; readonly changePx: number } | null {
  let biggest: { kind: string; index: number; changePx: number } | null = null;
  for (const [key, now] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    const changePx = Math.round(now.height - was.height);
    if (changePx !== 0 && (biggest === null || Math.abs(changePx) > Math.abs(biggest.changePx)))
      biggest = { kind: now.kind, index: now.index, changePx };
  }
  return biggest;
}

/**
 * The row behind a jump: a row's own height changes in the jump's frame, or one frame before it (the list's total
 * height, and so the position, follows on its next render). Of the two, the change closest to the content's growth in
 * the jump's frame, with how many frames before the jump it came (`lag`); null when no drawn row changed in either.
 */
export function rowBehindJump(
  sizes: readonly ReadonlyMap<string, RowSize>[],
  jump: ScrollJump,
): {
  readonly kind: string;
  readonly index: number;
  readonly changePx: number;
  readonly lag: 0 | 1;
} | null {
  const between = (from: number, to: number) => {
    const before = sizes[from];
    const after = sizes[to];
    return before === undefined || after === undefined ? null : biggestRowChange(before, after);
  };
  const now = between(jump.frame - 1, jump.frame);
  const earlier = between(jump.frame - 2, jump.frame - 1);
  const off = (change: { readonly changePx: number }): number =>
    Math.abs(change.changePx - jump.grewPx);
  if (now !== null && (earlier === null || off(now) <= off(earlier))) return { ...now, lag: 0 };
  return earlier === null ? null : { ...earlier, lag: 1 };
}

/** Records the time of every frame, and runs `onFrame` in each, until `stop`. */
export function watchFrames(onFrame?: () => void): { readonly stop: () => FrameStats } {
  const times: number[] = [];
  let watching = true;
  const tick = (): void => {
    if (!watching) return;
    times.push(performance.now());
    onFrame?.();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop: () => {
      watching = false;
      return frameStats(times);
    },
  };
}

/** What a frame report says about the page that sent it: the desktop window or a browser, and the engine. */
export function clientTags(): readonly string[] {
  const agent = navigator.userAgent;
  const engine = /Firefox\//.test(agent)
    ? "gecko"
    : /Chrome\/|CriOS\//.test(agent)
      ? "chromium"
      : "webkit";
  return [desktopBridge() === null ? "browser" : "desktop", engine];
}

/** A report's numbers about the frames and the window they were drawn in. */
export function frameMarks(stats: FrameStats): Record<string, number> {
  return {
    frames: stats.frames,
    frame_p50_ms: stats.p50,
    frame_p95_ms: stats.p95,
    frame_max_ms: stats.max,
    long_frames: stats.longFrames,
    blocked_ms: stats.blockedMs,
    window_w: window.innerWidth,
    window_h: window.innerHeight,
    dpr_x100: Math.round(window.devicePixelRatio * 100),
    frame_mean_x100: Math.round(stats.steadyMean * 100),
    // The screen the engine puts the window on: a different one can have another pace.
    screen_w: window.screen.width,
    screen_h: window.screen.height,
    // The desktop window switches between 144 and 60 Hz from one scroll to the next: whether it had the focus, and
    // how many animations ran, as the report was made.
    focused: document.hasFocus() ? 1 : 0,
    animations: runningAnimations(),
  };
}

/** Animations and transitions running in the page now (0 where the engine can't list them). */
export function runningAnimations(): number {
  if (typeof document.getAnimations !== "function") return 0;
  return document.getAnimations().filter((animation) => animation.playState === "running").length;
}

/**
 * A usage window's pace (#2836): how fast its used share grows, from the server's own readings of it, and where that
 * leads by its reset. No provider reports a rate; it is the slope of the readings over the last hour, as
 * Claude-Code-Usage-Monitor takes its burn rate from tokens over time.
 */

/** One reading of one window: when, how full, and when the window resets (an ISO time; null when none is given). */
export interface WindowReading {
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

/** Where a window's pace leads: percent an hour, and either when it is full (before its reset) or how full at it. */
export interface WindowPace {
  /** Percent of the window an hour; null while the readings say nothing yet. */
  readonly perHour: number | null;
  /** When the window would be full at this pace, if that comes before its reset; else null. */
  readonly fullAt: number | null;
  /** How full the window would be at its reset at this pace (at most 100); null without a reset time or a pace. */
  readonly atReset: number | null;
}

/** The readings the pace is taken from: the last hour's, enough to see a trend and short enough to follow it. */
export const PACE_SPAN_MS = 60 * 60_000;
/** Fewer readings, or readings closer together, say nothing about a pace. */
export const PACE_MIN_READINGS = 3;
export const PACE_MIN_SPAN_MS = 10 * 60_000;
/** Two readings name the same reset when their reset times differ by less than this (providers round them). */
const SAME_RESET_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

const NO_PACE: WindowPace = { perHour: null, fullAt: null, atReset: null };

const resetMs = (resetsAt: string | null): number | null => {
  if (resetsAt === null) return null;
  const parsed = Date.parse(resetsAt);
  return Number.isNaN(parsed) ? null : parsed;
};

/** Whether two readings belong to the same period of their window: the same reset, or both without one. */
function samePeriod(a: WindowReading, b: WindowReading): boolean {
  const left = resetMs(a.resetsAt);
  const right = resetMs(b.resetsAt);
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < SAME_RESET_MS;
}

/**
 * A window's pace from its readings (oldest first): the least-squares slope of the readings of its current period
 * within the last hour, then where it leads. A window that shrank or stayed level has a pace of 0.
 */
export function windowPace(readings: readonly WindowReading[], now: number): WindowPace {
  const last = readings.at(-1);
  if (last === undefined) return NO_PACE;
  const recent = readings.filter(
    (reading) => reading.at >= now - PACE_SPAN_MS && samePeriod(reading, last),
  );
  const first = recent[0];
  if (
    first === undefined ||
    recent.length < PACE_MIN_READINGS ||
    last.at - first.at < PACE_MIN_SPAN_MS
  )
    return NO_PACE;
  const hours = recent.map((reading) => (reading.at - first.at) / HOUR_MS);
  const meanHours = hours.reduce((sum, value) => sum + value, 0) / recent.length;
  const meanUsed = recent.reduce((sum, reading) => sum + reading.usedPercent, 0) / recent.length;
  let covariance = 0;
  let variance = 0;
  for (const [index, reading] of recent.entries()) {
    const dx = (hours[index] ?? 0) - meanHours;
    covariance += dx * (reading.usedPercent - meanUsed);
    variance += dx * dx;
  }
  const perHour = variance === 0 ? 0 : Math.max(0, covariance / variance);
  const reset = resetMs(last.resetsAt);
  const fullAt =
    perHour > 0 && last.usedPercent < 100
      ? last.at + ((100 - last.usedPercent) / perHour) * HOUR_MS
      : null;
  if (reset === null) return { perHour, fullAt, atReset: null };
  if (fullAt !== null && fullAt < reset) return { perHour, fullAt, atReset: 100 };
  const atReset = Math.min(
    100,
    last.usedPercent + (perHour * Math.max(0, reset - last.at)) / HOUR_MS,
  );
  return { perHour, fullAt: null, atReset };
}

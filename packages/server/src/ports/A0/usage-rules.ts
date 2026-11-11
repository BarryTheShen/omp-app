import type { UsageLimitsResult, UsagePauseReason } from "@omp-app/contracts";

/** The 5-hour window, by its length: providers label it differently (#2781). */
export const FIVE_HOUR_MS = 5 * 3_600_000;
/** The weekly window, by its length. */
export const WEEK_MS = 7 * 24 * 3_600_000;
/** A held chat continues this long after its window's reset, once the provider counts the new window. */
export const RESUME_GRACE_MS = 60_000;
/**
 * A reading the server got longer ago than this does not continue a chat held for its usage: only a window's reset or the
 * end of the rule's hours does (#2836), as the reads have stopped and the window may be fuller than the last one said.
 */
export const STALE_READING_MS = 15 * 60_000;
/** A chat held for its pace continues only once the pace leads this many points under the rule's percent, so it does not flap. */
export const PACE_MARGIN = 5;

/** What a rule asks of a chat: a chat's own mark is a rule of one percent of the 5-hour window. */
export interface UsageConditions {
  readonly fiveHourAt: number | null;
  readonly weeklyAt: number | null;
  readonly paceAt: number | null;
  readonly hours: { readonly from: string; readonly to: string } | null;
  /** The chat's own part of its provider's 5-hour window at or past this percent: a chat's budget (#14). */
  readonly shareAt?: number | null;
}

/** One of a provider's windows in a reading: its used percent and its reset (epoch ms; null when omp gave none). */
export interface UsageWindowRead {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

/** A provider's windows in the last reading, the 5-hour window's pace, and when the server got the reading. */
export interface ProviderReading {
  readonly fiveHour: UsageWindowRead | undefined;
  readonly weekly: UsageWindowRead | undefined;
  /** How full the 5-hour window would be at its reset at the pace of the last hour; null without a pace. */
  readonly atReset: number | null;
  readonly receivedAt: number;
}

/** A condition that holds, and when it is expected to end (epoch ms; null when a reading will say). */
export interface Holding {
  readonly reason: UsagePauseReason;
  readonly until: number | null;
}

/** The window of `durationMs` of `providerId` in a reading. */
export function windowOf(
  result: UsageLimitsResult,
  providerId: string,
  durationMs: number,
): UsageWindowRead | undefined {
  if (result.state !== "ready") return undefined;
  const window = result.providers
    .find((provider) => provider.providerId === providerId)
    ?.windows.find((candidate) => candidate.durationMs === durationMs);
  if (window === undefined) return undefined;
  const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  return {
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: Number.isFinite(reset) ? reset : null,
  };
}

/** The fullest window of `durationMs` of any provider in a reading: below a rule's percent, no chat's provider is asked. */
export function fullestWindow(result: UsageLimitsResult, durationMs: number): number {
  if (result.state !== "ready") return 0;
  let fullest = 0;
  for (const provider of result.providers) {
    for (const window of provider.windows) {
      if (window.durationMs === durationMs) fullest = Math.max(fullest, window.usedPercent);
    }
  }
  return fullest;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The minute of the day it is at `at` in `zone` (0 to 1439). */
export function minuteOfDay(at: number, zone: string): number {
  let clock = clocks.get(zone);
  if (clock === undefined) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clocks.set(zone, clock);
  }
  let hour = 0;
  let minute = 0;
  for (const part of clock.formatToParts(at)) {
    if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/** `HH:MM` as a minute of the day. */
function minutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

/** Whether the clock in `zone` at `at` is in the hours from `from` to `to` (past midnight when `from` is later). */
export function inHours(
  at: number,
  hours: { readonly from: string; readonly to: string },
  zone: string,
): boolean {
  const now = minuteOfDay(at, zone);
  const from = minutes(hours.from);
  const to = minutes(hours.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

const MINUTE_MS = 60_000;

/**
 * When the hours that hold at `at` end: the first whole minute after it outside them. On a day the clock moves for
 * daylight saving the minutes are counted on, so the hours end when the clock first shows a time outside them.
 */
export function hoursEnd(
  at: number,
  hours: { readonly from: string; readonly to: string },
  zone: string,
): number {
  const start = Math.floor(at / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const ahead = (minutes(hours.to) - minuteOfDay(at, zone) + 1440) % 1440;
  // The clock's own minutes first, then an hour either way for a daylight-saving day.
  for (const shift of [ahead - 1, ahead - 61, ahead + 59]) {
    const candidate = start + shift * MINUTE_MS;
    if (
      candidate > at &&
      !inHours(candidate, hours, zone) &&
      inHours(candidate - MINUTE_MS, hours, zone)
    )
      return candidate;
  }
  for (let candidate = start; candidate < start + 26 * 60 * MINUTE_MS; candidate += MINUTE_MS) {
    if (!inHours(candidate, hours, zone)) return candidate;
  }
  return start + 24 * 60 * MINUTE_MS;
}

/** What a chat is held for, and until when its hold expected that to last (null: until a reading says). */
export interface HeldFor {
  readonly reason: UsagePauseReason;
  readonly until: number | null;
}

/** Unread since the hold: the condition holds until the end the hold expected (a window's reset plus a minute). */
function heldUnread(held: HeldFor, now: number): Holding["until"] | false {
  return held.until !== null && now >= held.until ? false : held.until;
}

/** A usage condition on a window: whether it holds at `now`, and until when. */
function windowHolds(
  window: UsageWindowRead | undefined,
  percent: number,
  now: number,
  held: HeldFor | null,
  fresh: boolean,
): Holding["until"] | false {
  if (window === undefined) return held === null ? false : heldUnread(held, now);
  const until = window.resetsAt === null ? null : window.resetsAt + RESUME_GRACE_MS;
  // A window whose reset has passed is a new one, read or not.
  if (window.resetsAt !== null && now >= window.resetsAt) return false;
  if (window.usedPercent >= percent) return until;
  // Under the percent: a chat held for it continues only on a fresh reading.
  return held !== null && !fresh ? until : false;
}

/**
 * The conditions of `rule` that hold at `now` for a chat whose provider was read as `reading`, each with when it is
 * expected to end. `heldFor` is what the chat is held for now: a chat held for a window stays held while the reading is
 * stale, until the window's reset, and while its provider is missing from the reading, until the end its hold
 * expected; one held for its pace continues only `PACE_MARGIN` points under the rule's percent. `share` is the chat's
 * own part of the 5-hour window (`UsageShares`), for a budget.
 */
export function holdingConditions(
  rule: UsageConditions,
  reading: ProviderReading | undefined,
  now: number,
  zone: string,
  heldFor: HeldFor | null,
  share: number | null = null,
): Holding[] {
  const holding: Holding[] = [];
  if (rule.hours !== null && inHours(now, rule.hours, zone))
    holding.push({ reason: "hours", until: hoursEnd(now, rule.hours, zone) });
  const fresh = reading !== undefined && now - reading.receivedAt <= STALE_READING_MS;
  const heldAs = (reason: UsagePauseReason): HeldFor | null =>
    heldFor?.reason === reason ? heldFor : null;
  if (rule.fiveHourAt !== null) {
    const until = windowHolds(reading?.fiveHour, rule.fiveHourAt, now, heldAs("five_hour"), fresh);
    if (until !== false) holding.push({ reason: "five_hour", until });
  }
  if (rule.weeklyAt !== null) {
    const until = windowHolds(reading?.weekly, rule.weeklyAt, now, heldAs("weekly"), fresh);
    if (until !== false) holding.push({ reason: "weekly", until });
  }
  if (rule.shareAt !== undefined && rule.shareAt !== null) {
    // A budget (#14) is of the 5-hour window, so it holds as that window's condition: until its reset, when the chat's
    // part starts over. A hold of it reads "five_hour" to every page, as older pages know no other reason for it.
    const window = reading?.fiveHour;
    const held = heldAs("five_hour");
    if (window === undefined) {
      const until = held === null ? false : heldUnread(held, now);
      if (until !== false) holding.push({ reason: "five_hour", until });
    } else if (window.resetsAt === null || now < window.resetsAt) {
      const until = window.resetsAt === null ? null : window.resetsAt + RESUME_GRACE_MS;
      if ((share ?? 0) >= rule.shareAt || (held !== null && !fresh))
        holding.push({ reason: "five_hour", until });
    }
  }
  if (rule.paceAt !== null) {
    const window = reading?.fiveHour;
    const held = heldAs("pace");
    if (window === undefined) {
      const until = held === null ? false : heldUnread(held, now);
      if (until !== false) holding.push({ reason: "pace", until });
    } else if (window.resetsAt === null || now < window.resetsAt) {
      // A window whose reset has passed is a new one, with no pace yet.
      const until = window.resetsAt === null ? null : window.resetsAt + RESUME_GRACE_MS;
      const line = held === null ? rule.paceAt : rule.paceAt - PACE_MARGIN;
      const atReset = reading?.atReset ?? null;
      if ((held !== null && !fresh) || (atReset !== null && atReset > line))
        holding.push({ reason: "pace", until });
    }
  }
  return holding;
}

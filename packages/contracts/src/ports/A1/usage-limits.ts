import { z } from "zod";
import { definePort } from "../../core/envelope";

/**
 * One usage window of one provider, from omp's own usage report: the fullest signed-in account's share of it, when
 * that account's window resets, and how many accounts report the window. No account name, email or id is in it.
 */
export const UsageLimitWindow = z.strictObject({
  label: z.string().min(1).max(64),
  usedPercent: z.number().min(0).max(10_000),
  resetsAt: z.string().max(64).nullable(),
  accounts: z.number().int().min(1).max(1_000),
  /**
   * The window's length (ms) as omp reports it, or from omp's stable window id ("5h"); absent when neither tells. The
   * usage pause acts on the 5-hour window by this, as providers label it differently ("5 Hour", "5 hours").
   */
  durationMs: z.number().int().positive().nullable().optional(),
  /**
   * With two or more accounts: their shares of the window added up, as omp's combined line counts them (each account's
   * highest share; 1.05 of 2 accounts used, 0.95 left). Absent with one account (#13).
   */
  usedAccounts: z.number().min(0).max(1_000).optional(),
});
export type UsageLimitWindow = z.infer<typeof UsageLimitWindow>;

/** One account's share of one window and when that account's window resets (#13). */
export const UsageLimitAccountWindow = z.strictObject({
  label: z.string().min(1).max(64),
  usedPercent: z.number().min(0).max(10_000),
  resetsAt: z.string().max(64).nullable(),
});
export type UsageLimitAccountWindow = z.infer<typeof UsageLimitAccountWindow>;

/**
 * One signed-in account and its windows (#13). `label` is the account as `omp usage` names it: its email, else an
 * account or project of it, else its place among the provider's (`Account 2`); one signed in twice gets ` (2)`.
 */
export const UsageLimitAccount = z.strictObject({
  label: z.string().min(1).max(320),
  windows: z.array(UsageLimitAccountWindow).max(64),
});
export type UsageLimitAccount = z.infer<typeof UsageLimitAccount>;

/** The windows one provider reports, in the order omp lists them; with two or more accounts, each account's too. */
export const UsageLimitProvider = z.strictObject({
  providerId: z.string().min(1).max(128),
  windows: z.array(UsageLimitWindow).max(64),
  accounts: z.array(UsageLimitAccount).max(64).optional(),
});
export type UsageLimitProvider = z.infer<typeof UsageLimitProvider>;

/** What omp reports about provider usage limits, or the plain reason it could not be read. */
export const UsageLimitsResult = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    fetchedAt: z.string().max(64),
    providers: z.array(UsageLimitProvider).max(128),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.string().min(1).max(512),
  }),
]);
export type UsageLimitsResult = z.infer<typeof UsageLimitsResult>;

/**
 * One window's pace (#2836), from the server's own readings of it over the last hour: percent an hour, and where that
 * leads: when the window is full, if before its reset, or how full at its reset.
 */
export const UsageWindowPace = z.strictObject({
  providerId: z.string().min(1).max(128),
  label: z.string().min(1).max(64),
  /** Percent of the window an hour; null while the readings are too few or too close together. */
  perHour: z.number().min(0).max(1_000_000).nullable(),
  /** When the window would be full at this pace (ISO), if that comes before its reset. */
  fullAt: z.string().max(64).nullable(),
  /** How full the window would be at its reset at this pace, at most 100; null without a reset time or a pace. */
  atReset: z.number().min(0).max(100).nullable(),
  /** How many readings of the window the server keeps (a day's). */
  readings: z.number().int().min(0).max(1_000_000),
});
export type UsageWindowPace = z.infer<typeof UsageWindowPace>;

export const UsagePaceResult = z.strictObject({ windows: z.array(UsageWindowPace).max(1_024) });
export type UsagePaceResult = z.infer<typeof UsagePaceResult>;

/**
 * The provider usage limits omp reports for the signed-in accounts (read-only; cached by the host). The host reads them
 * by itself too, and every fresh read goes to every page as `changed` (#2781).
 */
export const UsageLimitStore = definePort({
  name: "A1.usageLimitStore",
  methods: {
    read: {
      args: z.strictObject({}),
      result: UsageLimitsResult,
      capability: "host.usage-limits",
    },
    /** Each window's pace from the server's readings (#2836). */
    pace: {
      args: z.strictObject({}),
      result: UsagePaceResult,
      capability: "host.usage-limits",
    },
  },
  events: {
    /** The limits after each fresh read, a page's or the host's own. */
    changed: {
      payload: UsageLimitsResult,
      capability: "host.usage-limits",
    },
  },
});

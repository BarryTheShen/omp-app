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
});
export type UsageLimitWindow = z.infer<typeof UsageLimitWindow>;

/** The windows one provider reports, in the order omp lists them. */
export const UsageLimitProvider = z.strictObject({
  providerId: z.string().min(1).max(128),
  windows: z.array(UsageLimitWindow).max(64),
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
  },
  events: {
    /** The limits after each fresh read, a page's or the host's own. */
    changed: {
      payload: UsageLimitsResult,
      capability: "host.usage-limits",
    },
  },
});

import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";

/** The spans the summary covers, as omp's own statistics page names them. */
export const StatsRange = z.enum(["24h", "7d", "30d"]);
export type StatsRange = z.infer<typeof StatsRange>;

export const StatsTotals = z.strictObject({
  requests: z.number(),
  failed: z.number(),
  /** 0 to 1. */
  errorRate: z.number(),
  /** In US dollars, as omp prices it (public prices, also for a subscription's requests). */
  cost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  /** Of the prompt's input tokens, the share read from the cache: 0 to 1. */
  cacheRate: z.number(),
  /** Milliseconds; null with no request in the span. */
  averageDuration: z.number().nullable(),
  averageFirstToken: z.number().nullable(),
  tokensPerSecond: z.number().nullable(),
});
export type StatsTotals = z.infer<typeof StatsTotals>;

/** One bucket of the span: an hour for 24 hours, a day otherwise. */
export const StatsBucket = z.strictObject({
  at: z.number(),
  requests: z.number(),
  errors: z.number(),
  tokens: z.number(),
  cost: z.number(),
});
export type StatsBucket = z.infer<typeof StatsBucket>;

export const StatsModel = z.strictObject({
  model: z.string(),
  provider: z.string(),
  requests: z.number(),
  cost: z.number(),
  errorRate: z.number(),
});
export type StatsModel = z.infer<typeof StatsModel>;

export const StatsSummary = z.strictObject({
  range: StatsRange,
  totals: StatsTotals,
  buckets: z.array(StatsBucket),
  /** The models that cost the most in the span, most first. */
  models: z.array(StatsModel),
});
export type StatsSummary = z.infer<typeof StatsSummary>;

/**
 * One chat in omp's statistics: its whole history, its subagents' included, as omp's traces list it (`/api/sessions`).
 * omp's `/session` counts only the messages in a chat's context, which a compaction shortens.
 */
export const StatsChat = z.strictObject({
  /** In US dollars, as omp prices it. */
  cost: z.number(),
  /** omp's replies, each a request to a model. */
  requests: z.number(),
  toolCalls: z.number(),
  tokens: z.number(),
  subagents: z.number(),
  /** Requests omp had no price for: the cost leaves them out. */
  unpriced: z.number(),
});
export type StatsChat = z.infer<typeof StatsChat>;

/** A chat by its session file (`get_session_stats`' `sessionFile`). */
export const StatsChatArgs = z.strictObject({ file: z.string().min(1).max(4_096) });
export type StatsChatArgs = z.infer<typeof StatsChatArgs>;

/** null: omp's statistics hold no such chat. */
export const StatsChatResult = z.strictObject({ chat: StatsChat.nullable() });
export type StatsChatResult = z.infer<typeof StatsChatResult>;

/** omp's statistics (`/stats`) in brief, for the dashboard and a chat's usage: read from omp's own statistics page on the server. */
export const StatsPort = definePort({
  name: "A0.stats",
  methods: {
    summary: { args: z.strictObject({ range: StatsRange }), result: StatsSummary },
    chat: { args: StatsChatArgs, result: StatsChatResult },
  },
  events: {},
});
export type StatsPort = typeof StatsPort;
export type StatsClient = PortClient<StatsPort>;
export type StatsHandlers<Context> = PortHandlers<StatsPort, Context>;

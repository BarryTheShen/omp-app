import { AppFailure, StatsPort, type StatsRange, type StatsSummary } from "@omp-app/contracts";
import { z } from "zod";
import type { PortRegistration } from "../../registry/ports";

/** The models the summary names, most cost first. */
export const STATS_MODELS_SHOWN = 6;

/** How long one read of omp's page may take once it runs. */
const READ_MS = 30_000;

/** omp's aggregated numbers (`AggregatedStats`, `@oh-my-pi/omp-stats`): the fields the summary passes on. */
const Aggregated = z.object({
  totalRequests: z.number(),
  failedRequests: z.number(),
  errorRate: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheReadTokens: z.number(),
  totalCacheWriteTokens: z.number(),
  cacheRate: z.number(),
  totalCost: z.number(),
  avgDuration: z.number().nullable(),
  avgTtft: z.number().nullable(),
  avgTokensPerSecond: z.number().nullable(),
});

const Overview = z.object({
  overall: Aggregated,
  timeSeries: z.array(
    z.object({
      timestamp: z.number(),
      requests: z.number(),
      errors: z.number(),
      tokens: z.number(),
      cost: z.number(),
    }),
  ),
});

const ByModel = z.array(Aggregated.extend({ model: z.string(), provider: z.string() }));

export interface StatsContext {
  /** omp's statistics page on this machine: its port, started when first asked (`OmpStats`). */
  readonly stats: { start(): Promise<number> };
  readonly fetch?: typeof fetch;
}

/** omp's statistics in brief (D7): read from omp's own page, on the loopback address, its numbers checked. */
export function createStatsRegistration(context: StatsContext): PortRegistration {
  const get = context.fetch ?? fetch;
  const read = async <T>(port: number, path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await get(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(READ_MS),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`omp's statistics answered ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new Error("omp's statistics answered in a shape this app does not read");
    return parsed.data;
  };
  const handlers = {
    summary: async (args: unknown): Promise<StatsSummary> => {
      const { range } = args as { range: StatsRange };
      try {
        const port = await context.stats.start();
        const query = `?range=${encodeURIComponent(range)}`;
        const [overview, byModel] = await Promise.all([
          read(port, `/api/stats/overview${query}`, Overview),
          read(port, `/api/stats/models${query}`, ByModel),
        ]);
        const { overall } = overview;
        return {
          range,
          totals: {
            requests: overall.totalRequests,
            failed: overall.failedRequests,
            errorRate: overall.errorRate,
            cost: overall.totalCost,
            inputTokens: overall.totalInputTokens,
            outputTokens: overall.totalOutputTokens,
            cacheReadTokens: overall.totalCacheReadTokens,
            cacheWriteTokens: overall.totalCacheWriteTokens,
            cacheRate: overall.cacheRate,
            averageDuration: overall.avgDuration,
            averageFirstToken: overall.avgTtft,
            tokensPerSecond: overall.avgTokensPerSecond,
          },
          buckets: overview.timeSeries.map((point) => ({
            at: point.timestamp,
            requests: point.requests,
            errors: point.errors,
            tokens: point.tokens,
            cost: point.cost,
          })),
          models: [...byModel]
            .sort((left, right) => right.totalCost - left.totalCost)
            .slice(0, STATS_MODELS_SHOWN)
            .map((model) => ({
              model: model.model,
              provider: model.provider,
              requests: model.totalRequests,
              cost: model.totalCost,
              errorRate: model.errorRate,
            })),
        };
      } catch (error) {
        throw new AppFailure({
          code: "unavailable",
          message: `omp's statistics could not be read: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        });
      }
    },
  };
  return { port: StatsPort, context, handlers };
}

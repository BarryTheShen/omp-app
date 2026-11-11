import { AppFailure, StatsPort, type StatsRange, type StatsSummary } from "@omp-app/contracts";
import { z } from "zod";
import type { PortRegistration } from "../../registry/ports";

/** The models the summary names, most cost first. */
export const STATS_MODELS_SHOWN = 6;

/** How long one read of omp's page may take once it runs. */
const READ_MS = 30_000;

/** How long a read waits for omp's page to read the chats first, the minute the section says it can take. */
const SYNC_MS = 60_000;

/** How often it asks whether the page has. */
const SYNC_POLL_MS = 200;

/**
 * omp's page's own state (`LiveStatus`: `POST /api/sync`'s answer, `GET /api/status`): `sync.lastSyncedAt` is when its
 * last reading of the chats finished, and `indexingHours` the hours whose sums it is still building.
 */
const Status = z.object({
  sync: z.object({ phase: z.string(), lastSyncedAt: z.number().nullable() }),
  indexingHours: z.number(),
});

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
  const read = async <T>(
    port: number,
    path: string,
    schema: z.ZodType<T>,
    method: "GET" | "POST" = "GET",
  ): Promise<T> => {
    const response = await get(`http://127.0.0.1:${port}${path}`, {
      method,
      signal: AbortSignal.timeout(READ_MS),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`omp's statistics answered ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new Error("omp's statistics answered in a shape this app does not read");
    return parsed.data;
  };
  /**
   * omp's page reads the chats only while one of its own pages listens (`/api/events`) or when asked (`POST /api/sync`);
   * asked by nobody, it keeps what it last read, and nothing on a new machine. So each read first asks it to read the
   * chats (only what changed since), and waits until a reading finished after the ask, its sums built, up to a minute;
   * a reading that failed, or a page that cannot be asked, holds no read.
   */
  const readChats = async (port: number): Promise<void> => {
    const asked = Date.now();
    if ((await read(port, "/api/sync", Status, "POST").catch(() => null)) === null) return;
    for (;;) {
      const status = await read(port, "/api/status", Status).catch(() => null);
      const done =
        status === null ||
        status.sync.phase === "error" ||
        (status.sync.phase !== "syncing" &&
          status.sync.lastSyncedAt !== null &&
          status.sync.lastSyncedAt >= asked &&
          status.indexingHours === 0);
      if (done || Date.now() - asked >= SYNC_MS) return;
      await Bun.sleep(SYNC_POLL_MS);
    }
  };
  const handlers = {
    summary: async (args: unknown): Promise<StatsSummary> => {
      const { range } = args as { range: StatsRange };
      try {
        const port = await context.stats.start();
        await readChats(port);
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

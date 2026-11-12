import { basename } from "node:path";
import {
  AppFailure,
  type StatsChatResult,
  StatsPort,
  type StatsRange,
  type StatsSummary,
} from "@omp-app/contracts";
import { z } from "zod";
import type { PortRegistration } from "../../registry/ports";

/** The models the summary names, most cost first. */
export const STATS_MODELS_SHOWN = 6;

/** How long one read of omp's page may take once it runs. */
const READ_MS = 30_000;

/**
 * How long a read waits for omp's page to read the chats first when it has not read them since it started, the minute the
 * section says it can take.
 */
const SYNC_MS = 60_000;

/**
 * How long a read waits for a newer reading once the page has one. omp's watcher keeps that one current (`OmpStats`
 * starts it), so a reading usually ends within a moment; only a long one, such as a long chat read whole on a busy
 * computer, runs past this, and the read then answers with the reading before it rather than wait on. A turn's end reads
 * the chat's numbers once, so this leaves room for the reading of that turn.
 */
const SYNC_HELD_MS = 10_000;

/** How often it asks whether the page has. */
const SYNC_POLL_MS = 50;

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

/** omp's traces list (`SessionSummary`, `@oh-my-pi/omp-stats`): each chat's whole history, its subagents folded in. */
const Sessions = z.array(
  z.object({
    file: z.string(),
    requests: z.number(),
    toolCalls: z.number(),
    subagents: z.number(),
    totalTokens: z.number(),
    costTotal: z.number(),
    unpricedRequests: z.number(),
  }),
);

const unavailable = (error: unknown): AppFailure =>
  new AppFailure({
    code: "unavailable",
    message: `omp's statistics could not be read: ${error instanceof Error ? error.message : String(error)}`,
    retryable: true,
  });

export interface StatsContext {
  /** omp's statistics page on this machine: its port, started when first asked (`OmpStats`). */
  readonly stats: { start(): Promise<number> };
  readonly fetch?: typeof fetch;
  /** `SYNC_HELD_MS`, shorter in tests. */
  readonly heldMs?: number;
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
   * omp's page reads the chats only while its watcher runs (`OmpStats` starts it) or when asked (`POST /api/sync`);
   * asked by nobody, it keeps what it last read, and nothing on a new machine. So each read first asks it to read the
   * chats (only what changed since), and waits until a reading finished after the ask, its sums built: up to a minute
   * while the page has none, and `SYNC_HELD_MS` once it has one. A reading that failed, or a page that cannot be asked,
   * holds no read. Reads at the same time share one ask and its wait.
   */
  const held = context.heldMs ?? SYNC_HELD_MS;
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
      const waited = Date.now() - asked;
      const hasReading = status !== null && status.sync.lastSyncedAt !== null;
      if (done || waited >= SYNC_MS || (hasReading && waited >= held)) return;
      await Bun.sleep(SYNC_POLL_MS);
    }
  };
  let reading: Promise<void> | null = null;
  const readChatsOnce = (port: number): Promise<void> => {
    reading ??= readChats(port).finally(() => {
      reading = null;
    });
    return reading;
  };
  const handlers = {
    summary: async (args: unknown): Promise<StatsSummary> => {
      const { range } = args as { range: StatsRange };
      try {
        const port = await context.stats.start();
        await readChatsOnce(port);
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
        throw unavailable(error);
      }
    },
    /**
     * A chat's whole history (#19): asked by its file's name, which holds the chat's id, among the chats omp's list
     * folds (the 300 used last), and that one taken by its name.
     */
    chat: async (args: unknown): Promise<StatsChatResult> => {
      const name = basename((args as { file: string }).file);
      try {
        const port = await context.stats.start();
        await readChatsOnce(port);
        const rows = await read(
          port,
          `/api/sessions?limit=10&q=${encodeURIComponent(name)}`,
          Sessions,
        );
        const row = rows.find((candidate) => basename(candidate.file) === name);
        return {
          chat:
            row === undefined
              ? null
              : {
                  cost: row.costTotal,
                  requests: row.requests,
                  toolCalls: row.toolCalls,
                  tokens: row.totalTokens,
                  subagents: row.subagents,
                  unpriced: row.unpricedRequests,
                },
        };
      } catch (error) {
        throw unavailable(error);
      }
    },
  };
  return { port: StatsPort, context, handlers };
}

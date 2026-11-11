import { describe, expect, test } from "bun:test";
import { AppFailure, type StatsSummary } from "@omp-app/contracts";
import { createStatsRegistration } from "./stats";

const aggregated = (cost: number, requests: number) => ({
  totalRequests: requests,
  successfulRequests: requests - 1,
  failedRequests: 1,
  errorRate: 1 / requests,
  totalInputTokens: 1000,
  totalOutputTokens: 200,
  totalCacheReadTokens: 800,
  totalCacheWriteTokens: 50,
  cacheRate: 0.8,
  cacheSavings: 0.5,
  totalCost: cost,
  unpricedRequests: 0,
  totalPremiumRequests: 0,
  avgDuration: 1500,
  avgTtft: 400,
  avgTokensPerSecond: 55,
  firstTimestamp: 1,
  lastTimestamp: 2,
});

/**
 * omp's page's state as it answers: reading the chats, done (a reading that finished `lastSyncedAt`, by default as it
 * answers), or failed.
 */
const status = (
  phase: "syncing" | "idle" | "error",
  lastSyncedAt: number | null = phase === "idle" ? Date.now() : null,
) => ({
  version: 1,
  sync: { phase, current: 0, total: 0, processed: 0, lastSyncedAt, error: null },
  indexingHours: 0,
});

/**
 * A registration over a stand-in page that records what was asked (`GET <url>`, `POST <url>`). `statuses` answer
 * `/api/status` in turn, the last one again and again; `syncs: false` is a page that cannot be asked to read the chats.
 */
function statsOf(
  answers: Record<string, unknown>,
  asked: string[] = [],
  statuses: (() => unknown)[] = [() => status("idle")],
  syncs = true,
) {
  const registration = createStatsRegistration({
    stats: { start: async () => 4321 },
    fetch: (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      asked.push(`${method} ${url}`);
      const path = new URL(url).pathname;
      if (path === "/api/sync" && method === "POST") {
        return syncs
          ? Response.json(status("syncing"), { status: 202 })
          : new Response("missing", { status: 404 });
      }
      if (path === "/api/status") {
        return Response.json((statuses.length > 1 ? statuses.shift() : statuses[0])?.());
      }
      return path in answers
        ? Response.json(answers[path])
        : new Response("missing", { status: 404 });
    }) as unknown as typeof fetch,
  });
  const handlers = registration.handlers as {
    summary: (args: unknown) => Promise<StatsSummary>;
  };
  return () => handlers.summary({ range: "7d" });
}

const summaryOf = (answers: Record<string, unknown>, asked: string[] = []) =>
  statsOf(answers, asked)();

const paths = (asked: readonly string[]) =>
  asked.map((entry) => {
    const [method, url] = entry.split(" ");
    return `${method} ${new URL(url ?? "").pathname}`;
  });

const quiet = {
  "/api/stats/overview": { overall: aggregated(1, 2), byAgentType: [], timeSeries: [] },
  "/api/stats/models": [],
};

describe("omp's statistics in brief", () => {
  test("the totals, the buckets and the six models that cost the most, read from omp's page for the range", async () => {
    const asked: string[] = [];
    const models = ["a", "b", "c", "d", "e", "f", "g"].map((name, index) => ({
      ...aggregated(index + 1, 10),
      model: `model-${name}`,
      provider: "anthropic",
    }));
    const summary = await summaryOf(
      {
        "/api/stats/overview": {
          overall: aggregated(12.5, 40),
          byAgentType: [],
          timeSeries: [{ timestamp: 100, requests: 4, errors: 1, tokens: 900, cost: 1.25 }],
        },
        "/api/stats/models": models,
      },
      asked,
    );
    expect(asked).toEqual([
      "POST http://127.0.0.1:4321/api/sync",
      "GET http://127.0.0.1:4321/api/status",
      "GET http://127.0.0.1:4321/api/stats/overview?range=7d",
      "GET http://127.0.0.1:4321/api/stats/models?range=7d",
    ]);
    expect(summary.totals).toMatchObject({ requests: 40, failed: 1, cost: 12.5, cacheRate: 0.8 });
    expect(summary.buckets).toEqual([{ at: 100, requests: 4, errors: 1, tokens: 900, cost: 1.25 }]);
    expect(summary.models.map((model) => model.model)).toEqual([
      "model-g",
      "model-f",
      "model-e",
      "model-d",
      "model-c",
      "model-b",
    ]);
  });

  test("a page that cannot be read says so, as a failure to try again", async () => {
    const failed = await summaryOf({ "/api/stats/overview": { overall: {} } }).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(AppFailure);
    expect((failed as AppFailure).appError).toMatchObject({ code: "unavailable", retryable: true });
    expect((failed as AppFailure).message).toContain("omp's statistics could not be read");
  });

  test("each read has omp's page read the chats first, and waits for a reading that finished after it asked", async () => {
    const asked: string[] = [];
    // A reading from before the ask, then one running, then one done.
    const summary = statsOf(quiet, asked, [
      () => status("idle", 1),
      () => status("syncing"),
      () => status("idle"),
    ]);
    await summary();
    expect(paths(asked)).toEqual([
      "POST /api/sync",
      "GET /api/status",
      "GET /api/status",
      "GET /api/status",
      "GET /api/stats/overview",
      "GET /api/stats/models",
    ]);
    asked.length = 0;
    await summary();
    expect(paths(asked)).toEqual([
      "POST /api/sync",
      "GET /api/status",
      "GET /api/stats/overview",
      "GET /api/stats/models",
    ]);
  });

  test("a reading of the chats that failed, or a page that cannot be asked for one, holds no read", async () => {
    const asked: string[] = [];
    await statsOf(quiet, asked, [() => status("error")])();
    expect(paths(asked)).toEqual([
      "POST /api/sync",
      "GET /api/status",
      "GET /api/stats/overview",
      "GET /api/stats/models",
    ]);
    asked.length = 0;
    await statsOf(quiet, asked, undefined, false)();
    expect(paths(asked)).toEqual([
      "POST /api/sync",
      "GET /api/stats/overview",
      "GET /api/stats/models",
    ]);
  });
});

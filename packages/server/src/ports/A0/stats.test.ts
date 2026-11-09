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

function summaryOf(answers: Record<string, unknown>, asked: string[] = []) {
  const registration = createStatsRegistration({
    stats: { start: async () => 4321 },
    fetch: (async (url: string) => {
      asked.push(url);
      const path = new URL(url).pathname;
      return path in answers
        ? Response.json(answers[path])
        : new Response("missing", { status: 404 });
    }) as unknown as typeof fetch,
  });
  const handlers = registration.handlers as {
    summary: (args: unknown) => Promise<StatsSummary>;
  };
  return handlers.summary({ range: "7d" });
}

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
      "http://127.0.0.1:4321/api/stats/overview?range=7d",
      "http://127.0.0.1:4321/api/stats/models?range=7d",
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
});

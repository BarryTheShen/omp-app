import { describe, expect, test } from "bun:test";
import { AppFailure, type StatsChatResult, type StatsSummary } from "@omp-app/contracts";
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
 * The handlers over a stand-in page that records what was asked (`GET <url>`, `POST <url>`). `statuses` answer
 * `/api/status` in turn, the last one again and again; `syncs: false` is a page that cannot be asked to read the chats.
 */
function handlersOf(
  answers: Record<string, unknown>,
  asked: string[] = [],
  statuses: (() => unknown)[] = [() => status("idle")],
  syncs = true,
  heldMs?: number,
) {
  const registration = createStatsRegistration({
    stats: { start: async () => 4321 },
    ...(heldMs === undefined ? {} : { heldMs }),
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
  return registration.handlers as {
    summary: (args: unknown) => Promise<StatsSummary>;
    chat: (args: unknown) => Promise<StatsChatResult>;
  };
}

/** The 7-day summary over the stand-in page (`handlersOf`). */
function statsOf(
  answers: Record<string, unknown>,
  asked: string[] = [],
  statuses: (() => unknown)[] = [() => status("idle")],
  syncs = true,
) {
  const handlers = handlersOf(answers, asked, statuses, syncs);
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

  test("reads asked at the same time share one ask and its wait", async () => {
    const asked: string[] = [];
    const handlers = handlersOf(quiet, asked, [() => status("syncing"), () => status("idle")]);
    await Promise.all([handlers.summary({ range: "7d" }), handlers.summary({ range: "24h" })]);
    expect(paths(asked).filter((entry) => entry === "POST /api/sync")).toHaveLength(1);
    expect(paths(asked).filter((entry) => entry === "GET /api/stats/overview")).toHaveLength(2);
  });

  test("once the page has a reading, a read waits for a newer one only a while, then answers with that one", async () => {
    const asked: string[] = [];
    // The page read the chats before (at 1), and its next reading runs on and on.
    const handlers = handlersOf(quiet, asked, [() => status("syncing", 1)], true, 200);
    const started = Date.now();
    const summary = await handlers.summary({ range: "7d" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(summary.totals.requests).toBe(2);
    expect(paths(asked).at(-1)).toBe("GET /api/stats/models");
  });

  test("a page that has not read the chats yet is waited for past that while", async () => {
    const asked: string[] = [];
    const handlers = handlersOf(
      quiet,
      asked,
      [
        () => status("syncing"),
        () => status("syncing"),
        () => status("syncing"),
        () => status("syncing"),
        () => status("idle"),
      ],
      true,
      10,
    );
    await handlers.summary({ range: "7d" });
    expect(paths(asked).filter((entry) => entry === "GET /api/status")).toHaveLength(5);
  });
});

/** A chat as omp's traces list folds it (`SessionSummary`). */
const session = (file: string, costTotal: number) => ({
  file,
  folder: "/work",
  title: null,
  startedAt: 1,
  endedAt: 2,
  requests: 9_120,
  toolCalls: 12_400,
  subagents: 10,
  totalTokens: 1_200_000_000,
  costTotal,
  unpricedRequests: 2,
  models: ["claude-opus-5-5"],
});

describe("a chat's whole history in omp's statistics (#19)", () => {
  const file = "/home/u/.omp/agent/sessions/-work/2026-11-11T03-45-20-394Z_01a1c8b5.jsonl";

  test("its cost, replies, tool calls, tokens and subagents, from the chat named exactly as its file", async () => {
    const asked: string[] = [];
    const result = await handlersOf(
      {
        "/api/sessions": [
          // omp's list finds every chat whose name holds the words asked, not only that one.
          session("/home/u/.omp/agent/sessions/-work/x_2026-11-11T03-45-20-394Z_01a1c8b5.jsonl", 1),
          session(file, 2345.67),
        ],
      },
      asked,
    ).chat({ file });
    expect(paths(asked)).toEqual(["POST /api/sync", "GET /api/status", "GET /api/sessions"]);
    expect(new URL(asked[2]?.split(" ")[1] ?? "").searchParams.get("q")).toBe(
      "2026-11-11T03-45-20-394Z_01a1c8b5.jsonl",
    );
    expect(result).toEqual({
      chat: {
        cost: 2345.67,
        requests: 9_120,
        toolCalls: 12_400,
        tokens: 1_200_000_000,
        subagents: 10,
        unpriced: 2,
      },
    });
  });

  test("a chat omp's statistics do not hold is none", async () => {
    expect(await handlersOf({ "/api/sessions": [] }).chat({ file })).toEqual({ chat: null });
  });

  test("a list that cannot be read says so, as a failure to try again", async () => {
    const failed = await handlersOf({ "/api/sessions": [{ file }] })
      .chat({ file })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AppFailure);
    expect((failed as AppFailure).appError).toMatchObject({ code: "unavailable", retryable: true });
    expect((failed as AppFailure).message).toContain("omp's statistics could not be read");
  });
});

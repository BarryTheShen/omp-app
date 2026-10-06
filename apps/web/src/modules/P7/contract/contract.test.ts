import type { AppClient } from "@omp-app/client";
import type { OmpWire, RpcSessionClient, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  CompactionStateSource,
  SessionContextProjection,
  SessionContextSource,
  UsageStateSource,
} from ".";
import {
  CompactionState,
  ContextUsage,
  ContextUsageState,
  createCompactionPort,
  createContextUsagePort,
  createUsagePort,
  UsageTotals,
  usageTotalsFromWire,
} from ".";

const threadId = "p7-thread" as ThreadId;

function rawStats(): OmpWire.SessionStats {
  return {
    sessionId: threadId,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 4,
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 60, reasoning: 5 },
    premiumRequests: 1,
    cost: 2.5,
    contextUsage: { tokens: 50, contextWindow: 100, percent: 50 },
  };
}

describe("P7 context and usage schemas", () => {
  test("preserves missing context usage separately from zero", () => {
    expect(
      ContextUsageState.parse({
        usage: null,
        isCompacting: false,
        autoCompactionEnabled: null,
        tokensPerSecond: null,
        revision: "r1",
        error: null,
      }).usage,
    ).toBeNull();
    expect(ContextUsage.parse({ tokens: 0, contextWindow: 100, percent: 0 })).toEqual({
      tokens: 0,
      contextWindow: 100,
      percent: 0,
    });
    expect(ContextUsage.safeParse({ tokens: 0, contextWindow: 0, percent: 0 }).success).toBe(false);
  });

  test("maps wire token/cache/cost fields without inferring provider quota", () => {
    const totals = usageTotalsFromWire({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 5,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      premiumRequests: 2,
      reasoningTokens: 1,
    });
    expect(totals).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 5,
      reasoning: 1,
      cost: 1,
      premiumRequests: 2,
    });
    expect(UsageTotals.safeParse({ ...totals, cost: Number.NaN }).success).toBe(false);
  });

  test("projects R0 context snapshots and does not create a second reducer", () => {
    let snapshot: SessionContextProjection = {
      threadId,
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
      isCompacting: false,
      autoCompactionEnabled: true,
      tokensPerSecond: 12,
      revision: "r1",
    };
    const listeners = new Set<() => void>();
    const source: SessionContextSource = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(() => listener(snapshot));
        return () => undefined;
      },
    };
    const port = createContextUsagePort(source);
    expect(port.getSnapshot().usage?.percent).toBe(80);
    // useSyncExternalStore needs the same object until the projection changes.
    expect(port.getSnapshot()).toBe(port.getSnapshot());
    snapshot = { ...snapshot, contextUsage: undefined, revision: "r2" };
    for (const listener of listeners) listener();
    expect(port.getSnapshot().usage).toBeNull();
  });
});

describe("P7 typed RPC adapters", () => {
  test("refreshes usage through get_session_stats and compacts through typed commands", async () => {
    const calls: unknown[] = [];
    const usageSnapshot = {
      sessionId: threadId,
      status: "idle" as const,
      totals: null,
      contextUsage: null,
      tokenRate: null,
      lastTurn: null,
      revision: "r1",
      error: null,
    };
    const usageSource: UsageStateSource = {
      getSnapshot: () => usageSnapshot,
      subscribe: () => () => undefined,
    };
    const compactionSnapshot = {
      phase: "idle" as const,
      method: null,
      auto: false,
      result: null,
      error: null,
      revision: "r1",
    };
    const compactionSource: CompactionStateSource = {
      getSnapshot: () => compactionSnapshot,
      subscribe: () => () => undefined,
    };
    const session = {
      send: async (args: unknown) => {
        calls.push(args);
        const command = (args as { readonly command: { readonly type: string } }).command.type;
        if (command === "get_session_stats") return rawStats();
        if (command === "compact")
          return { summary: "done", firstKeptEntryId: "entry-1", tokensBefore: 100 };
        return undefined;
      },
    } as unknown as RpcSessionClient;
    const client = { port: () => session } as unknown as AppClient;
    const usage = createUsagePort(usageSource, client, threadId);
    const compaction = createCompactionPort(compactionSource, client, threadId);
    const seen: number[] = [];
    usage.subscribe((snapshot) => seen.push(snapshot.totals?.totalTokens ?? 0));
    const refreshed = await usage.refresh();
    expect(refreshed.totals?.totalTokens).toBe(60);
    // The usage popover reads the port, so a refresh must reach the snapshot and subscribers.
    expect(usage.getSnapshot().totals?.totalTokens).toBe(60);
    expect(seen).toEqual([60]);
    await compaction.compact({ customInstructions: "focus" });
    await compaction.setAutoCompaction({ enabled: true });
    expect(
      calls.map((call) => (call as { readonly command: { readonly type: string } }).command.type),
    ).toEqual(["get_session_stats", "compact", "set_auto_compaction"]);
  });

  test("compaction lifecycle state remains source-owned", () => {
    const state = CompactionState.parse({
      phase: "running",
      method: "threshold",
      auto: true,
      result: null,
      error: null,
      revision: "r2",
    });
    expect(state.phase).toBe("running");
    expect(state.auto).toBe(true);
  });
});

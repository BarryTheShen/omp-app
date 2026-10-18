import { CommandRunResult, checkScrubbed, INVENTORY, type ScrubProblem } from "@omp-app/contracts";
import { CompactionState, ContextUsageState, UsageSnapshot } from "../contract";

/** Synthetic, scrubbed snapshots stand in for typed R0/A1 results; no user session is recorded. */
export const P7_INVENTORY_ROWS = INVENTORY.filter((item) =>
  ["P4", "E4", "S4"].includes(item.group),
).map((item) => item.id);

const ERROR = {
  code: "unavailable" as const,
  message: "Provider usage is not available on this host.",
  retryable: true,
};

export const P7_CONTEXT_FIXTURES = [
  ContextUsageState.parse({
    usage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
    isCompacting: false,
    autoCompactionEnabled: true,
    tokensPerSecond: 24.5,
    revision: "context-ready",
    error: null,
  }),
  ContextUsageState.parse({
    usage: null,
    isCompacting: true,
    autoCompactionEnabled: null,
    tokensPerSecond: null,
    revision: "context-compacting",
    error: null,
  }),
  ContextUsageState.parse({
    usage: null,
    isCompacting: false,
    autoCompactionEnabled: null,
    tokensPerSecond: null,
    revision: "context-unavailable",
    error: ERROR,
  }),
] as const;

const TOTALS = {
  input: 12_000,
  output: 4_000,
  cacheRead: 8_000,
  cacheWrite: 1_000,
  totalTokens: 25_000,
  reasoning: 2_000,
  cost: 0.42,
  premiumRequests: 1,
};

export const P7_USAGE_FIXTURES = [
  UsageSnapshot.parse({
    sessionId: "session-fixture-7",
    status: "ready",
    totals: TOTALS,
    contextUsage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
    tokenRate: 24.5,
    lastTurn: {
      timestamp: 1_729_248_000_000,
      durationMs: 2_400,
      timeToFirstTokenMs: 260,
      usage: TOTALS,
    },
    revision: "usage-ready",
    error: null,
  }),
  UsageSnapshot.parse({
    sessionId: "session-fixture-7",
    status: "loading",
    totals: null,
    contextUsage: null,
    tokenRate: null,
    lastTurn: null,
    revision: "usage-loading",
    error: null,
  }),
  UsageSnapshot.parse({
    sessionId: "session-fixture-7",
    status: "error",
    totals: null,
    contextUsage: null,
    tokenRate: null,
    lastTurn: null,
    revision: "usage-error",
    error: ERROR,
  }),
] as const;

export const P7_COMPACTION_FIXTURES = [
  CompactionState.parse({
    phase: "idle",
    method: null,
    auto: false,
    result: null,
    error: null,
    revision: "compact-idle",
  }),
  CompactionState.parse({
    phase: "running",
    method: "remote",
    auto: false,
    result: null,
    error: null,
    revision: "compact-running",
  }),
  CompactionState.parse({
    phase: "completed",
    method: "remote",
    auto: true,
    result: {
      summary: "A shorter conversation summary",
      firstKeptEntryId: "entry-fixture",
      tokensBefore: 120_000,
    },
    error: null,
    revision: "compact-complete",
  }),
  CompactionState.parse({
    phase: "skipped",
    method: "threshold",
    auto: true,
    result: null,
    error: null,
    revision: "compact-skipped",
  }),
  CompactionState.parse({
    phase: "aborted",
    method: "manual",
    auto: false,
    result: null,
    error: { code: "cancelled", message: "Compaction was cancelled.", retryable: false },
    revision: "compact-aborted",
  }),
  CompactionState.parse({
    phase: "error",
    method: "remote",
    auto: false,
    result: null,
    error: {
      code: "omp_error",
      message: "The provider could not compact the conversation.",
      retryable: true,
    },
    revision: "compact-error",
  }),
] as const;

export const P7_COMMAND_RESULTS = [
  CommandRunResult.parse({
    command: "/context",
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: false,
    outputs: [{ text: "Context used: 80%" }],
    sessionUpdates: [],
    configUpdates: [],
  }),
  CommandRunResult.parse({
    command: "/compact remote focus on the open work",
    status: "aborted",
    agentInvoked: true,
    promptSettled: false,
    sessionSettled: true,
    outputs: [{ text: "Compaction was cancelled." }],
    sessionUpdates: [],
    configUpdates: [],
  }),
] as const;

export const P7_SCRUBBED_FIXTURES = {
  context: P7_CONTEXT_FIXTURES,
  usage: P7_USAGE_FIXTURES,
  compaction: P7_COMPACTION_FIXTURES,
  results: P7_COMMAND_RESULTS,
} as const;
export function assertP7FixturesAreScrubbed(): readonly ScrubProblem[] {
  return checkScrubbed(JSON.stringify(P7_SCRUBBED_FIXTURES));
}

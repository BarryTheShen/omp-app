import type { CompactionPort, ContextUsagePort, UsagePort } from "../contract";
import { CompactionControls, ContextMeter, ContextStatusBar } from "./index";

const contextSnapshot = {
  usage: { tokens: 82_000, contextWindow: 128_000, percent: 64.0625 },
  isCompacting: false,
  autoCompactionEnabled: true,
  tokensPerSecond: 24.5,
  revision: "playground-context",
  error: null,
} as const;
const contextPort: ContextUsagePort = {
  getSnapshot: () => contextSnapshot,
  subscribe: () => () => undefined,
};

const usageSnapshot = {
  sessionId: "playground-session",
  status: "ready" as const,
  totals: {
    input: 24_000,
    output: 8_200,
    cacheRead: 16_000,
    cacheWrite: 2_000,
    totalTokens: 32_200,
    reasoning: 4_100,
    cost: 1.284,
    premiumRequests: 3,
  },
  contextUsage: { tokens: 82_000, contextWindow: 128_000, percent: 64.0625 },
  tokenRate: 24.5,
  lastTurn: {
    timestamp: 1_759_600_000_000,
    durationMs: 12_500,
    timeToFirstTokenMs: 620,
    usage: {
      input: 3_000,
      output: 1_200,
      cacheRead: 2_000,
      cacheWrite: 400,
      totalTokens: 4_200,
      reasoning: 700,
      cost: 0.18,
      premiumRequests: 1,
    },
  },
  revision: "playground-usage",
  error: null,
} as const;
const usagePort: UsagePort = {
  getSnapshot: () => usageSnapshot,
  subscribe: () => () => undefined,
  refresh: async () => usageSnapshot,
};

const compactionSnapshot = {
  phase: "idle" as const,
  method: null,
  auto: true,
  result: null,
  error: null,
  revision: "playground-compaction",
} as const;
const compactionPort: CompactionPort = {
  getSnapshot: () => compactionSnapshot,
  subscribe: () => () => undefined,
  compact: async () => ({
    summary: "Compaction complete",
    firstKeptEntryId: "entry-1",
    tokensBefore: 82_000,
  }),
  setAutoCompaction: async () => undefined,
};

export function ContextUsagePlayground() {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Context and usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live context pressure, session totals and compaction controls.
          </p>
        </header>
        {/* The full card (for a panel) and the one-line version the app's status bar uses. */}
        <ContextMeter port={contextPort} />
        <div className="border-border rounded-xl border px-3 py-2" data-testid="p7-status-line">
          <ContextStatusBar
            context={contextPort}
            isStreaming={true}
            usage={usagePort}
            limits={{
              read: async () => ({
                state: "ready" as const,
                fetchedAt: "2026-10-10T04:00:00.000Z",
                providers: [
                  {
                    providerId: "anthropic",
                    windows: [
                      {
                        label: "5 Hour",
                        usedPercent: 41,
                        resetsAt: "2026-10-10T08:30:00.000Z",
                        accounts: 1,
                      },
                    ],
                  },
                ],
              }),
            }}
          />
        </div>
        <CompactionControls port={compactionPort} />
      </div>
    </main>
  );
}

import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ChatSessionClient,
  ChatSessionPort,
  type Omp,
  type OmpCommandGateway,
  type PortCallOptions,
  type PortClient,
  type ThreadId,
} from "@omp-app/contracts";
import type {
  AutoCompactionRequest,
  CompactionState,
  ContextUsage,
  SessionContextProjection,
  UsageTotals,
} from "./models";
import { ContextUsageState, UsageSnapshot } from "./models";

export interface ContextUsagePort {
  readonly getSnapshot: () => ContextUsageState;
  readonly subscribe: (listener: (snapshot: ContextUsageState) => void) => () => void;
}

export interface UsagePort {
  readonly getSnapshot: () => UsageSnapshot;
  readonly subscribe: (listener: (snapshot: UsageSnapshot) => void) => () => void;
  readonly refresh: (options?: Pick<PortCallOptions, "signal">) => Promise<UsageSnapshot>;
}

export interface CompactionPort {
  readonly getSnapshot: () => CompactionState;
  readonly subscribe: (listener: (snapshot: CompactionState) => void) => () => void;
  readonly compact: (
    request?: { readonly customInstructions?: string },
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<Omp.CompactionResult>;
  readonly setAutoCompaction: (
    request: AutoCompactionRequest,
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<void>;
}

export type P7CommandPort = Pick<PortClient<typeof OmpCommandGateway>, "run">;
export type P7CommandResult = Awaited<ReturnType<P7CommandPort["run"]>>;

export interface SessionContextSource {
  readonly getSnapshot: () => SessionContextProjection;
  readonly subscribe: (listener: (snapshot: SessionContextProjection) => void) => () => void;
}

export interface UsageStateSource {
  readonly getSnapshot: () => UsageSnapshot;
  readonly subscribe: (listener: (snapshot: UsageSnapshot) => void) => () => void;
}

export interface CompactionStateSource {
  readonly getSnapshot: () => CompactionState;
  readonly subscribe: (listener: (snapshot: CompactionState) => void) => () => void;
}

const INITIAL_CONTEXT_STATE: ContextUsageState = {
  usage: null,
  isCompacting: false,
  autoCompactionEnabled: null,
  tokensPerSecond: null,
  revision: "initial",
  error: null,
};

function contextState(projection: SessionContextProjection): ContextUsageState {
  return ContextUsageState.parse({
    usage: projection.contextUsage ?? null,
    isCompacting: projection.isCompacting ?? false,
    autoCompactionEnabled: projection.autoCompactionEnabled ?? null,
    tokensPerSecond: projection.tokensPerSecond ?? null,
    revision: projection.revision,
    error: null,
  });
}

/**
 * Projects R0's normalized session snapshot without maintaining a second reducer. The same
 * projection revision returns the same snapshot object, as React's `useSyncExternalStore` requires
 * (a fresh object per read re-renders forever).
 */
export function createContextUsagePort(source: SessionContextSource): ContextUsagePort {
  let cached: ContextUsageState | undefined;
  const read = (projection: SessionContextProjection): ContextUsageState => {
    if (cached?.revision !== projection.revision) cached = contextState(projection);
    return cached;
  };
  return {
    getSnapshot: () => read(source.getSnapshot()),
    subscribe: (listener) => source.subscribe((projection) => listener(read(projection))),
  };
}

function totalsFromWire(usage: Omp.Usage): UsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    reasoning: usage.reasoningTokens ?? null,
    cost: usage.cost.total,
    premiumRequests: usage.premiumRequests ?? null,
  };
}

export function usageTotalsFromWire(usage: Omp.Usage): UsageTotals {
  return totalsFromWire(usage);
}

/**
 * Binds refresh to A0's typed `get_session_stats`. The injected source supplies the live
 * projection; the latest refreshed totals are kept here (omp streams no session totals) and shown
 * until the next refresh, so every subscriber sees the same numbers.
 */
export function createUsagePort(
  source: UsageStateSource,
  client: AppClient,
  threadId: ThreadId,
): UsagePort {
  const session = client.port(ChatSessionPort) as ChatSessionClient;
  const listeners = new Set<(snapshot: UsageSnapshot) => void>();
  let refreshed: UsageSnapshot | null = null;
  const current = (): UsageSnapshot => refreshed ?? source.getSnapshot();
  return {
    getSnapshot: current,
    subscribe: (listener) => {
      listeners.add(listener);
      const unsubscribe = source.subscribe(() => listener(current()));
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    refresh: async (options) => {
      try {
        const stats = await session.request(
          { threadId, method: "get_session_stats", params: {} },
          options,
        );
        const next = UsageSnapshot.parse({
          ...source.getSnapshot(),
          status: "ready",
          sessionId: stats.sessionId,
          totals: totalsFromWire({
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite,
            totalTokens: stats.tokens.total,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: stats.cost,
            },
            premiumRequests: stats.premiumRequests,
            reasoningTokens: stats.tokens.reasoning,
          }),
          contextUsage: stats.contextUsage ?? null,
          error: null,
        });
        refreshed = next;
        for (const listener of listeners) listener(next);
        return next;
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw new AppFailure(
          { code: "internal", message: "Loading session usage failed.", retryable: true },
          { cause: error },
        );
      }
    },
  };
}

/** Calls the host's compaction requests while lifecycle state remains owned by R0's projection. */
export function createCompactionPort(
  source: CompactionStateSource,
  client: AppClient,
  threadId: ThreadId,
): CompactionPort {
  const session = client.port(ChatSessionPort) as ChatSessionClient;
  return {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener) => source.subscribe(listener),
    compact: async (request = {}, options) =>
      session.request(
        {
          threadId,
          method: "compact",
          params: request.customInstructions
            ? { customInstructions: request.customInstructions }
            : {},
        },
        options,
      ),
    setAutoCompaction: async (request, options) => {
      await session.request(
        { threadId, method: "set_auto_compaction", params: { enabled: request.enabled } },
        options,
      );
    },
  };
}

export function initialContextState(): ContextUsageState {
  return INITIAL_CONTEXT_STATE;
}

export function contextPercent(usage: ContextUsage | null): number | null {
  return usage?.percent ?? null;
}

import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  type OmpWire,
  type PortCallOptions,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import {
  type ThinkingApplyRequest,
  type ThinkingCycleDirection,
  ThinkingLevel,
  type ThinkingLevelsPort,
  type ThinkingLevelsResult,
  type ThinkingLevelsSnapshot,
} from "../contract";

const INITIAL_REVISION = "thinking-initial";

type ThinkingSource = {
  readonly getAvailableLevels: (
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<readonly OmpWire.ThinkingLevel[]>;
  readonly setLevel: (
    level: OmpWire.ThinkingLevel,
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<void>;
  readonly cycleLevel: (
    options?: Pick<PortCallOptions, "signal">,
  ) => Promise<OmpWire.ThinkingLevelCycleResult | null>;
};

export type LiveThinkingState = {
  readonly getSnapshot: () => {
    readonly current: ThinkingLevel | null;
    readonly configured: "auto" | ThinkingLevel | null;
    readonly reasoning: boolean;
  };
  readonly subscribe: (
    listener: (snapshot: {
      readonly current: ThinkingLevel | null;
      readonly configured: "auto" | ThinkingLevel | null;
      readonly reasoning: boolean;
    }) => void,
  ) => () => void;
};

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function unavailable(capability: string, message: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    capability: capability as CapabilityKey,
    message,
    retryable: false,
  });
}

function usable(capabilities: CapabilityMap, capability: string): boolean {
  const status = capabilities[capability as keyof CapabilityMap];
  return status?.state === "available" || status?.state === "fallback";
}

function normalizeLevels(
  levels: readonly OmpWire.ThinkingLevel[],
  reasoning: boolean,
): ThinkingLevel[] {
  if (!reasoning) return [];
  const normalized: ThinkingLevel[] = ["off"];
  for (const level of levels) {
    if (ThinkingLevel.safeParse(level).success && !normalized.includes(level as ThinkingLevel))
      normalized.push(level as ThinkingLevel);
  }
  return normalized;
}

function initialSnapshot(live: LiveThinkingState | undefined): ThinkingLevelsSnapshot {
  const current = live?.getSnapshot();
  return {
    loadState: "idle",
    levels: [],
    current: current?.current ?? null,
    configured: current?.configured ?? null,
    reasoning: current?.reasoning ?? true,
    error: null,
  };
}

export class ThinkingLevelsController implements ThinkingLevelsPort {
  private readonly source: ThinkingSource;
  private readonly capabilities: CapabilityMap;
  private readonly listeners = new Set<(snapshot: ThinkingLevelsSnapshot) => void>();
  private snapshot: ThinkingLevelsSnapshot;
  private unsubscribeLive: (() => void) | undefined;

  public constructor(options: {
    readonly source: ThinkingSource;
    readonly capabilities?: CapabilityMap;
    readonly live?: LiveThinkingState;
  }) {
    this.source = options.source;
    this.capabilities = options.capabilities ?? {};
    this.snapshot = initialSnapshot(options.live);
    if (options.live) {
      this.unsubscribeLive = options.live.subscribe((next) => {
        this.commit({
          current: next.current,
          configured: next.configured,
          reasoning: next.reasoning,
          ...(next.reasoning ? {} : { levels: [] }),
        });
      });
    }
  }

  public getSnapshot(): ThinkingLevelsSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: ThinkingLevelsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async refresh(): Promise<ThinkingLevelsResult> {
    if (!usable(this.capabilities, "omp.cmd.get_available_thinking_levels")) {
      const error = unavailable(
        "omp.cmd.get_available_thinking_levels",
        "Thinking level discovery is unavailable.",
      );
      this.commit({ loadState: "error", error: error.appError });
      throw error;
    }
    this.commit({ loadState: "loading", error: null });
    try {
      const levels = normalizeLevels(
        await this.source.getAvailableLevels(),
        this.snapshot.reasoning,
      );
      this.commit({ loadState: "ready", levels, error: null });
      return {
        levels,
        current: this.snapshot.current,
        configured: this.snapshot.configured,
        reasoning: this.snapshot.reasoning,
        revision: INITIAL_REVISION,
      };
    } catch (error) {
      const appFailure = failure(error, "Loading thinking levels failed.");
      this.commit({ loadState: "error", error: appFailure.appError });
      throw appFailure;
    }
  }

  public async apply(request: ThinkingApplyRequest): Promise<ThinkingLevelsResult> {
    if (!usable(this.capabilities, "omp.cmd.set_thinking_level"))
      throw unavailable("omp.cmd.set_thinking_level", "Setting the thinking level is unavailable.");
    if (!this.snapshot.reasoning)
      throw unavailable(
        "omp.cmd.set_thinking_level",
        "The current model does not support thinking levels.",
      );
    if (!this.snapshot.levels.includes(request.level))
      throw new AppFailure({
        code: "invalid_args",
        message: "That thinking level is not supported by the current model.",
        retryable: false,
      });
    try {
      await this.source.setLevel(request.level);
      this.commit({ current: request.level, error: null });
      return {
        levels: [...this.snapshot.levels],
        current: request.level,
        configured: this.snapshot.configured,
        reasoning: this.snapshot.reasoning,
        revision: INITIAL_REVISION,
      };
    } catch (error) {
      const appFailure = failure(error, "Setting the thinking level failed.");
      this.commit({ error: appFailure.appError });
      throw appFailure;
    }
  }

  public async cycle(direction: ThinkingCycleDirection): Promise<ThinkingLevelsResult> {
    if (!usable(this.capabilities, "omp.cmd.cycle_thinking_level"))
      throw unavailable("omp.cmd.cycle_thinking_level", "Cycling thinking levels is unavailable.");
    if (!this.snapshot.reasoning || this.snapshot.levels.length === 0)
      throw unavailable(
        "omp.cmd.set_thinking_level",
        "The current model does not support thinking levels.",
      );
    try {
      let next: ThinkingLevel | null = null;
      if (direction === "forward") {
        const result = await this.source.cycleLevel();
        next =
          result && ThinkingLevel.safeParse(result.level).success
            ? (result.level as ThinkingLevel)
            : null;
      }
      if (next === null) {
        const index =
          this.snapshot.current === null ? -1 : this.snapshot.levels.indexOf(this.snapshot.current);
        const offset = direction === "forward" ? 1 : -1;
        next =
          this.snapshot.levels[
            (index + offset + this.snapshot.levels.length) % this.snapshot.levels.length
          ] ?? null;
        if (next !== null) await this.source.setLevel(next);
      }
      this.commit({ current: next, error: null });
      return {
        levels: [...this.snapshot.levels],
        current: next,
        configured: this.snapshot.configured,
        reasoning: this.snapshot.reasoning,
        revision: INITIAL_REVISION,
      };
    } catch (error) {
      const appFailure = failure(error, "Cycling thinking levels failed.");
      this.commit({ error: appFailure.appError });
      throw appFailure;
    }
  }

  public dispose(): void {
    this.unsubscribeLive?.();
    this.unsubscribeLive = undefined;
    this.listeners.clear();
  }

  private commit(patch: Partial<ThinkingLevelsSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export function createRpcThinkingSource(client: AppClient, threadId: ThreadId): ThinkingSource {
  const session = client.port(RpcSessionPort) as RpcSessionClient;
  return {
    getAvailableLevels: async (options) =>
      (
        (await session.send(
          { threadId, command: { type: "get_available_thinking_levels" } },
          options,
        )) as OmpWire.GetAvailableThinkingLevelsResult
      ).levels,
    setLevel: async (level, options) => {
      await session.send({ threadId, command: { type: "set_thinking_level", level } }, options);
    },
    cycleLevel: async (options) =>
      (await session.send(
        { threadId, command: { type: "cycle_thinking_level" } },
        options,
      )) as OmpWire.ThinkingLevelCycleResult | null,
  };
}

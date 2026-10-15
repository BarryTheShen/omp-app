import type { AgentStatus } from "@/modules/P1/contract";
import {
  FIXTURE_START,
  fixtureAgent,
  fixtureSessionFile,
  HOUR_MS,
  lifecycleEvent,
  progressEvent,
  type RosterStep,
  SECOND_MS,
} from "./common";

/**
 * omp's progress record for a running worker (a `sleep 60` in bash), recorded from real omp 18.8.9 and
 * copied as omp sent it: its keys and value types are omp's. The roster test (`roster/test/roster.test.ts`)
 * keeps the same record. The floor is omp 18.6.1; the record's open keys are read only where P1 allow-lists them.
 */
export const RECORDED_PROGRESS: Readonly<Record<string, unknown>> = {
  index: 0,
  id: "LongProbe",
  agent: "task",
  agentSource: "bundled",
  status: "running",
  task: "Complete assignment thoroughly:\n\nlong_probe_child: run one slow step.",
  assignment: "long_probe_child: run one slow step.",
  recentTools: [],
  recentOutput: [],
  toolCount: 1,
  requests: 1,
  tokens: 15,
  cost: 0,
  durationMs: 105,
  modelOverride: ["fake/fake-model"],
  contextWindow: 128000,
  resolvedModelIdentity: "fake/fake-model",
  resolvedThinkingLevel: "high",
  resolvedModel: "fake/fake-model:high",
  resolvedModelIsFallback: false,
  contextTokens: 15,
  currentTool: "bash",
  currentToolArgs: "sleep 60; echo long-probe-done",
  currentToolArgsKey: "command",
  currentToolStartMs: 1791731667364,
};

/**
 * P1's retention decision (research/modules/P1.md, "Retention decision"): a finished worker stays in the
 * recent list for 24 hours from its terminal event, and at most the newest 100 finished workers per thread
 * are kept, whichever limit is reached first.
 */
export const P1_RETENTION_POLICY = {
  tombstoneTtlMs: 24 * HOUR_MS,
  tombstoneLimit: 100,
} as const;

/** One worker the roster must hold after a scenario. `durationMs: null` means omp reported none. */
export interface WorkerExpectation {
  readonly id: string;
  readonly status: AgentStatus;
  readonly durationMs?: number | null;
}

export interface RosterScenario {
  readonly name: string;
  readonly steps: readonly RosterStep[];
  /** Live workers after the last step, in roster order. */
  readonly active: readonly WorkerExpectation[];
  /** Finished workers still retained, most recent first. */
  readonly recent: readonly WorkerExpectation[];
}

const START = FIXTURE_START;

/** Snapshot and lifecycle ordering: what the roster keeps when frames and snapshots interleave. */
export const ROSTER_ORDERING_SCENARIOS: readonly RosterScenario[] = [
  {
    name: "a completed worker keeps a finished record",
    steps: [
      { kind: "snapshot", at: START, agents: [fixtureAgent("worker-1", 0)] },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: lifecycleEvent("worker-1", 0, "completed"),
      },
    ],
    active: [],
    recent: [{ id: "worker-1", status: "completed" }],
  },
  {
    name: "a frame older than the last one applied is dropped",
    steps: [
      { kind: "snapshot", at: START, agents: [fixtureAgent("worker-2", 0)] },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 2,
        event: lifecycleEvent("worker-2", 0, "failed"),
      },
      {
        kind: "frame",
        at: START + 2 * SECOND_MS,
        seq: 1,
        event: lifecycleEvent("worker-2", 0, "completed"),
      },
    ],
    active: [],
    recent: [{ id: "worker-2", status: "failed" }],
  },
  {
    name: "a worker missing from the next snapshot keeps its terminal state",
    steps: [
      { kind: "snapshot", at: START, agents: [fixtureAgent("worker-3", 0)] },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: lifecycleEvent("worker-3", 0, "aborted"),
      },
      { kind: "snapshot", at: START + 2 * SECOND_MS, agents: [] },
    ],
    active: [],
    recent: [{ id: "worker-3", status: "aborted" }],
  },
  {
    name: "a stale snapshot never turns a finished worker back into a running one",
    steps: [
      { kind: "snapshot", at: START, agents: [fixtureAgent("worker-4", 0)] },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: lifecycleEvent("worker-4", 0, "completed"),
      },
      {
        kind: "snapshot",
        at: START + 2 * SECOND_MS,
        agents: [fixtureAgent("worker-4", 0, { lastUpdate: START })],
      },
    ],
    active: [],
    recent: [{ id: "worker-4", status: "completed" }],
  },
  {
    name: "a reused id starts a new worker and the old tombstone stays",
    steps: [
      { kind: "snapshot", at: START, agents: [fixtureAgent("worker-5", 0)] },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: lifecycleEvent("worker-5", 0, "completed"),
      },
      {
        kind: "frame",
        at: START + 2 * SECOND_MS,
        seq: 2,
        event: lifecycleEvent("worker-5", 0, "started"),
      },
    ],
    active: [{ id: "worker-5", status: "running" }],
    recent: [{ id: "worker-5", status: "completed" }],
  },
  {
    name: "a frame that arrives before the snapshot is not duplicated by it",
    steps: [
      {
        kind: "frame",
        at: START,
        seq: 1,
        event: lifecycleEvent("worker-6", 0, "started"),
      },
      {
        kind: "snapshot",
        at: START + SECOND_MS,
        agents: [fixtureAgent("worker-6", 0, { lastUpdate: START })],
      },
    ],
    active: [{ id: "worker-6", status: "running" }],
    recent: [],
  },
];

/** Progress joins: a progress record lands only on the running worker it describes. */
export const PROGRESS_JOIN_SCENARIOS: readonly RosterScenario[] = [
  {
    name: "a progress record joins the running worker with its index and session file",
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: [fixtureAgent("worker-7", 0, { sessionFile: fixtureSessionFile("worker-7") })],
      },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: progressEvent(
          0,
          { ...RECORDED_PROGRESS, id: "worker-7" },
          fixtureSessionFile("worker-7"),
        ),
      },
    ],
    active: [{ id: "worker-7", status: "running", durationMs: 105 }],
    recent: [],
  },
  {
    name: "a finished worker's later progress record is ignored",
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: [fixtureAgent("worker-8", 0, { sessionFile: fixtureSessionFile("worker-8") })],
      },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: progressEvent(
          0,
          { ...RECORDED_PROGRESS, id: "worker-8" },
          fixtureSessionFile("worker-8"),
        ),
      },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 2,
        event: lifecycleEvent("worker-8", 0, "completed", fixtureSessionFile("worker-8")),
      },
      {
        kind: "frame",
        at: START + 5 * SECOND_MS,
        seq: 3,
        event: progressEvent(
          0,
          { ...RECORDED_PROGRESS, id: "worker-8", durationMs: 999 },
          fixtureSessionFile("worker-8"),
        ),
      },
    ],
    active: [],
    recent: [{ id: "worker-8", status: "completed", durationMs: 105 }],
  },
  {
    name: "a progress record for an index no running worker holds joins nothing",
    steps: [
      { kind: "snapshot", at: START, agents: [fixtureAgent("worker-9", 0)] },
      {
        kind: "frame",
        at: START + SECOND_MS,
        seq: 1,
        event: progressEvent(3, { ...RECORDED_PROGRESS, id: "worker-9", index: 3 }),
      },
    ],
    active: [{ id: "worker-9", status: "running", durationMs: null }],
    recent: [],
  },
];

/** 101 workers finish one after another, one second apart; the last one is the newest. */
const FINISHED_BURST: readonly RosterStep[] = Array.from({ length: 101 }, (_, index) => ({
  kind: "frame" as const,
  at: START + index * SECOND_MS,
  seq: index + 1,
  event: lifecycleEvent(`finished-${index}`, index, "completed"),
}));

/** Retention and eviction: the 24-hour window and the newest-100 cap, and what neither ever removes. */
export const RETENTION_SCENARIOS: readonly RosterScenario[] = [
  {
    name: "101 finished workers keep the newest 100 and evict the oldest",
    steps: FINISHED_BURST,
    active: [],
    recent: Array.from({ length: P1_RETENTION_POLICY.tombstoneLimit }, (_, offset) => ({
      id: `finished-${P1_RETENTION_POLICY.tombstoneLimit - offset}`,
      status: "completed" as const,
    })),
  },
  {
    name: "a finished worker is still retained one millisecond before 24 hours",
    steps: [
      {
        kind: "frame",
        at: START,
        seq: 1,
        event: lifecycleEvent("expiring", 0, "completed"),
      },
      { kind: "snapshot", at: START + P1_RETENTION_POLICY.tombstoneTtlMs - 1, agents: [] },
    ],
    active: [],
    recent: [{ id: "expiring", status: "completed" }],
  },
  {
    name: "a finished worker expires at exactly 24 hours",
    steps: [
      {
        kind: "frame",
        at: START,
        seq: 1,
        event: lifecycleEvent("expiring", 0, "completed"),
      },
      { kind: "snapshot", at: START + P1_RETENTION_POLICY.tombstoneTtlMs, agents: [] },
    ],
    active: [],
    recent: [],
  },
  {
    name: "live workers are never evicted by age or by count",
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: Array.from({ length: 150 }, (_, index) => fixtureAgent(`live-${index}`, index)),
      },
      {
        kind: "snapshot",
        at: START + 48 * HOUR_MS,
        agents: Array.from({ length: 150 }, (_, index) => fixtureAgent(`live-${index}`, index)),
      },
    ],
    active: Array.from({ length: 150 }, (_, index) => ({
      id: `live-${index}`,
      status: "running" as const,
    })),
    recent: [],
  },
];

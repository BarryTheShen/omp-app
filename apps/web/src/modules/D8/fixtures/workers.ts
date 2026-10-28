import { type CapabilityMap, CapabilityStatus, ThreadId } from "@omp-app/contracts";
import {
  AgentRefSchema,
  type AgentSource,
  type AgentStatus,
  P1CapabilityKeys,
} from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import type { RecordedFixture } from "./recorded";

/** The keys of omp's record for one worker that the workers panel reads, copied from the recorded result. */
export interface WorkerRecord {
  readonly id: string;
  readonly status: AgentStatus;
  /** The agent source omp's record carries. A wait job's record carries none, so its value is left out. */
  readonly agentSource?: AgentSource;
  readonly label?: string;
  readonly task?: string;
  readonly durationMs: number;
  readonly resolvedModel?: string;
  readonly modelRole?: string;
  readonly completionPercent?: number;
  readonly toolCount?: number;
  readonly requests?: number;
  readonly tokens?: number;
  readonly cost?: number;
}

export const WORKERS_NOW = 1_789_145_400_000;
const WORKERS_THREAD = ThreadId.parse("d8-fixture-thread");

/**
 * Workers from T5's recorded results: three wait-job records (two running, one failed) and one task progress record
 * (pending). Each wait job's type is `task`; only the progress record names an agent source.
 */
export const RECORDED_WORKERS: readonly RecordedFixture<WorkerRecord>[] = [
  {
    name: "wait: two running tasks and a finished command",
    origin: "modules/T5/fixtures/real-results.ts:62-73",
    value: {
      id: "ScoutOne",
      status: "running",
      label: "ScoutOne",
      durationMs: 366967,
      resolvedModel: "openai-codex/gpt-5.6-luna:max",
      completionPercent: 35,
    },
  },
  {
    name: "wait: two running tasks and a finished command",
    origin: "modules/T5/fixtures/real-results.ts:74-85",
    value: {
      id: "ScoutTwo",
      status: "running",
      label: "ScoutTwo",
      durationMs: 366967,
      resolvedModel: "openai-codex/gpt-5.6-luna:max",
      completionPercent: 60,
    },
  },
  {
    name: "wait: a task that failed, with its error",
    origin: "modules/T5/fixtures/real-results.ts:122-141",
    value: {
      id: "ScoutThree",
      status: "failed",
      label: "ScoutThree",
      durationMs: 975453,
      resolvedModel: "openai-codex/gpt-5.6-luna:max",
    },
  },
  {
    name: "task: one agent started in the background",
    origin: "modules/T5/fixtures/real-results.ts:479-495",
    value: {
      id: "BuilderTwo",
      status: "pending",
      agentSource: "bundled",
      task: "Build one part of the app and open its pull request.",
      durationMs: 0,
      modelRole: "task",
      toolCount: 0,
      requests: 0,
      tokens: 0,
      cost: 0,
    },
  },
];

/**
 * The workers panel's roster, built from the recorded records with the clock fixed at WORKERS_NOW. A record that names no
 * agent source gets "unknown", the source P1 shows for a worker whose source omp did not say. The agent type is `task`,
 * the job type every recorded record carries. A failed worker's end time is the snapshot's time, because its recording
 * gives no end time.
 */
export function recordedWorkerRoster(): AgentRosterStoreSnapshot {
  const agents: Record<string, RosterAgent> = {};
  const order: string[] = [];
  const active: string[] = [];
  const recent: string[] = [];
  RECORDED_WORKERS.forEach(({ value }, index) => {
    const key = `${value.id}:0`;
    const ended = value.status === "failed";
    const ref = AgentRefSchema.parse({
      id: value.id,
      index,
      agent: "task",
      agentSource: value.agentSource ?? "unknown",
      status: value.status,
      lastUpdate: WORKERS_NOW,
      description: value.label ?? value.task,
      threadId: WORKERS_THREAD,
    });
    agents[key] = {
      ...ref,
      key,
      incarnation: 0,
      terminalAt: ended ? WORKERS_NOW : null,
      lifecycleSeq: null,
      progressSeq: null,
      metrics: { durationMs: value.durationMs, receivedAt: WORKERS_NOW, raw: { ...value } },
    };
    order.push(key);
    if (ended) recent.push(key);
    else active.push(key);
  });
  return { threadId: WORKERS_THREAD, revision: 1, lastSeq: 0, agents, order, active, recent };
}

/**
 * Worker command capabilities for the test: the roster, transcript, cancel and event states are assumed available. No
 * recording on main shows them.
 */
export const OMP_WORKER_CAPABILITIES: CapabilityMap = {
  [P1CapabilityKeys.roster]: CapabilityStatus.parse({ state: "available", via: "omp" }),
  [P1CapabilityKeys.transcript]: CapabilityStatus.parse({ state: "available", via: "omp" }),
  [P1CapabilityKeys.cancel]: CapabilityStatus.parse({ state: "available", via: "omp" }),
  [P1CapabilityKeys.events]: CapabilityStatus.parse({ state: "available", via: "omp" }),
};

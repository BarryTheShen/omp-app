import type { SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import type { P1ClientNotification, SubagentClient } from "@/modules/P1/client";
import type { AgentRef, SubagentTranscriptPage } from "@/modules/P1/contract";

/**
 * A worker's progress as omp reported it. The roster reads one field from it, `durationMs`, which freezes a finished
 * worker's time. The hub reads every other field from `raw` with omp's own keys (`readWorkerMetrics` in P1/panels).
 */
export interface AgentProgressMetrics {
  /** omp's `durationMs` at its last report; undefined until omp reports one. */
  readonly durationMs?: number;
  /** When the roster received these metrics, on the roster clock; a running worker's time moves on from here. */
  readonly receivedAt: number;
  /** omp's progress record as omp sent it. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface RosterAgent extends AgentRef {
  /** Stable within this roster even if omp reuses a subagent id after a worker exits. */
  readonly key: string;
  readonly incarnation: number;
  readonly terminalAt: number | null;
  readonly lifecycleSeq: number | null;
  readonly progressSeq: number | null;
  readonly metrics: AgentProgressMetrics;
}

export interface AgentRosterStoreSnapshot {
  readonly threadId: ThreadId;
  readonly revision: number;
  readonly lastSeq: number;
  readonly agents: Readonly<Record<string, RosterAgent>>;
  readonly order: readonly string[];
  readonly active: readonly string[];
  readonly recent: readonly string[];
}

export type AgentRosterListener = (snapshot: AgentRosterStoreSnapshot) => void;

export interface RosterClock {
  now(): number;
}

export interface RosterRuntimeSource {
  readonly threadId: ThreadId;
}

export interface AgentRosterStoreOptions {
  readonly threadId: ThreadId;
  readonly client: SubagentClient;
  readonly runtime?: RosterRuntimeSource;
  readonly finished?: FinishedWorkerSource | undefined;
  readonly clock?: RosterClock;
  readonly tombstoneTtlMs?: number;
  readonly tombstoneLimit?: number;
}

export type RosterNotification = P1ClientNotification;

export type RosterAgentKey = `${SubagentId}:${number}`;

/** A worker that ended in this chat, found in its transcript rather than in omp's live roster. */
export interface FinishedWorker {
  readonly agent: AgentRef;
  /** When the worker ended, in epoch milliseconds; its retention starts here. */
  readonly endedAt: number;
}

/**
 * The chat's finished workers and their transcripts, read from the chat's own files. omp forgets a
 * worker once it finishes, so after a reload these files are the only record of it.
 */
export interface FinishedWorkerSource {
  list(): Promise<readonly FinishedWorker[]>;
  read(sessionFile: SessionFilePath, fromByte?: number): Promise<SubagentTranscriptPage>;
}

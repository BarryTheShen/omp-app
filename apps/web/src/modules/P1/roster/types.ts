import type { SubagentId, ThreadId } from "@omp-app/contracts";
import type { P1ClientNotification, SubagentClient } from "@/modules/P1/client";
import type { AgentRef } from "@/modules/P1/contract";

export interface AgentProgressMetrics {
  readonly percent?: number;
  readonly model?: string;
  readonly role?: string;
  readonly usage?: unknown;
  readonly context?: unknown;
  readonly cost?: unknown;
  readonly durationMs?: number;
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
  readonly clock?: RosterClock;
  readonly tombstoneTtlMs?: number;
  readonly tombstoneLimit?: number;
}

export type RosterNotification = P1ClientNotification;

export type RosterAgentKey = `${SubagentId}:${number}`;

import type { CapabilityMap } from "@omp-app/contracts";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import {
  readWorkerMetrics,
  type StatusPresentation,
  statusPresentation,
} from "@/modules/P1/panels/model";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import type { PanelActionAvailability } from "@/modules/U5/panel/contract";

/** Stop for one worker: offered only while omp lists it as running, and "stopping" while its stop is in flight. */
export type StopControl =
  | { readonly state: "hidden" }
  | { readonly state: "available" }
  | { readonly state: "stopping" };

/** One worker as the workers panel shows it. Every string is plain English; ids are kept only for actions. */
export interface WorkerRowModel {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: StatusPresentation;
  readonly active: boolean;
  readonly elapsed: string | null;
  readonly model: string | null;
  /** What a running worker is doing now, as omp reports it; null once the worker has ended. */
  readonly step: string | null;
  readonly toolCalls: string | null;
  readonly usage: string | null;
  readonly lineage: string | null;
  readonly transcript: PanelActionAvailability;
  readonly stop: StopControl;
}

export interface WorkersPanelModel {
  readonly rows: readonly WorkerRowModel[];
  readonly activeCount: number;
}

export interface WorkersModelInput {
  readonly snapshot: AgentRosterStoreSnapshot;
  readonly now: number;
  readonly capabilities: CapabilityMap;
  /** Workers whose stop is in flight, by id. */
  readonly stopping?: ReadonlySet<string>;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const NO_STOPS: ReadonlySet<string> = new Set();
const COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** A duration in plain words: "45 seconds", "2 minutes 5 seconds", "1 hour 3 minutes". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const unit = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;
  const parts = [
    hours > 0 ? unit(hours, "hour") : null,
    minutes > 0 ? unit(minutes, "minute") : null,
    hours === 0 && (seconds > 0 || minutes === 0) ? unit(seconds, "second") : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" ");
}

const MAX_MODEL_LENGTH = 160;

function modelText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length > MAX_MODEL_LENGTH ? `${text.slice(0, MAX_MODEL_LENGTH - 1)}…` : text;
}

function modelValue(value: unknown): string | null {
  if (!Array.isArray(value)) return modelText(value);
  for (const candidate of value) {
    const text = modelText(candidate);
    if (text !== null) return text;
  }
  return null;
}

function modelOf(agent: RosterAgent): string | null {
  return modelValue(agent.metrics.raw.resolvedModel) ?? modelValue(agent.metrics.raw.modelOverride);
}

/**
 * How long a worker has run. omp's last report is frozen for a non-running worker; a running one keeps counting
 * from the moment the roster received that report, on the roster clock.
 */
export function elapsedOf(agent: RosterAgent, now: number): string | null {
  const reported = agent.metrics.durationMs;
  if (reported === undefined || agent.status === "pending") return null;
  const ms =
    agent.status === "running" ? reported + Math.max(0, now - agent.metrics.receivedAt) : reported;
  return formatElapsed(ms);
}

/** How many tool calls a worker has made, in words; null when omp reported none. */
function toolCallsOf(count: number | null): string | null {
  if (count === null || count === 0) return null;
  return `${COUNT_FORMAT.format(count)} tool ${count === 1 ? "call" : "calls"}`;
}

/** Tokens and cost as omp reported them; null when omp reported neither. */
export function usageOf(agent: RosterAgent): string | null {
  const metrics = readWorkerMetrics(agent.metrics.raw);
  const parts: string[] = [];
  if (metrics.tokens !== null) parts.push(`${COUNT_FORMAT.format(metrics.tokens)} tokens`);
  if (metrics.cost !== null) parts.push(`Cost ${COST_FORMAT.format(metrics.cost)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Where the worker started: the tool call in this chat that omp names, or null when omp does not say (a worker read back from a transcript carries none). */
export function lineageOf(agent: RosterAgent): string | null {
  return agent.parentToolCallId === undefined ? null : "Started from this chat";
}

function transcriptAvailability(
  agent: RosterAgent,
  capabilities: CapabilityMap,
): PanelActionAvailability {
  if (capabilities[P1CapabilityKeys.transcript]?.state !== "available") {
    return {
      state: "unavailable",
      reason: "Reading worker transcripts is not available in this connection.",
      capability: P1CapabilityKeys.transcript,
    };
  }
  if (agent.sessionFile === undefined) {
    return { state: "unavailable", reason: "omp has not saved this worker's transcript yet." };
  }
  return { state: "available" };
}

/**
 * Stop is offered only for a worker omp lists as running, and only when omp can cancel: a queued worker has nothing to
 * stop, and an ended one is finished. The stop in flight reads "Stopping...".
 */
function stopControlOf(
  agent: RosterAgent,
  capabilities: CapabilityMap,
  stopping: ReadonlySet<string>,
): StopControl {
  if (agent.status !== "running" || agent.terminalAt !== null) return { state: "hidden" };
  if (capabilities[P1CapabilityKeys.cancel]?.state !== "available") return { state: "hidden" };
  return stopping.has(agent.id) ? { state: "stopping" } : { state: "available" };
}

function rowOf(
  agent: RosterAgent,
  active: boolean,
  now: number,
  capabilities: CapabilityMap,
  stopping: ReadonlySet<string>,
): WorkerRowModel {
  return {
    key: agent.key,
    id: agent.id,
    title: agent.description?.trim() || agent.agent || "Worker",
    detail: agent.agent,
    status: statusPresentation(agent.status),
    active,
    elapsed: elapsedOf(agent, now),
    model: modelOf(agent),
    step: active ? readWorkerMetrics(agent.metrics.raw).step : null,
    toolCalls: toolCallsOf(readWorkerMetrics(agent.metrics.raw).toolCalls),
    usage: usageOf(agent),
    lineage: lineageOf(agent),
    transcript: transcriptAvailability(agent, capabilities),
    stop: stopControlOf(agent, capabilities, stopping),
  };
}

/**
 * The workers panel's data: every worker the roster holds, active first, with what each action would need.
 * Pure: the same roster, clock and capabilities always give the same model.
 */
export function buildWorkersModel({
  snapshot,
  now,
  capabilities,
  stopping = NO_STOPS,
}: WorkersModelInput): WorkersPanelModel {
  const activeKeys = new Set(snapshot.active);
  const rows = [...snapshot.active, ...snapshot.recent].flatMap((key) => {
    const agent = snapshot.agents[key];
    if (agent === undefined) return [];
    return [rowOf(agent, activeKeys.has(key), now, capabilities, stopping)];
  });
  return { rows, activeCount: snapshot.active.length };
}

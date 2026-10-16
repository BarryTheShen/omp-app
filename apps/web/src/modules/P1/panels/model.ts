import type { AppError } from "@omp-app/contracts";
import type { AgentStatus } from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import type { PanelLifecycle } from "@/modules/U5/panel/contract";

/** The panel title: the words the terminal uses for `/agents`. */
export const HUB_TITLE = "Agent Hub";

export type HubView = "list" | "byParent";
export type WorkerTone = "info" | "success" | "danger" | "muted" | "neutral";

export interface StatusPresentation {
  readonly status: AgentStatus;
  readonly label: string;
  readonly tone: WorkerTone;
}

/** Labels follow U3's tool-card words (Running, Cancelled); a finished worker reads "Finished". */
const STATUS_PRESENTATION: Readonly<Record<AgentStatus, StatusPresentation>> = {
  pending: { status: "pending", label: "Queued", tone: "neutral" },
  running: { status: "running", label: "Running", tone: "info" },
  completed: { status: "completed", label: "Finished", tone: "success" },
  failed: { status: "failed", label: "Failed", tone: "danger" },
  aborted: { status: "aborted", label: "Cancelled", tone: "muted" },
  stopped: { status: "stopped", label: "Stopped", tone: "neutral" },
};

export function statusPresentation(status: AgentStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}

/** Where a worker's agent type comes from. A worker found in its file records no source, so none is printed. */
const SOURCE_LABELS: Readonly<Record<Exclude<RosterAgent["agentSource"], "unknown">, string>> = {
  bundled: "built in",
  user: "your agents",
  project: "this project",
};

/** A source's label, or null when the source is not known. */
function sourceLabelOf(source: RosterAgent["agentSource"]): string | null {
  return source === "unknown" ? null : SOURCE_LABELS[source];
}

/** The agent type with its source in brackets, keeping only the parts that are known. */
function agentTypeLabel(agent: Pick<RosterAgent, "agent" | "agentSource">): string | null {
  const source = sourceLabelOf(agent.agentSource);
  if (agent.agent.length === 0) return source;
  return source === null ? agent.agent : `${agent.agent} (${source})`;
}

/** The line under a worker's title: its agent type and source, only where they are known. */
function subtitleOf(agent: Pick<RosterAgent, "agent" | "agentSource">): string {
  return [agent.agent, sourceLabelOf(agent.agentSource)]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}

const MAX_TEXT_LENGTH = 160;
const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
const CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export interface WorkerMetrics {
  readonly step: string | null;
  readonly model: string | null;
  readonly toolCalls: number | null;
  readonly requests: number | null;
  readonly tokens: number | null;
  readonly cost: number | null;
  readonly durationMs: number | null;
}

/**
 * Reads only the progress fields this panel shows, each checked by type. omp's progress record is
 * open-ended, so any other key is ignored and never rendered.
 */
export function readWorkerMetrics(raw: Readonly<Record<string, unknown>>): WorkerMetrics {
  const tool = readText(raw.currentTool);
  return {
    step: tool ? `Using ${tool}` : readText(raw.lastIntent),
    model: readText(raw.resolvedModel) ?? readText(raw.modelOverride) ?? readText(raw.modelRole),
    toolCalls: readCount(raw.toolCount),
    requests: readCount(raw.requests),
    tokens: readCount(raw.tokens),
    cost:
      typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null,
    durationMs: readCount(raw.durationMs),
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min ${totalSeconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatCost(usd: number): string {
  return COST_FORMAT.format(usd);
}

export function formatClock(epochMs: number): string {
  return CLOCK_FORMAT.format(new Date(epochMs));
}

/** The worker's name: its description, else the id omp prints in chat ("Spawned agent <id>"). */
export function workerTitle(agent: Pick<RosterAgent, "description" | "id">): string {
  return agent.description?.trim() || agent.id;
}

/** A worker's time: omp's last reported duration, moved on by the time since the roster received it while it runs. */
function durationAt(agent: RosterAgent, now: number): number | null {
  const { durationMs } = readWorkerMetrics(agent.metrics.raw);
  if (durationMs === null || agent.status !== "running") return durationMs;
  return durationMs + Math.max(0, now - agent.metrics.receivedAt);
}

function rowSummary(agent: RosterAgent, now: number): string {
  const metrics = readWorkerMetrics(agent.metrics.raw);
  const at = agent.terminalAt ?? agent.lastUpdate;
  switch (agent.status) {
    case "pending":
      return "Waiting to start";
    case "running": {
      const durationMs = durationAt(agent, now);
      return [metrics.step ?? "Working", durationMs === null ? null : formatDuration(durationMs)]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "completed":
      return `Finished at ${formatClock(at)}`;
    case "failed":
      return `Failed at ${formatClock(at)}`;
    case "aborted":
      return `Cancelled at ${formatClock(at)}`;
    case "stopped":
      return `Stopped at ${formatClock(at)}`;
  }
}

export interface WorkerRow {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly status: StatusPresentation;
  readonly selected: boolean;
}

export interface HubSection {
  readonly key: string;
  readonly heading: string;
  readonly rows: readonly WorkerRow[];
}

export interface HubFact {
  readonly label: string;
  readonly value: string;
}

export type ActionAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string };

export type CancelControl =
  | { readonly state: "hidden" }
  | { readonly state: "ready" }
  | { readonly state: "sending" }
  | { readonly state: "sent" }
  | { readonly state: "failed"; readonly message: string; readonly retryable: boolean }
  | { readonly state: "ended"; readonly message: string }
  | { readonly state: "refused"; readonly message: string }
  | { readonly state: "unavailable"; readonly reason: string };

export interface HubInspector {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly status: StatusPresentation;
  readonly facts: readonly HubFact[];
  readonly progress: readonly HubFact[];
  readonly step: string | null;
  readonly task: string | null;
  readonly cancel: CancelControl;
  readonly transcript: ActionAvailability;
}

export interface HubModel {
  readonly title: string;
  readonly lifecycle: PanelLifecycle;
  readonly description: string | null;
  /** True while a worker runs, so the panel's clock moves on once a second. */
  readonly running: boolean;
  readonly error: AppError | null;
  readonly view: HubView;
  readonly sections: readonly HubSection[];
  readonly inspector: HubInspector | null;
}

/** What the roster is doing for the panel: the load outcome the composition reports. */
export type HubLoad =
  | { readonly state: "loading" }
  | { readonly state: "ready" }
  | { readonly state: "error"; readonly error: AppError }
  | { readonly state: "unavailable"; readonly reason: string };

/** A cancel call that is in flight, has been accepted by omp, or has failed. */
export type CancelPhase =
  | { readonly state: "sending" }
  | { readonly state: "sent" }
  | { readonly state: "failed"; readonly error: AppError }
  /** omp answered that it could not stop the worker, and its re-read lists the worker as still running. */
  | { readonly state: "refused" };

export interface HubModelInput {
  readonly roster: AgentRosterStoreSnapshot;
  readonly load: HubLoad;
  readonly view: HubView;
  readonly selectedKey: string | null;
  readonly cancels: Readonly<Record<string, CancelPhase>>;
  readonly cancelAction: ActionAvailability;
  readonly transcriptAction: ActionAvailability;
  /** The clock time durations are read at: a running worker's time is omp's report plus the time since. */
  readonly now: number;
}

const UNKNOWN_PARENT = "";

function isActive(agent: RosterAgent): boolean {
  return agent.terminalAt === null;
}

/** Numbers the task calls that started workers, in the order their first worker started. */
function taskCallNumbers(agents: readonly RosterAgent[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const agent of agents) {
    const parent = agent.parentToolCallId;
    if (parent && !numbers.has(parent)) numbers.set(parent, numbers.size + 1);
  }
  return numbers;
}

function parentLabel(agent: RosterAgent, numbers: ReadonlyMap<string, number>): string {
  const number = agent.parentToolCallId ? numbers.get(agent.parentToolCallId) : undefined;
  return number === undefined ? "This chat" : `Task call ${number} in this chat`;
}

function groupHeading(parent: string, numbers: ReadonlyMap<string, number>): string {
  const number = numbers.get(parent);
  return number === undefined ? "Started from this chat" : `From task call ${number}`;
}

function toRow(agent: RosterAgent, selectedKey: string | null, now: number): WorkerRow {
  return {
    key: agent.key,
    title: workerTitle(agent),
    summary: rowSummary(agent, now),
    status: statusPresentation(agent.status),
    selected: agent.key === selectedKey,
  };
}

/** What a person reads when omp refused a cancel and its re-read still lists the worker as running. */
export const CANCEL_REFUSED_MESSAGE =
  "omp could not stop this worker now, because it is still running. Try Cancel again.";

/** Plain words for a failed cancel: omp's own wording never reaches the page. */
export function cancelFailureMessage(error: AppError): string {
  if (error.code === "not_found") {
    return "omp is no longer running this worker; it finished when its last turn ended.";
  }
  if (error.code === "unavailable") {
    return "Cancelling workers isn't available in this version of omp.";
  }
  return "The worker could not be cancelled. Try again.";
}

/** omp's "not running" answer to a cancel: it says why a worker that the panel showed as running reads Finished. */
export function isNotRunningAnswer(phase: CancelPhase | undefined): boolean {
  return phase?.state === "failed" && phase.error.code === "not_found";
}

function cancelControl(
  agent: RosterAgent,
  cancels: Readonly<Record<string, CancelPhase>>,
  cancelAction: ActionAvailability,
): CancelControl {
  const phase = cancels[agent.key];
  if (agent.terminalAt !== null) {
    // omp's "not running" answer still says why a worker reads Finished: plain words, not an error.
    return phase?.state === "failed" && isNotRunningAnswer(phase)
      ? { state: "ended", message: cancelFailureMessage(phase.error) }
      : { state: "hidden" };
  }
  // omp cancels only a worker it lists as running; a queued one has nothing to stop.
  if (agent.status !== "running") return { state: "hidden" };
  if (cancelAction.state === "unavailable")
    return { state: "unavailable", reason: cancelAction.reason };
  if (phase === undefined) return { state: "ready" };
  if (phase.state === "failed") {
    return {
      state: "failed",
      message: cancelFailureMessage(phase.error),
      retryable: phase.error.retryable,
    };
  }
  if (phase.state === "refused") return { state: "refused", message: CANCEL_REFUSED_MESSAGE };
  return { state: phase.state };
}

function buildInspector(
  agent: RosterAgent,
  numbers: ReadonlyMap<string, number>,
  input: HubModelInput,
): HubInspector {
  const metrics = readWorkerMetrics(agent.metrics.raw);
  const type = agentTypeLabel(agent);
  const facts: HubFact[] = [
    ...(type === null ? [] : [{ label: "Type", value: type }]),
    { label: "Started from", value: parentLabel(agent, numbers) },
    { label: "Last update", value: formatClock(agent.lastUpdate) },
  ];
  if (agent.terminalAt !== null) {
    facts.push({ label: "Finished", value: formatClock(agent.terminalAt) });
  }
  const progress: HubFact[] = [];
  if (metrics.model !== null) progress.push({ label: "Model", value: metrics.model });
  if (metrics.toolCalls !== null) {
    progress.push({ label: "Tool calls", value: COUNT_FORMAT.format(metrics.toolCalls) });
  }
  if (metrics.requests !== null) {
    progress.push({ label: "Requests", value: COUNT_FORMAT.format(metrics.requests) });
  }
  if (metrics.tokens !== null) {
    progress.push({ label: "Tokens", value: COUNT_FORMAT.format(metrics.tokens) });
  }
  if (metrics.cost !== null) progress.push({ label: "Cost", value: formatCost(metrics.cost) });
  const durationMs = durationAt(agent, input.now);
  if (durationMs !== null) {
    progress.push({ label: "Running time", value: formatDuration(durationMs) });
  }
  return {
    key: agent.key,
    title: workerTitle(agent),
    subtitle: subtitleOf(agent),
    status: statusPresentation(agent.status),
    facts,
    progress,
    step: metrics.step,
    task: readText(agent.assignment ?? agent.task),
    cancel: cancelControl(agent, input.cancels, input.cancelAction),
    transcript: input.transcriptAction,
  };
}

function sectionsFor(
  agents: readonly RosterAgent[],
  view: HubView,
  selectedKey: string | null,
  numbers: ReadonlyMap<string, number>,
  now: number,
): readonly HubSection[] {
  const byIndex = [...agents].sort((left, right) => left.index - right.index);
  if (view === "byParent") {
    const groups = new Map<string, RosterAgent[]>();
    for (const agent of byIndex) {
      const parent = agent.parentToolCallId ?? UNKNOWN_PARENT;
      groups.set(parent, [...(groups.get(parent) ?? []), agent]);
    }
    return [...groups].map(([parent, members]) => ({
      key: `parent:${parent || "chat"}`,
      heading: groupHeading(parent, numbers),
      rows: members.map((agent) => toRow(agent, selectedKey, now)),
    }));
  }
  const active = byIndex.filter(isActive);
  const recent = agents
    .filter((agent) => !isActive(agent))
    .sort(
      (left, right) => (right.terminalAt ?? 0) - (left.terminalAt ?? 0) || right.index - left.index,
    );
  const sections: HubSection[] = [];
  if (active.length > 0) {
    sections.push({
      key: "active",
      heading: "Active",
      rows: active.map((agent) => toRow(agent, selectedKey, now)),
    });
  }
  if (recent.length > 0) {
    sections.push({
      key: "recent",
      heading: "Recent",
      rows: recent.map((agent) => toRow(agent, selectedKey, now)),
    });
  }
  return sections;
}

function describeCounts(agents: readonly RosterAgent[]): string | null {
  const running = agents.filter((agent) => agent.status === "running").length;
  const queued = agents.filter((agent) => agent.status === "pending").length;
  const recent = agents.filter((agent) => !isActive(agent)).length;
  const parts = [
    running > 0 ? `${running} running` : null,
    queued > 0 ? `${queued} queued` : null,
    recent > 0 ? `${recent} recent` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function lifecycleFor(load: HubLoad, count: number): Pick<HubModel, "lifecycle" | "error"> {
  switch (load.state) {
    case "loading":
      return { lifecycle: "loading", error: null };
    case "error":
      return { lifecycle: "error", error: load.error };
    case "unavailable":
      return {
        lifecycle: "unavailable",
        error: { code: "unavailable", message: load.reason, retryable: false },
      };
    case "ready":
      return count === 0
        ? { lifecycle: "empty", error: null }
        : { lifecycle: "populated", error: null };
  }
}

/** Pure view model for the Agent Hub: every string and every visible decision is made here. */
export function buildHubModel(input: HubModelInput): HubModel {
  const agents = input.roster.order
    .map((key) => input.roster.agents[key])
    .filter((agent): agent is RosterAgent => agent !== undefined);
  const numbers = taskCallNumbers([...agents].sort((left, right) => left.index - right.index));
  const selected =
    input.selectedKey === null
      ? undefined
      : agents.find((agent) => agent.key === input.selectedKey);
  return {
    title: HUB_TITLE,
    ...lifecycleFor(input.load, agents.length),
    description: describeCounts(agents),
    running: agents.some((agent) => agent.status === "running"),
    view: input.view,
    sections: sectionsFor(agents, input.view, selected?.key ?? null, numbers, input.now),
    inspector: selected ? buildInspector(selected, numbers, input) : null,
  };
}

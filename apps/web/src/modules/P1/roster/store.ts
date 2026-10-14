import type { SubagentId, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type {
  AgentRef,
  P1SubagentEvent,
  SubagentLifecyclePayload,
  SubagentProgressPayload,
} from "@/modules/P1/contract";
import type {
  AgentProgressMetrics,
  AgentRosterListener,
  AgentRosterStoreOptions,
  AgentRosterStoreSnapshot,
  FinishedWorker,
  RosterAgent,
  RosterClock,
} from "./types";

const DEFAULT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_LIMIT = 100;

const SYSTEM_CLOCK: RosterClock = { now: () => Date.now() };
function rosterFailure(code: "invalid_args" | "cancelled", message: string): AppFailure {
  return new AppFailure({ code, message, retryable: false });
}

function terminalStatus(status: RosterAgent["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "aborted" || status === "stopped"
  );
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): RosterAgent["status"] {
  return status === "started" ? "running" : status;
}

function metricsFromProgress(
  progress: Readonly<Record<string, unknown>>,
  receivedAt: number,
): AgentProgressMetrics {
  const number = (key: string): number | undefined => {
    const value = progress[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return Object.freeze({
    durationMs: number("durationMs"),
    receivedAt,
    raw: Object.freeze({ ...progress }),
  });
}

function metricsFromAgent(agent: AgentRef, receivedAt: number): AgentProgressMetrics {
  return metricsFromProgress(agent.progress ?? {}, receivedAt);
}

/** A worker's metrics once it has ended: its time stops where the clock has moved it, not at omp's last report. */
function metricsAtEnd(metrics: AgentProgressMetrics, now: number): AgentProgressMetrics {
  if (metrics.durationMs === undefined) return metrics;
  const durationMs = metrics.durationMs + Math.max(0, now - metrics.receivedAt);
  return metricsFromProgress({ ...metrics.raw, durationMs }, now);
}

function createAgent(
  agent: AgentRef,
  key: string,
  incarnation: number,
  terminalAt: number | null,
  lifecycleSeq: number | null,
  progressSeq: number | null,
  metrics: AgentProgressMetrics,
): RosterAgent {
  return Object.freeze({
    ...agent,
    key,
    incarnation,
    terminalAt,
    lifecycleSeq,
    progressSeq,
    metrics,
  });
}

function emptySnapshot(threadId: ThreadId): AgentRosterStoreSnapshot {
  return Object.freeze({
    threadId,
    revision: 0,
    lastSeq: 0,
    agents: Object.freeze({}),
    order: Object.freeze([]),
    active: Object.freeze([]),
    recent: Object.freeze([]),
  });
}

export class AgentRosterStore {
  private readonly threadId: ThreadId;
  private readonly client: AgentRosterStoreOptions["client"];
  private readonly runtime: AgentRosterStoreOptions["runtime"];
  private readonly finished: AgentRosterStoreOptions["finished"];
  private readonly clock: RosterClock;
  private readonly tombstoneTtlMs: number;
  private readonly tombstoneLimit: number;
  private readonly listeners = new Set<AgentRosterListener>();
  private snapshot: AgentRosterStoreSnapshot;
  private readonly latestById = new Map<SubagentId, string>();
  private readonly incarnationById = new Map<SubagentId, number>();
  private notificationUnsubscribe: (() => void) | undefined;
  private progressLease: { release(): Promise<void> } | undefined;
  private started = false;
  private disposed = false;

  public constructor(options: AgentRosterStoreOptions) {
    this.threadId = options.threadId;
    this.client = options.client;
    this.runtime = options.runtime;
    this.finished = options.finished;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.tombstoneLimit = options.tombstoneLimit ?? DEFAULT_TOMBSTONE_LIMIT;
    if (this.tombstoneTtlMs < 0 || this.tombstoneLimit < 0) {
      throw rosterFailure("invalid_args", "Roster retention values must be non-negative");
    }
    if (this.runtime && this.runtime.threadId !== this.threadId) {
      throw rosterFailure("invalid_args", "Roster runtime thread does not match the roster thread");
    }
    this.snapshot = emptySnapshot(this.threadId);
  }

  public getSnapshot(): AgentRosterStoreSnapshot {
    return this.snapshot;
  }

  /** The roster's clock, so a reader that times what it shows uses the clock the roster records with. */
  public now(): number {
    return this.clock.now();
  }

  public subscribe(listener: AgentRosterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the progress subscription and hydrates the initial roster snapshot. */
  public async start(): Promise<void> {
    if (this.disposed) throw rosterFailure("cancelled", "Roster store is disposed");
    if (this.started) return;
    this.started = true;
    try {
      this.notificationUnsubscribe = this.client.subscribeNotifications((notification) => {
        this.ingestNotification(notification.event, notification.seq);
      });
      this.progressLease = await this.client.acquireSubscription("progress");
      await this.refresh();
      await this.adoptFinishedWorkers();
    } catch (error) {
      this.notificationUnsubscribe?.();
      this.notificationUnsubscribe = undefined;
      if (this.progressLease) await this.progressLease.release();
      this.progressLease = undefined;
      this.started = false;
      throw error;
    }
  }

  public async refresh(): Promise<void> {
    if (this.disposed) throw rosterFailure("cancelled", "Roster store is disposed");
    const agents = await this.client.getRoster();
    this.mergeSnapshot(agents);
  }

  /**
   * Adds finished workers read from the chat's transcripts. Each keeps the moment it ended, so the
   * same 24-hour and 100-entry retention as a live tombstone applies. A worker the roster already
   * holds keeps its live record, except one it only saw as pending: its end may have come while the
   * roster was not subscribed, so the transcript's end corrects it. Either way, the reason a worker
   * failed joins its record, since omp's live roster does not carry it.
   */
  public adoptFinished(workers: readonly FinishedWorker[]): void {
    if (this.disposed) return;
    let changed = false;
    for (const worker of workers) {
      const knownKey = this.latestById.get(worker.agent.id);
      const known = knownKey === undefined ? undefined : this.snapshot.agents[knownKey];
      if (known !== undefined) {
        if (known.status === "pending") {
          // The transcript says how the worker ended; everything else the roster knew of it (its task call, its
          // description, its index, its source and its metrics) stays, or the Agents tab would lose where it belongs.
          const ended = createAgent(
            {
              ...known,
              status: worker.agent.status,
              lastUpdate: worker.agent.lastUpdate,
              sessionFile: known.sessionFile ?? worker.agent.sessionFile,
              ...(worker.agent.reason === undefined ? {} : { reason: worker.agent.reason }),
            },
            known.key,
            known.incarnation,
            worker.endedAt,
            known.lifecycleSeq,
            known.progressSeq,
            known.metrics,
          );
          changed = this.replaceAgent(known.key, ended) || changed;
        } else if (worker.agent.reason !== undefined && known.reason !== worker.agent.reason) {
          // omp's live roster does not carry why a worker failed; its transcript does, so the reason joins it here.
          changed =
            this.replaceAgent(
              known.key,
              Object.freeze({ ...known, reason: worker.agent.reason }),
            ) || changed;
        }
        continue;
      }
      const incarnation = this.incarnationById.get(worker.agent.id) ?? 0;
      const key = this.makeKey(worker.agent.id, incarnation);
      this.latestById.set(worker.agent.id, key);
      this.incarnationById.set(worker.agent.id, incarnation);
      const agent = createAgent(
        worker.agent,
        key,
        incarnation,
        worker.endedAt,
        null,
        null,
        metricsFromAgent(worker.agent, this.clock.now()),
      );
      changed = this.insertAgent(agent) || changed;
    }
    changed = this.prune() || changed;
    if (changed) this.commit(this.snapshot.lastSeq);
  }

  /** Lists the chat's finished workers once the live roster is in, so a reload still shows them. */
  private async adoptFinishedWorkers(): Promise<void> {
    if (this.finished === undefined) return;
    this.adoptFinished(await this.finished.list());
  }

  /** Exposed for reconnect/hydration tests and for P1.3's future client adapter. */
  public mergeSnapshot(agents: readonly AgentRef[]): void {
    if (this.disposed) return;
    let changed = false;
    for (const agent of agents) {
      changed = this.mergeSnapshotAgent(agent) || changed;
    }
    changed = this.prune() || changed;
    if (changed) this.commit(this.snapshot.lastSeq);
  }

  /** Applies one ordered P1 notification from R0.1. Replays do not mutate the snapshot. */
  public ingestNotification(event: P1SubagentEvent, seq: number): void {
    if (this.disposed || seq <= this.snapshot.lastSeq) return;
    let changed = false;
    if (event.type === "subagent_lifecycle") changed = this.mergeLifecycle(event.payload, seq);
    else if (event.type === "subagent_progress") changed = this.mergeProgress(event.payload, seq);
    else if (event.type === "subagent_event") changed = false;
    changed = this.prune() || changed;
    this.snapshot = changed ? this.commit(seq) : this.withLastSeq(seq);
    // omp's live roster drops a worker once it has failed, so its reason comes from the chat's transcripts, which list
    // each finished worker with the reason its last assistant message keeps. A failed read leaves the worker with its
    // status and no reason; the notice still says it failed.
    if (event.type === "subagent_lifecycle" && event.payload.status === "failed")
      void this.adoptFinishedWorkers().catch(() => undefined);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = undefined;
    if (this.progressLease) await this.progressLease.release();
    this.progressLease = undefined;
    this.listeners.clear();
  }

  private mergeSnapshotAgent(agent: AgentRef): boolean {
    const currentKey = this.latestById.get(agent.id);
    const current = currentKey ? this.snapshot.agents[currentKey] : undefined;
    if (current?.terminalAt !== null && current?.terminalAt !== undefined) {
      if (!terminalStatus(agent.status)) return false;
      return this.replaceAgent(
        currentKey,
        createAgent(
          agent,
          current.key,
          current.incarnation,
          current.terminalAt,
          current.lifecycleSeq,
          current.progressSeq,
          metricsFromAgent(agent, this.clock.now()),
        ),
      );
    }

    const terminalAt = terminalStatus(agent.status) ? this.clock.now() : null;
    if (current) {
      if (agent.lastUpdate < current.lastUpdate) return false;
      return this.replaceAgent(
        current.key,
        createAgent(
          agent,
          current.key,
          current.incarnation,
          terminalAt,
          current.lifecycleSeq,
          current.progressSeq,
          terminalAt === null
            ? metricsFromAgent(agent, this.clock.now())
            : metricsAtEnd(current.metrics, this.clock.now()),
        ),
      );
    }
    const incarnation = this.incarnationById.get(agent.id) ?? 0;
    const key = this.makeKey(agent.id, incarnation);
    this.latestById.set(agent.id, key);
    this.incarnationById.set(agent.id, incarnation);
    const metrics = metricsFromAgent(agent, this.clock.now());
    return this.insertAgent(createAgent(agent, key, incarnation, terminalAt, null, null, metrics));
  }

  private mergeLifecycle(payload: SubagentLifecyclePayload, seq: number): boolean {
    const status = statusFromLifecycle(payload.status);
    const currentKey = this.latestById.get(payload.id);
    const current = currentKey ? this.snapshot.agents[currentKey] : undefined;
    if (current?.terminalAt !== null && current?.terminalAt !== undefined && status === "running") {
      const incarnation = (this.incarnationById.get(payload.id) ?? current.incarnation) + 1;
      const key = this.makeKey(payload.id, incarnation);
      const fresh = createAgent(
        {
          id: payload.id,
          index: payload.index,
          agent: payload.agent,
          agentSource: payload.agentSource,
          status,
          lastUpdate: this.clock.now(),
          description: payload.description,
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          detached: payload.detached,
          threadId: this.threadId,
        },
        key,
        incarnation,
        null,
        seq,
        null,
        metricsFromProgress({}, this.clock.now()),
      );
      this.latestById.set(payload.id, key);
      this.incarnationById.set(payload.id, incarnation);
      return this.insertAgent(fresh);
    }
    if (current && current.lifecycleSeq !== null && seq <= current.lifecycleSeq) return false;
    const next = createAgent(
      {
        ...current,
        id: payload.id,
        index: payload.index,
        agent: payload.agent,
        agentSource: payload.agentSource,
        status,
        lastUpdate: this.clock.now(),
        description: payload.description ?? current?.description,
        sessionFile: payload.sessionFile ?? current?.sessionFile,
        parentToolCallId: payload.parentToolCallId ?? current?.parentToolCallId,
        detached: payload.detached ?? current?.detached,
        threadId: this.threadId,
      },
      current?.key ?? this.makeKey(payload.id, this.incarnationById.get(payload.id) ?? 0),
      current?.incarnation ?? this.incarnationById.get(payload.id) ?? 0,
      terminalStatus(status) ? (current?.terminalAt ?? this.clock.now()) : null,
      seq,
      current?.progressSeq ?? null,
      current?.metrics ?? metricsFromProgress({}, this.clock.now()),
    );
    if (!current) {
      this.latestById.set(payload.id, next.key);
      this.incarnationById.set(payload.id, next.incarnation);
      return this.insertAgent(next);
    }
    return this.replaceAgent(current.key, next);
  }

  private mergeProgress(payload: SubagentProgressPayload, seq: number): boolean {
    const candidates = this.snapshot.order
      .map((key) => this.snapshot.agents[key])
      .filter((agent): agent is RosterAgent => agent !== undefined && agent.status === "running")
      .filter((agent) => agent.index === payload.index);
    const current =
      candidates.find(
        (agent) => payload.sessionFile !== undefined && agent.sessionFile === payload.sessionFile,
      ) ?? candidates.find((agent) => agent.agent === payload.agent);
    if (!current || (current.progressSeq !== null && seq <= current.progressSeq)) return false;
    const next = createAgent(
      {
        ...current,
        task: payload.task,
        assignment: payload.assignment ?? current.assignment,
        sessionFile: payload.sessionFile ?? current.sessionFile,
        parentToolCallId: payload.parentToolCallId ?? current.parentToolCallId,
        detached: payload.detached ?? current.detached,
        lastUpdate: this.clock.now(),
      },
      current.key,
      current.incarnation,
      current.terminalAt,
      current.lifecycleSeq,
      seq,
      metricsFromProgress(payload.progress, this.clock.now()),
    );
    return this.replaceAgent(current.key, next);
  }

  private insertAgent(agent: RosterAgent): boolean {
    const agents = { ...this.snapshot.agents, [agent.key]: agent };
    const order = [...this.snapshot.order, agent.key];
    this.snapshot = this.withAgents(agents, order);
    return true;
  }

  private replaceAgent(key: string | undefined, agent: RosterAgent): boolean {
    if (!key || !this.snapshot.agents[key]) return false;
    this.snapshot = this.withAgents({ ...this.snapshot.agents, [key]: agent }, this.snapshot.order);
    return true;
  }

  private prune(): boolean {
    const now = this.clock.now();
    const tombstones = this.snapshot.order
      .map((key) => this.snapshot.agents[key])
      .filter((agent): agent is RosterAgent => agent !== undefined && agent.terminalAt !== null)
      .sort((left, right) => (right.terminalAt ?? 0) - (left.terminalAt ?? 0));
    const retained = new Set(
      tombstones
        .filter((agent) => now - (agent.terminalAt ?? now) < this.tombstoneTtlMs)
        .slice(0, this.tombstoneLimit)
        .map((agent) => agent.key),
    );
    const remove = new Set(
      tombstones.filter((agent) => !retained.has(agent.key)).map((agent) => agent.key),
    );
    if (remove.size === 0) return false;
    const agents = { ...this.snapshot.agents };
    for (const key of remove) {
      delete agents[key];
      const agent = this.snapshot.agents[key];
      if (agent && this.latestById.get(agent.id) === key) this.latestById.delete(agent.id);
    }
    this.snapshot = this.withAgents(
      agents,
      this.snapshot.order.filter((key) => !remove.has(key)),
    );
    return true;
  }

  private withAgents(
    agents: Readonly<Record<string, RosterAgent>>,
    order: readonly string[],
  ): AgentRosterStoreSnapshot {
    const active: string[] = [];
    const recent: string[] = [];
    for (const key of order) {
      const agent = agents[key];
      if (!agent) continue;
      if (agent.terminalAt === null) active.push(key);
      else recent.push(key);
    }
    recent.sort(
      (left, right) => (agents[right]?.terminalAt ?? 0) - (agents[left]?.terminalAt ?? 0),
    );
    return Object.freeze({
      threadId: this.threadId,
      revision: this.snapshot.revision + 1,
      lastSeq: this.snapshot.lastSeq,
      agents: Object.freeze(agents),
      order: Object.freeze([...order]),
      active: Object.freeze(active),
      recent: Object.freeze(recent),
    });
  }

  private commit(lastSeq: number): AgentRosterStoreSnapshot {
    this.snapshot = Object.freeze({ ...this.snapshot, lastSeq });
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }

  private withLastSeq(lastSeq: number): AgentRosterStoreSnapshot {
    this.snapshot = Object.freeze({ ...this.snapshot, lastSeq });
    return this.snapshot;
  }

  private makeKey(id: SubagentId, incarnation: number): string {
    return `${id}:${incarnation}`;
  }
}

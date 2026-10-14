import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  type FolderPath,
  type GithubReference,
  GithubRefsPort,
  type GitState,
  GitStatePort,
  type HostMetadata,
  HostMetadataPort,
  type ThreadId,
} from "@omp-app/contracts";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import type { RuntimeSnapshot } from "@/modules/R0/store";
import { ActiveTimeMeter } from "./active-time";
import { buildStatusChips, type Reading, type StatusChip } from "./model";

/** The part of the runtime store the bar reads: omp's session state and whether it is working. */
export interface StatusRuntime {
  getSnapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
}

/** The part of a chat's subagent roster the bar reads. */
export interface StatusRoster {
  getSnapshot(): AgentRosterStoreSnapshot;
  subscribe(listener: (snapshot: AgentRosterStoreSnapshot) => void): () => void;
}

export interface StatusBarSnapshot {
  readonly chips: readonly StatusChip[];
}

interface StatusBarOptions {
  readonly client: Pick<AppClient, "port">;
  readonly runtime: StatusRuntime;
  readonly threadId: ThreadId;
  /** Receives every unexpected failure of a read, for the debug log. The bar shows nothing for it. */
  readonly reportFailure: (error: unknown) => void;
  /** Epoch milliseconds; the app uses the browser clock. */
  readonly clock?: { now(): number };
}

/** While omp works the bar ticks once a second, so the active time counts up. */
const WORKING_TICK_MS = 1_000;
const MINUTE_MS = 60_000;
/** The idle clock is redrawn at the start of each minute; the margin keeps the tick after the boundary. */
const MINUTE_MARGIN_MS = 50;

const NOT_READ = "Not read yet.";
const NO_FOLDER = "No folder is open.";
const CAPABILITY_MISSING = "This server cannot read it.";
const READ_FAILED = "It could not be read.";
const SUBAGENT_EVENTS_MISSING = "This omp does not report subagent events.";
const ROSTER_NOT_LOADED = "The subagents of this chat have not loaded.";

/**
 * Omp's active time is a total for the chat. The app opens a new runtime store each time a chat is opened, so the
 * meter is kept per client and thread: leaving a chat and coming back keeps its total.
 */
const METERS = new WeakMap<Pick<AppClient, "port">, Map<ThreadId, ActiveTimeMeter>>();

function meterFor(client: Pick<AppClient, "port">, threadId: ThreadId): ActiveTimeMeter {
  let byThread = METERS.get(client);
  if (byThread === undefined) {
    byThread = new Map();
    METERS.set(client, byThread);
  }
  let meter = byThread.get(threadId);
  if (meter === undefined) {
    meter = new ActiveTimeMeter();
    byThread.set(threadId, meter);
  }
  return meter;
}

function unread<T>(reason: string): Reading<T> {
  return { state: "unavailable", reason };
}

/**
 * The status bar's data: the workspace, host and pull request read from the server's ports, the session
 * read from R0, the subagents read from P1, and the local clock and active time. Ports are read when the
 * folder or the capabilities change, and when a turn ends (the work may have changed git). Nothing polls.
 * A result that arrives after its read was replaced or stopped is dropped.
 */
export class StatusBarController {
  readonly #client: Pick<AppClient, "port">;
  readonly #runtime: StatusRuntime;
  readonly #threadId: ThreadId;
  readonly #reportFailure: (error: unknown) => void;
  readonly #clock: { now(): number };
  readonly #meter: ActiveTimeMeter;
  readonly #listeners = new Set<() => void>();
  #folder: FolderPath | null = null;
  #capabilities: CapabilityMap = {};
  #roster: StatusRoster | null = null;
  #rosterUnsubscribe: (() => void) | null = null;
  #host: Reading<HostMetadata> = unread(NOT_READ);
  #git: Reading<GitState> = unread(NOT_READ);
  #pullRequest: Reading<GithubReference | null> = unread(NOT_READ);
  #hostScope: AbortController | null = null;
  #workScope: AbortController | null = null;
  #working = false;
  #running = false;
  #runtimeUnsubscribe: (() => void) | null = null;
  #timer: number | null = null;
  #serialized = "";
  #snapshot: StatusBarSnapshot = { chips: [] };

  constructor(options: StatusBarOptions) {
    this.#client = options.client;
    this.#runtime = options.runtime;
    this.#threadId = options.threadId;
    this.#meter = meterFor(options.client, options.threadId);
    this.#reportFailure = options.reportFailure;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#recompute();
  }

  /** Stable identity, for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Stable until something the bar shows changes. */
  readonly getSnapshot = (): StatusBarSnapshot => this.#snapshot;

  /** Begins watching the runtime and reading the ports. Calling it while running does nothing. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#working = this.#runtime.getSnapshot().prompt.streaming;
    this.#meter.observe(this.#working, this.#clock.now());
    this.#runtimeUnsubscribe = this.#runtime.subscribe((snapshot) => {
      this.#onRuntime(snapshot);
    });
    if (this.#roster !== null) this.#watchRoster(this.#roster);
    this.#readHost();
    this.#readWork();
    this.#recompute();
    this.#scheduleTick();
  }

  /** Stops watching and cancels reads that are in flight. Calling it while stopped does nothing. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    // Time between stop and start is not work, so the open window closes here.
    this.#meter.observe(false, this.#clock.now());
    this.#runtimeUnsubscribe?.();
    this.#runtimeUnsubscribe = null;
    this.#rosterUnsubscribe?.();
    this.#rosterUnsubscribe = null;
    this.#hostScope?.abort();
    this.#workScope?.abort();
    this.#clearTimer();
  }

  setFolder(folder: FolderPath | null): void {
    if (folder === this.#folder) return;
    this.#folder = folder;
    if (this.#running) {
      this.#readHost();
      this.#readWork();
    } else {
      const reason = folder === null ? NO_FOLDER : NOT_READ;
      this.#host = unread(reason);
      this.#git = unread(reason);
      this.#pullRequest = unread(reason);
    }
    this.#recompute();
  }

  setCapabilities(capabilities: CapabilityMap): void {
    const hostBefore = stateOf(this.#capabilities, "host.metadata");
    const workBefore = workStates(this.#capabilities);
    this.#capabilities = capabilities;
    if (this.#running) {
      if (stateOf(capabilities, "host.metadata") !== hostBefore) this.#readHost();
      if (workStates(capabilities) !== workBefore) this.#readWork();
    }
    this.#recompute();
  }

  setRoster(roster: StatusRoster | null): void {
    if (roster === this.#roster) return;
    this.#rosterUnsubscribe?.();
    this.#rosterUnsubscribe = null;
    this.#roster = roster;
    if (this.#running && roster !== null) this.#watchRoster(roster);
    this.#recompute();
  }

  #watchRoster(roster: StatusRoster): void {
    this.#rosterUnsubscribe = roster.subscribe(() => {
      this.#recompute();
    });
  }

  #available(key: CapabilityKey): boolean {
    return stateOf(this.#capabilities, key) === "available";
  }

  #onRuntime(snapshot: RuntimeSnapshot): void {
    const working = snapshot.prompt.streaming;
    const wasWorking = this.#working;
    this.#working = working;
    this.#meter.observe(working, this.#clock.now());
    if (working !== wasWorking) this.#scheduleTick();
    // A turn that ended may have changed the files, so git and the pull request are read again.
    if (wasWorking && !working) this.#readWork();
    this.#recompute();
  }

  #readHost(): void {
    this.#hostScope?.abort();
    const scope = new AbortController();
    this.#hostScope = scope;
    const folder = this.#folder;
    if (folder === null) {
      this.#host = unread(NO_FOLDER);
      return;
    }
    if (!this.#available("host.metadata")) {
      this.#host = unread(CAPABILITY_MISSING);
      return;
    }
    void this.#load(scope, (signal) =>
      this.#client.port(HostMetadataPort).read({ folder }, { signal }),
    ).then((reading) => {
      if (reading === null) return;
      this.#host = reading;
      this.#recompute();
    });
  }

  #readWork(): void {
    this.#workScope?.abort();
    const scope = new AbortController();
    this.#workScope = scope;
    const folder = this.#folder;
    if (folder === null) {
      this.#git = unread(NO_FOLDER);
      this.#pullRequest = unread(NO_FOLDER);
      return;
    }
    if (this.#available("host.git-state")) {
      void this.#load(scope, (signal) =>
        this.#client.port(GitStatePort).read({ folder }, { signal }),
      ).then((reading) => {
        if (reading === null) return;
        this.#git = reading;
        this.#recompute();
      });
    } else {
      this.#git = unread(CAPABILITY_MISSING);
    }
    // The pull request needs the GitHub CLI on the server; without it the capability is a fallback, not available.
    if (this.#available("host.github-refs")) {
      void this.#load(scope, (signal) =>
        this.#client
          .port(GithubRefsPort)
          .currentPullRequest({ folder }, { signal })
          .then((result) => result.pullRequest),
      ).then((reading) => {
        if (reading === null) return;
        this.#pullRequest = reading;
        this.#recompute();
      });
    } else {
      this.#pullRequest = unread(CAPABILITY_MISSING);
    }
  }

  /**
   * One port read as a reading. Null means the read was replaced or stopped, so its answer is not wanted.
   * `unavailable` is the server saying the thing is not there; anything else is reported for the debug log.
   */
  async #load<T>(
    scope: AbortController,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<Reading<T> | null> {
    try {
      const value = await call(scope.signal);
      return scope.signal.aborted ? null : { state: "ready", value };
    } catch (error) {
      if (scope.signal.aborted) return null;
      if (!(error instanceof AppFailure) || error.appError.code !== "unavailable") {
        this.#reportFailure(error);
      }
      return unread(READ_FAILED);
    }
  }

  #subagents(): Reading<number> {
    if (!this.#available("omp.subagent-events")) return unread(SUBAGENT_EVENTS_MISSING);
    if (this.#roster === null) return unread(ROSTER_NOT_LOADED);
    return { state: "ready", value: this.#roster.getSnapshot().active.length };
  }

  #recompute(): void {
    const now = this.#clock.now();
    const chips = buildStatusChips({
      now,
      threadId: this.#threadId,
      host: this.#host,
      git: this.#git,
      pullRequest: this.#pullRequest,
      session: this.#runtime.getSnapshot().session,
      subagents: this.#subagents(),
      activeMs: this.#meter.activeMs(now),
    });
    const serialized = JSON.stringify(chips);
    if (serialized === this.#serialized) return;
    this.#serialized = serialized;
    this.#snapshot = { chips };
    for (const listener of [...this.#listeners]) listener();
  }

  #scheduleTick(): void {
    this.#clearTimer();
    if (!this.#running) return;
    const delay = this.#working
      ? WORKING_TICK_MS
      : MINUTE_MS - (this.#clock.now() % MINUTE_MS) + MINUTE_MARGIN_MS;
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#recompute();
      this.#scheduleTick();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    window.clearTimeout(this.#timer);
    this.#timer = null;
  }
}

function stateOf(capabilities: CapabilityMap, key: CapabilityKey): string {
  return capabilities[key]?.state ?? "missing";
}

/** The states of the capabilities the two workspace reads need, as one comparable key. */
function workStates(capabilities: CapabilityMap): string {
  return `${stateOf(capabilities, "host.git-state")}|${stateOf(capabilities, "host.github-refs")}`;
}

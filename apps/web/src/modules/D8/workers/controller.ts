import { AppFailure, type CapabilityMap, SubagentId } from "@omp-app/contracts";
import type { SubagentClient } from "@/modules/P1/client";
import { cancelFailureMessage } from "@/modules/P1/panels/model";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import { buildWorkersModel, type WorkersPanelModel } from "./model";

/** The part of P1's roster the workers panel reads: AgentRosterStore satisfies it. */
export interface WorkersRoster {
  getSnapshot(): AgentRosterStoreSnapshot;
  subscribe(listener: (snapshot: AgentRosterStoreSnapshot) => void): () => void;
  /** Reads the roster again: omp's answer to a stop is checked against it before the panel changes. */
  refresh(): Promise<void>;
  now(): number;
}

export interface WorkersControllerOptions {
  readonly roster: WorkersRoster;
  /** Starts the chat's roster the way the app does (`ThreadAgents.start`): a start already under way is shared. */
  readonly start: () => Promise<void>;
  /** Only the cancel call of P1's client. omp's refusal comes back as a failure, and the panel reads the roster again. */
  readonly client: Pick<SubagentClient, "cancel">;
  /** Read on every model build, so a capability that appears later is seen without a new controller. */
  readonly capabilities: () => CapabilityMap;
  /** Keeps the raw cause of a failed read or stop. The panel shows plain words; the cause goes to the debug log. */
  readonly debugLog: (cause: unknown) => void;
}

export interface WorkersPanelSnapshot {
  readonly model: WorkersPanelModel;
  /** True until the roster has been read once. */
  readonly loading: boolean;
  /** The plain sentence for the last failed read or stop, or null. */
  readonly error: string | null;
}

export interface WorkersController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorkersPanelSnapshot;
  /** Reads the roster and keeps it live. Calling it again waits for the same start. */
  start(): void;
  /** Reads the roster again after a failed read; a stop that failed is cleared by a new stop. */
  retry(): void;
  /** Re-reads the model so a running worker's time moves on between omp's reports. */
  tick(): void;
  /** Asks omp to stop one running worker. A stop already in flight for that worker does nothing. */
  stop(id: string): Promise<void>;
  dismissError(): void;
  dispose(): void;
}

const READ_FAILED_MESSAGE = "The workers could not be read. Try again.";
const STOP_FAILED_MESSAGE = "The worker could not be stopped. Try again.";
const REFUSED_MESSAGE =
  "omp could not stop this worker now, because it is still running. Try Stop again.";

/**
 * The workers panel's controller. It lives outside React: the snapshot is cached until the roster, the clock
 * (tick), an error or the disposal changes, so a re-render never rebuilds the model.
 */
export function createWorkersController(options: WorkersControllerOptions): WorkersController {
  const { roster, client, capabilities, debugLog } = options;
  const listeners = new Set<() => void>();
  // The workers whose stop is in flight: their row reads "Stopping..." and offers no second stop.
  const stopping = new Set<string>();
  let started: Promise<void> | undefined;
  let loaded = false;
  let error: string | null = null;
  let disposed = false;
  let cached: WorkersPanelSnapshot | undefined;
  let unsubscribe: (() => void) | undefined;

  const notify = () => {
    cached = undefined;
    for (const listener of listeners) listener();
  };

  const build = (): WorkersPanelSnapshot => ({
    model: buildWorkersModel({
      snapshot: roster.getSnapshot(),
      now: roster.now(),
      capabilities: capabilities(),
      stopping,
    }),
    loading: !loaded,
    error,
  });

  const load = () => {
    started = options
      .start()
      .then(() => {
        loaded = true;
        error = null;
        notify();
      })
      .catch((failure: unknown) => {
        loaded = true;
        debugLog(failure);
        error = READ_FAILED_MESSAGE;
        notify();
      });
  };

  const isRunning = (id: string): boolean =>
    Object.values(roster.getSnapshot().agents).some(
      (agent) => agent.id === id && agent.status === "running" && agent.terminalAt === null,
    );

  /** Reads the roster again. A read that fails goes to the debug log; the roster on screen stays as it is. */
  const reread = async (): Promise<void> => {
    try {
      await roster.refresh();
    } catch (failure: unknown) {
      debugLog(failure);
    }
  };

  /** omp refused a stop or no longer lists the worker: the roster is read first, then the panel says what is left. */
  const settleRefusal = async (id: string): Promise<void> => {
    await reread();
    error = isRunning(id) ? REFUSED_MESSAGE : null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      cached ??= build();
      return cached;
    },
    start() {
      if (disposed || started !== undefined) return;
      unsubscribe = roster.subscribe(() => notify());
      load();
    },
    retry() {
      if (disposed) return;
      if (started === undefined) {
        this.start();
        return;
      }
      error = null;
      load();
      notify();
    },
    tick() {
      if (!disposed) notify();
    },
    async stop(id) {
      if (disposed || stopping.has(id)) return;
      stopping.add(id);
      error = null;
      notify();
      try {
        await client.cancel(SubagentId.parse(id));
        // omp accepted the stop: the roster is read again, so the row shows the worker's end before "Stopping..." goes.
        await reread();
      } catch (failure: unknown) {
        const appError = failure instanceof AppFailure ? failure.appError : undefined;
        if (appError?.code === "conflict" || appError?.code === "not_found") {
          await settleRefusal(id);
        } else {
          debugLog(failure);
          error = appError === undefined ? STOP_FAILED_MESSAGE : cancelFailureMessage(appError);
        }
      } finally {
        stopping.delete(id);
        notify();
      }
    },
    dismissError() {
      error = null;
      notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      stopping.clear();
      listeners.clear();
    },
  };
}

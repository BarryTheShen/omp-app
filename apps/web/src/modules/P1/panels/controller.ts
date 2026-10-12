import { type AppError, AppFailure } from "@omp-app/contracts";
import type { AgentRef } from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import {
  type ActionAvailability,
  buildHubModel,
  type CancelPhase,
  type HubLoad,
  type HubModel,
  type HubView,
  isNotRunningAnswer,
} from "./model";

/**
 * The roster the panel reads, the clock its times are read by, and the re-read the panel makes when omp refuses a
 * cancel, so a row changes only on what omp reports after the refusal.
 */
export interface RosterSource {
  readonly getSnapshot: () => AgentRosterStoreSnapshot;
  readonly subscribe: (listener: (snapshot: AgentRosterStoreSnapshot) => void) => () => void;
  readonly now: () => number;
  readonly refresh: () => Promise<void>;
}

export type CancelAction =
  | { readonly state: "available"; readonly run: (agent: AgentRef) => Promise<unknown> }
  | { readonly state: "unavailable"; readonly reason: string };

export type TranscriptAction =
  | { readonly state: "available"; readonly open: (agent: AgentRef) => void }
  | { readonly state: "unavailable"; readonly reason: string };

/**
 * What the panel may do to a worker, supplied by the composition. The panel never imports the
 * subagent client or the transcript view, so either can change without touching this module.
 */
export interface AgentHubActions {
  readonly cancel: CancelAction;
  readonly openTranscript: TranscriptAction;
}

export interface AgentHubState {
  readonly model: HubModel;
  readonly load: HubLoad;
  readonly view: HubView;
  readonly selectedKey: string | null;
  readonly cancels: Readonly<Record<string, CancelPhase>>;
}

export interface AgentHubController {
  readonly getState: () => AgentHubState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setLoad: (load: HubLoad) => void;
  readonly select: (key: string | null) => void;
  readonly setView: (view: HubView) => void;
  /** Resolves when the cancel call settles; a failure is kept in the state, never thrown. */
  readonly cancel: (key: string) => Promise<void>;
  readonly openTranscript: (key: string) => void;
  /** Re-reads the clock, so a running worker's time moves on; the panel calls it once a second while one runs. */
  readonly tick: () => void;
}

export interface AgentHubControllerOptions {
  readonly roster: RosterSource;
  /** Read on each use, so a view can pass a new actions object without rebuilding the controller. */
  readonly actions: () => AgentHubActions;
  readonly initialLoad?: HubLoad;
}

const FALLBACK_CANCEL_FAILURE: AppError = {
  code: "internal",
  message: "The worker could not be cancelled. Try again.",
  retryable: true,
};

const NOT_RUNNING_FAILURE: AppError = {
  code: "not_found",
  message: "Subagent is no longer running",
  retryable: false,
};

function cancelFailure(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return FALLBACK_CANCEL_FAILURE;
}

/** Keeps cancel phases only for workers that are still running, or whose end a cancel answer explains. */
function keepLiveCancels(
  cancels: Readonly<Record<string, CancelPhase>>,
  roster: AgentRosterStoreSnapshot,
): Readonly<Record<string, CancelPhase>> {
  return Object.fromEntries(
    Object.entries(cancels).filter(([key, phase]) => {
      const agent = roster.agents[key];
      return agent !== undefined && (agent.terminalAt === null || isNotRunningAnswer(phase));
    }),
  );
}

/**
 * The Agent Hub's state and actions, outside React so the view re-renders from it. Every read goes
 * to the roster's current snapshot, so a call made without a subscription still sees the latest
 * roster; a passive roster update never resets what the reader selected or started.
 */
export function createAgentHubController(options: AgentHubControllerOptions): AgentHubController {
  const listeners = new Set<() => void>();
  let load: HubLoad = options.initialLoad ?? { state: "loading" };
  let view: HubView = "list";
  let selectedKey: string | null = null;
  let cancels: Readonly<Record<string, CancelPhase>> = {};
  let unsubscribeRoster: (() => void) | undefined;
  let cached:
    | { readonly roster: AgentRosterStoreSnapshot; readonly state: AgentHubState }
    | undefined;

  function notify(): void {
    cached = undefined;
    for (const listener of [...listeners]) listener();
  }

  function getState(): AgentHubState {
    const roster = options.roster.getSnapshot();
    if (cached?.roster === roster) return cached.state;
    const liveCancels = keepLiveCancels(cancels, roster);
    const shownSelection =
      selectedKey !== null && roster.agents[selectedKey] !== undefined ? selectedKey : null;
    const actions = options.actions();
    const cancelAction: ActionAvailability =
      actions.cancel.state === "available"
        ? { state: "available" }
        : { state: "unavailable", reason: actions.cancel.reason };
    const transcriptAction: ActionAvailability =
      actions.openTranscript.state === "available"
        ? { state: "available" }
        : { state: "unavailable", reason: actions.openTranscript.reason };
    const state: AgentHubState = {
      model: buildHubModel({
        roster,
        load,
        view,
        selectedKey: shownSelection,
        cancels: liveCancels,
        cancelAction,
        transcriptAction,
        now: options.roster.now(),
      }),
      load,
      view,
      selectedKey: shownSelection,
      cancels: liveCancels,
    };
    cached = { roster, state };
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    unsubscribeRoster ??= options.roster.subscribe((snapshot) => {
      cancels = keepLiveCancels(cancels, snapshot);
      notify();
    });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        unsubscribeRoster?.();
        unsubscribeRoster = undefined;
      }
    };
  }

  function setCancel(key: string, phase: CancelPhase): void {
    const agent = options.roster.getSnapshot().agents[key];
    const next = { ...cancels };
    // A worker that finished during its cancel call has nothing to show, unless omp's answer explains the end.
    if (agent === undefined || (agent.terminalAt !== null && !isNotRunningAnswer(phase))) {
      delete next[key];
    } else next[key] = phase;
    cancels = next;
    notify();
  }

  /**
   * omp refused a cancel. The roster is read again before the row changes: a worker that omp has ended reads Finished
   * with omp's answer, and one that is still listed as running stays Running, with the words that say omp could not
   * stop it now.
   */
  async function settleRefusedCancel(key: string): Promise<void> {
    try {
      await options.roster.refresh();
    } catch {
      setCancel(key, { state: "refused" });
      return;
    }
    const agent = options.roster.getSnapshot().agents[key];
    if (agent === undefined || agent.terminalAt !== null) {
      setCancel(key, { state: "failed", error: NOT_RUNNING_FAILURE });
      return;
    }
    setCancel(key, { state: "refused" });
  }

  function setLoad(next: HubLoad): void {
    load = next;
    notify();
  }

  function tick(): void {
    notify();
  }

  function select(key: string | null): void {
    selectedKey = key;
    notify();
  }

  function setView(next: HubView): void {
    view = next;
    notify();
  }

  async function cancel(key: string): Promise<void> {
    const agent = options.roster.getSnapshot().agents[key];
    const action = options.actions().cancel;
    // omp cancels only running workers; the panel offers no other case, and the guard says so too.
    if (agent === undefined || agent.terminalAt !== null || agent.status !== "running") return;
    if (action.state !== "available") return;
    const phase = cancels[key];
    if (phase?.state === "sending" || phase?.state === "sent") return;
    setCancel(key, { state: "sending" });
    try {
      await action.run(agent);
      setCancel(key, { state: "sent" });
    } catch (error) {
      const failure = cancelFailure(error);
      // omp refused the cancel, or says it no longer runs the worker: the roster is read again before the row changes.
      if (failure.code === "conflict" || failure.code === "not_found") {
        await settleRefusedCancel(key);
        return;
      }
      setCancel(key, { state: "failed", error: failure });
    }
  }

  function openTranscript(key: string): void {
    const agent = options.roster.getSnapshot().agents[key];
    const action = options.actions().openTranscript;
    if (agent !== undefined && action.state === "available") action.open(agent);
  }

  return { getState, subscribe, setLoad, select, setView, cancel, openTranscript, tick };
}

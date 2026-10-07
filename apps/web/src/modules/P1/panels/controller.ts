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
} from "./model";

/** The read side of AgentRosterStore: its current snapshot and the notifications that change it. */
export interface RosterSource {
  readonly getSnapshot: () => AgentRosterStoreSnapshot;
  readonly subscribe: (listener: (snapshot: AgentRosterStoreSnapshot) => void) => () => void;
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

function cancelFailure(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return FALLBACK_CANCEL_FAILURE;
}

/** Keeps cancel phases only for workers that are still running. */
function keepLiveCancels(
  cancels: Readonly<Record<string, CancelPhase>>,
  roster: AgentRosterStoreSnapshot,
): Readonly<Record<string, CancelPhase>> {
  return Object.fromEntries(
    Object.entries(cancels).filter(([key]) => roster.agents[key]?.terminalAt === null),
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
    // A worker that finished while its cancel call was in flight has nothing left to show.
    if (agent === undefined || agent.terminalAt !== null) delete next[key];
    else next[key] = phase;
    cancels = next;
    notify();
  }

  function setLoad(next: HubLoad): void {
    load = next;
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
      setCancel(key, { state: "failed", error: cancelFailure(error) });
    }
  }

  function openTranscript(key: string): void {
    const agent = options.roster.getSnapshot().agents[key];
    const action = options.actions().openTranscript;
    if (agent !== undefined && action.state === "available") action.open(agent);
  }

  return { getState, subscribe, setLoad, select, setView, cancel, openTranscript };
}

import type { BackgroundJobStop, ThreadId } from "@omp-app/contracts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import {
  type BackgroundJobView,
  backgroundJobLaunchTimes,
  backgroundJobViews,
} from "@/modules/R0/store/background-jobs";
import { type BackgroundJobKeptStops, BackgroundJobKeptStopsContext } from "@/modules/T5/job-stops";
import { ToolRunActiveContext } from "@/modules/U1/tool-slots";
import {
  type BackgroundJobCommand,
  BackgroundJobCommandContext,
  BackgroundJobsContext,
  type BackgroundJobsScope,
  type StopOutcome,
} from "@/modules/U3/tool-card/background-job";
import { keptStopOutcome, resolveStopOutcome } from "@/modules/U3/tool-card/stopped-jobs";

/** The stops the server kept for one chat's background jobs, by job id, as read when the chat opened. */
interface KeptStops {
  readonly store: OmpRuntimeStore;
  readonly stops: ReadonlyMap<string, BackgroundJobStop>;
}

/** The chat's background jobs as its transcript and omp's process show them now. */
interface BackgroundJobs {
  /** Each job's view, keyed by its bash call. */
  readonly views: ReadonlyMap<string, BackgroundJobView>;
  /** When each job's launch was written (ms), keyed by its bash call. */
  readonly launchedAt: ReadonlyMap<string, number>;
}

/**
 * The chat's run state for its tool calls. While the chat's run is active, a call with no result is queued,
 * not finished: omp starts an exclusive call only when its turn comes. Once the run has ended, a call with no
 * result is unrecorded. The run state is R0's own prompt flag, read live, not a timer. The chat's command gateway
 * is passed down too, so a background job's card can stop its own job. Each background job's view comes from the
 * chat's transcript and omp's process. A stop omp confirmed is kept by the server for the chat and read when the
 * chat opens, and it applies only to a card launched before the stop; a stop made on this page shows at once.
 */
export function ToolRunScope({
  store,
  runBackgroundJobCommand,
  loadBackgroundJobStops,
  children,
}: {
  readonly store: OmpRuntimeStore;
  readonly runBackgroundJobCommand?: BackgroundJobCommand | undefined;
  /** Reads the stops the server kept for a chat. Without it a card shows only the stops made on this page. */
  readonly loadBackgroundJobStops?:
    | ((threadId: ThreadId) => Promise<readonly BackgroundJobStop[]>)
    | undefined;
  readonly children: ReactNode;
}) {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const streaming = useSyncExternalStore(subscribe, () => store.getSnapshot().prompt.streaming);
  const source = useMemo(() => backgroundJobsSource(store), [store]);
  const jobs = useSyncExternalStore(source.subscribe, source.read);
  const [stops, setStops] = useState(() => ({ store, outcomes: new Map<string, StopOutcome>() }));
  const kept = useKeptStops(store, loadBackgroundJobStops);
  const keptForTasks = useMemo<BackgroundJobKeptStops | undefined>(() => {
    if (kept === undefined) return undefined;
    const launchedAt = new Map<string, number>();
    for (const [toolCallId, view] of jobs.views) {
      const at = jobs.launchedAt.get(toolCallId);
      if (at === undefined) continue;
      const latest = launchedAt.get(view.jobId);
      if (latest === undefined || at > latest) launchedAt.set(view.jobId, at);
    }
    return { stops: kept.stops, launchedAt };
  }, [jobs, kept]);
  const scope = useMemo<BackgroundJobsScope>(
    () => ({
      viewOf: (toolCallId): BackgroundJobView | undefined => jobs.views.get(toolCallId),
      outcomeOf: (toolCallId) => {
        const view = jobs.views.get(toolCallId);
        return resolveStopOutcome(
          stops.store === store ? stops.outcomes.get(toolCallId) : undefined,
          view?.kind === "running",
          () => keptOutcome(kept, view?.jobId, jobs.launchedAt.get(toolCallId)),
        );
      },
      recordOutcome: (toolCallId, outcome) => {
        setStops((current) => {
          const outcomes = new Map<string, StopOutcome>(
            current.store === store ? current.outcomes : [],
          );
          outcomes.set(toolCallId, outcome);
          return { store, outcomes };
        });
      },
    }),
    [jobs, stops, kept, store],
  );
  return (
    <BackgroundJobKeptStopsContext.Provider value={keptForTasks}>
      <ToolRunActiveContext.Provider value={streaming}>
        <BackgroundJobCommandContext.Provider value={runBackgroundJobCommand}>
          <BackgroundJobsContext.Provider value={scope}>{children}</BackgroundJobsContext.Provider>
        </BackgroundJobCommandContext.Provider>
      </ToolRunActiveContext.Provider>
    </BackgroundJobKeptStopsContext.Provider>
  );
}

/**
 * The stops the server kept for this chat, read when the chat opens. A read belongs to one chat: one that finishes after
 * the chat changed is dropped, and a chat whose read has not finished has none.
 */
function useKeptStops(
  store: OmpRuntimeStore,
  load: ((threadId: ThreadId) => Promise<readonly BackgroundJobStop[]>) | undefined,
): KeptStops | undefined {
  const [kept, setKept] = useState<KeptStops | undefined>(undefined);
  useEffect(() => {
    if (load === undefined) return;
    let current = true;
    void load(store.getSnapshot().threadId).then(
      (list) => {
        if (current) {
          const stops = new Map(
            list.map((stop): [string, BackgroundJobStop] => [stop.jobId, stop]),
          );
          setKept({ store, stops });
        }
      },
      (error: unknown) =>
        console.error("[omp-app] could not read the chat's stopped background jobs", error),
    );
    return () => {
      current = false;
    };
  }, [load, store]);
  return kept?.store === store ? kept : undefined;
}

/** The outcome a card shows for the stop kept for its job, if that stop is this card's (see keptStopOutcome). */
function keptOutcome(
  kept: KeptStops | undefined,
  jobId: string | undefined,
  launchedAt: number | undefined,
): StopOutcome | undefined {
  const stop = jobId === undefined ? undefined : kept?.stops.get(jobId);
  return keptStopOutcome(stop, launchedAt);
}

/**
 * The chat's background jobs for `useSyncExternalStore`. They are derived again only when the messages, their order or
 * the process change, so a store update that changes none of them returns the same snapshot.
 */
function backgroundJobsSource(store: OmpRuntimeStore) {
  let seen:
    | { readonly messages: unknown; readonly order: unknown; readonly process: unknown }
    | undefined;
  let jobs: BackgroundJobs = { views: new Map(), launchedAt: new Map() };
  return {
    subscribe: (onChange: () => void) => store.subscribe(onChange),
    read: (): BackgroundJobs => {
      const snapshot = store.getSnapshot();
      const unchanged =
        seen !== undefined &&
        seen.messages === snapshot.messages &&
        seen.order === snapshot.messageOrder &&
        seen.process === snapshot.process;
      if (!unchanged) {
        seen = {
          messages: snapshot.messages,
          order: snapshot.messageOrder,
          process: snapshot.process,
        };
        jobs = {
          views: backgroundJobViews(snapshot.messageOrder, snapshot.messages, snapshot.process),
          launchedAt: backgroundJobLaunchTimes(snapshot.messageOrder, snapshot.messages),
        };
      }
      return jobs;
    },
  };
}

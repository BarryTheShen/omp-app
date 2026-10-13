import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { type BackgroundJobView, backgroundJobViews } from "@/modules/R0/store/background-jobs";
import { ToolRunActiveContext } from "@/modules/U1/tool-slots";
import {
  type BackgroundJobCommand,
  BackgroundJobCommandContext,
  BackgroundJobsContext,
  type BackgroundJobsScope,
  type StopOutcome,
} from "@/modules/U3/tool-card/background-job";

/**
 * The chat's run state for its tool calls. While the chat's run is active, a call with no result is queued,
 * not finished: omp starts an exclusive call only when its turn comes. Once the run has ended, a call with no
 * result is unrecorded. The run state is R0's own prompt flag, read live, not a timer. The chat's command gateway
 * is passed down too, so a background job's card can stop its own job. Each background job's view comes from the
 * chat's transcript and omp's process, and the stop a card last got is kept for the chat's page.
 */
export function ToolRunScope({
  store,
  runBackgroundJobCommand,
  children,
}: {
  readonly store: OmpRuntimeStore;
  readonly runBackgroundJobCommand?: BackgroundJobCommand | undefined;
  readonly children: ReactNode;
}) {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const streaming = useSyncExternalStore(subscribe, () => store.getSnapshot().prompt.streaming);
  const source = useMemo(() => backgroundViewsSource(store), [store]);
  const views = useSyncExternalStore(source.subscribe, source.read);
  const [stops, setStops] = useState(() => ({ store, outcomes: new Map<string, StopOutcome>() }));
  const scope = useMemo<BackgroundJobsScope>(
    () => ({
      viewOf: (toolCallId): BackgroundJobView | undefined => views.get(toolCallId),
      outcomeOf: (toolCallId) =>
        stops.store === store ? stops.outcomes.get(toolCallId) : undefined,
      recordOutcome: (toolCallId, outcome) =>
        setStops((current) => {
          const outcomes = new Map<string, StopOutcome>(
            current.store === store ? current.outcomes : [],
          );
          outcomes.set(toolCallId, outcome);
          return { store, outcomes };
        }),
    }),
    [views, stops, store],
  );
  return (
    <ToolRunActiveContext.Provider value={streaming}>
      <BackgroundJobCommandContext.Provider value={runBackgroundJobCommand}>
        <BackgroundJobsContext.Provider value={scope}>{children}</BackgroundJobsContext.Provider>
      </BackgroundJobCommandContext.Provider>
    </ToolRunActiveContext.Provider>
  );
}

/**
 * The views of the chat's background jobs for `useSyncExternalStore`. They are derived again only when the messages,
 * their order or the process change, so a store update that changes none of them returns the same map.
 */
function backgroundViewsSource(store: OmpRuntimeStore) {
  let seen:
    | { readonly messages: unknown; readonly order: unknown; readonly process: unknown }
    | undefined;
  let views: ReadonlyMap<string, BackgroundJobView> = new Map();
  return {
    subscribe: (onChange: () => void) => store.subscribe(onChange),
    read: (): ReadonlyMap<string, BackgroundJobView> => {
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
        views = backgroundJobViews(snapshot.messageOrder, snapshot.messages, snapshot.process);
      }
      return views;
    },
  };
}

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { EmptyState } from "@/components/blocks";
import type { SubagentClient } from "@/modules/P1/client";
import { type AgentHubController, AgentHubPanel, useAgentHub } from "@/modules/P1/panels";
import type { AgentRosterStore, FinishedWorkerSource, RosterAgent } from "@/modules/P1/roster";
import { createFocusedAgentRuntime, FocusedAgentTranscript } from "@/modules/P1/transcript";
import {
  type ProviderErrorResolver,
  ProviderErrorResolverProvider,
} from "@/modules/U1/parts/provider-error-resolver";

/** The live parts of the Agents tab for one chat: the hub, its roster, and omp's subagent client. */
export interface LiveAgents {
  readonly controller: AgentHubController;
  readonly roster: AgentRosterStore;
  readonly client: SubagentClient;
  readonly finished: FinishedWorkerSource;
}

/** What the tab shows: the Agent Hub, or one worker's transcript opened from it. */
export type AgentsView =
  | { readonly kind: "hub" }
  | { readonly kind: "transcript"; readonly agent: RosterAgent };

export interface AgentsPanelProps {
  readonly live: LiveAgents | null;
  readonly view: AgentsView;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly resolveProviderError?: ProviderErrorResolver;
}

/** The Agents tab's body. It takes its state and callbacks from `AgentsTab`, which owns them in `agents-tab.tsx`. */
export function AgentsPanel({
  live,
  view,
  onBack,
  onRetry,
  resolveProviderError,
}: AgentsPanelProps): ReactNode {
  if (live === null) return <EmptyState title="Loading the agents…" variant="compact" />;
  if (view.kind === "transcript") {
    return (
      <ProviderErrorResolverProvider resolver={resolveProviderError}>
        <WorkerTranscript
          agent={view.agent}
          client={live.client}
          finished={live.finished}
          onBack={onBack}
          roster={live.roster}
        />
      </ProviderErrorResolverProvider>
    );
  }
  return <Hub controller={live.controller} onRetry={onRetry} />;
}

function Hub({
  controller,
  onRetry,
}: {
  readonly controller: AgentHubController;
  readonly onRetry: () => void;
}) {
  const state = useAgentHub(controller);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <AgentHubPanel
        model={state.model}
        onCancel={(key) => void controller.cancel(key)}
        onOpenTranscript={(key) => controller.openTranscript(key)}
        onRetry={onRetry}
        onSelect={(key) => controller.select(key)}
        onViewChange={(view) => controller.setView(view)}
      />
    </div>
  );
}

/**
 * One worker's transcript with its Back control. The runtime follows the roster's current entry for
 * the worker, so a finished worker reads as finished; focus moves to Back when the view opens.
 */
function WorkerTranscript({
  agent,
  client,
  roster,
  finished,
  onBack,
}: {
  readonly agent: RosterAgent;
  readonly client: SubagentClient;
  readonly roster: AgentRosterStore;
  readonly finished: FinishedWorkerSource;
  readonly onBack: () => void;
}) {
  const subscribe = useCallback((listener: () => void) => roster.subscribe(listener), [roster]);
  const snapshot = useSyncExternalStore(subscribe, () => roster.getSnapshot());
  const current = snapshot.agents[agent.key] ?? agent;
  const runtime = useMemo(
    () => createFocusedAgentRuntime({ agent: current, client, finished }),
    [client, current, finished],
  );
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" ref={root}>
      <FocusedAgentTranscript onBack={onBack} onExit={onBack} runtime={runtime} />
    </div>
  );
}

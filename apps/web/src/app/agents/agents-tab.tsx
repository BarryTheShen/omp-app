import type { AppError } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import type { Surface } from "@/layout";
import type { AgentRef } from "@/modules/P1/contract";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import { createAgentHubController } from "@/modules/P1/panels";
import type { RosterAgent } from "@/modules/P1/roster";
import type { ProviderErrorResolver } from "@/modules/U1/parts/provider-error-resolver";
import { useRightSidebar } from "@/shell";
import { AgentsPanel, type AgentsView, type LiveAgents } from "./agents-panel";
import type { ThreadAgents } from "./thread-agents";

/**
 * omp's subagent commands the Agent Hub, its transcripts and the roster behind them use. While omp lacks
 * one of them the tab is not shown: a control that cannot work is not offered as a disabled one.
 */
export const AGENT_CAPABILITIES = [
  P1CapabilityKeys.roster,
  P1CapabilityKeys.transcript,
  P1CapabilityKeys.cancel,
  P1CapabilityKeys.steer,
  P1CapabilityKeys.subscription,
  P1CapabilityKeys.events,
] as const;

function failureOf(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return { code: "internal", message: "The subagent roster request failed.", retryable: true };
}

/** A roster entry is an AgentRef that the roster has keyed; the hub only ever hands over such entries. */
function isRosterAgent(agent: AgentRef): agent is RosterAgent {
  return "key" in agent && typeof agent.key === "string";
}

/**
 * The Agents tab for the open chat: omp's subagents as the Agent Hub, with a worker's transcript one press
 * away. The roster belongs to the chat (`ThreadAgents`); the tab starts it when it opens and builds only its
 * own hub view on top of it.
 */
export function agentsSurface({
  agents,
  reveal,
  resolveProviderError,
}: {
  readonly agents: ThreadAgents | null;
  readonly reveal?: number;
  readonly resolveProviderError?: ProviderErrorResolver;
}): Surface {
  return {
    title: "Agents",
    requires: AGENT_CAPABILITIES,
    grow: true,
    reveal,
    render: () => (
      <AgentsTab agents={agents} reveal={reveal} resolveProviderError={resolveProviderError} />
    ),
  };
}

function AgentsTab({
  agents,
  reveal,
  resolveProviderError,
}: {
  readonly agents: ThreadAgents | null;
  readonly reveal: number | undefined;
  readonly resolveProviderError?: ProviderErrorResolver;
}) {
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState<LiveAgents | null>(null);
  const [view, setView] = useState<AgentsView>({ kind: "hub" });
  const seenReveal = useRef(reveal);
  useEffect(() => {
    if (reveal === seenReveal.current) return;
    seenReveal.current = reveal;
    setView({ kind: "hub" });
  }, [reveal]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry (attempt) starts the roster again on purpose.
  useEffect(() => {
    if (agents === null) return;
    let active = true;
    const controller = createAgentHubController({
      roster: agents.roster,
      initialLoad: { state: "loading" },
      actions: () => ({
        cancel: { state: "available", run: (agent) => agents.client.cancel(agent.id) },
        openTranscript: {
          state: "available",
          open: (agent) => {
            // The hub hands over its roster entry, which carries the key; anything else is not a worker here.
            if (isRosterAgent(agent)) setView({ kind: "transcript", agent });
          },
        },
      }),
    });
    setView({ kind: "hub" });
    setLive({
      controller,
      roster: agents.roster,
      client: agents.client,
      finished: agents.finished,
    });
    agents.start().then(
      () => {
        if (active) controller.setLoad({ state: "ready" });
      },
      (error: unknown) => {
        if (active) controller.setLoad({ state: "error", error: failureOf(error) });
      },
    );
    return () => {
      active = false;
      setLive(null);
    };
  }, [agents, attempt]);

  return (
    <AgentsPanel
      live={live}
      resolveProviderError={resolveProviderError}
      onBack={() => setView({ kind: "hub" })}
      onRetry={() => setAttempt((count) => count + 1)}
      view={view}
    />
  );
}

/**
 * Opens the Panels sidebar when a person asks for the Agent Hub (`← ←`) while the sidebar is closed. It renders
 * nothing: the Agents tab comes to the front through its `reveal`. It is mounted beside the panels, so it runs
 * whether or not the sidebar is open.
 */
export function RevealAgentHub({ reveal }: { readonly reveal: number }) {
  const sidebar = useRightSidebar();
  const seen = useRef(reveal);
  useEffect(() => {
    if (reveal === seen.current) return;
    seen.current = reveal;
    sidebar?.show();
  }, [reveal, sidebar]);
  return null;
}

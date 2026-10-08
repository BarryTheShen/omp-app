import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LayoutArea, type SurfaceMap } from "@/layout";
import type { SubagentClient, SubagentSession } from "@/modules/P1/client";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import { createAgentHubController } from "@/modules/P1/panels";
import { fixtureClock, fixtureRoster, fixtureWorker } from "@/modules/P1/panels/fixtures";
import type { RosterAgent } from "@/modules/P1/roster";
import { transcriptPage, userMessage } from "@/modules/P1/transcript/test/fixtures";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { AgentsPanel, type AgentsView, type LiveAgents } from "./agents-panel";
import { AGENT_CAPABILITIES, agentsSurface } from "./agents-tab";
import { useThreadAgents } from "./thread-agents-scope";

const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  // The transcript's viewport needs these browser APIs; jsdom has neither.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

const threadId = "agents-thread" as ThreadId;

function allCapabilities(except?: string): CapabilityMap {
  const capabilities: CapabilityMap = {};
  for (const key of AGENT_CAPABILITIES) {
    if (key === except) continue;
    capabilities[key] = { state: "available", via: "rpc" };
  }
  return capabilities;
}

const noSession = {} as unknown as SubagentSession;

/** The panels area as the thread view mounts it: the todo panel and the Agents tab. */
function AgentsTabHarness({
  capabilities,
  session = noSession,
}: {
  readonly capabilities: CapabilityMap;
  readonly session?: SubagentSession;
}) {
  const [store] = useState(() => new OmpRuntimeStore({ threadId }));
  const agents = useThreadAgents({ threadId, store, session, capabilities });
  const surfaces: SurfaceMap = {
    todo: { title: "Todo checklist", render: () => <p>Todo body</p> },
    agents: agentsSurface({ agents }),
  };
  return <LayoutArea area="panels" capabilities={capabilities} surfaces={surfaces} />;
}

/** A fake omp subagent client: the roster is fixed and the transcript reads one user message. */
function fakeClient(): SubagentClient {
  return {
    getRoster: async () => [],
    readTranscript: async () =>
      transcriptPage({
        fromByte: 0,
        nextByte: 120,
        messages: [userMessage("Scan the repository now")],
      }),
    cancel: async () => ({ cancelled: true as const }),
    steer: async () => {},
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => ({ level, release: async () => {} }),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
}

async function liveAgents(onOpenTranscript: (agent: RosterAgent) => void): Promise<LiveAgents> {
  const roster = await fixtureRoster({
    workers: [fixtureWorker("worker-1", 1, { description: "Scan the repository" })],
    clock: fixtureClock(),
  });
  const controller = createAgentHubController({
    roster,
    initialLoad: { state: "ready" },
    actions: () => ({
      cancel: { state: "unavailable", reason: "Cancel is not needed in this test." },
      openTranscript: {
        state: "available",
        open: (agent) => onOpenTranscript(agent as RosterAgent),
      },
    }),
  });
  return { controller, roster, client: fakeClient() };
}

describe("Agents tab availability", () => {
  test("the tab needs every subagent command it uses; without one it is not listed", () => {
    expect(AGENT_CAPABILITIES).toEqual([
      P1CapabilityKeys.roster,
      P1CapabilityKeys.transcript,
      P1CapabilityKeys.cancel,
      P1CapabilityKeys.steer,
      P1CapabilityKeys.subscription,
      P1CapabilityKeys.events,
    ]);
    render(<AgentsTabHarness capabilities={allCapabilities(P1CapabilityKeys.steer)} />);
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
    expect(screen.getByText("Todo body")).toBeTruthy();
  });
});

describe("Agents tab subscription", () => {
  test("the roster asks omp for progress only once the Agents tab is shown", async () => {
    const levels: string[] = [];
    const session = {
      send: async () => ({ subagents: [] }),
      setSubagentSubscription: async (args: { level: string }) => {
        levels.push(args.level);
        return { level: args.level };
      },
    } as unknown as SubagentSession;
    render(<AgentsTabHarness capabilities={allCapabilities()} session={session} />);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
    expect(levels).toEqual([]);
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => expect(levels).toEqual(["progress"]));
  });
});

describe("Agents tab content", () => {
  test("shows a loading line until the roster exists", () => {
    render(
      <AgentsPanel
        live={null}
        onBack={() => undefined}
        onRetry={() => undefined}
        view={{ kind: "hub" }}
      />,
    );
    expect(screen.getByText("Loading the agents…")).toBeTruthy();
  });

  test("the hub lists the worker, and Open transcript hands the worker to the tab", async () => {
    const opened: RosterAgent[] = [];
    const live = await liveAgents((agent) => opened.push(agent));
    render(
      <AgentsPanel
        live={live}
        onBack={() => undefined}
        onRetry={() => undefined}
        view={{ kind: "hub" }}
      />,
    );
    expect(screen.getByRole("region", { name: "Agent Hub" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Scan the repository/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]?.description).toBe("Scan the repository");
    await live.roster.dispose();
    await live.client.dispose();
  });

  test("a worker's transcript has a Back control that returns to the hub, and takes focus on open", async () => {
    const live = await liveAgents(() => undefined);
    const [worker] = Object.values(live.roster.getSnapshot().agents);
    if (worker === undefined) throw new Error("The fixture roster has no worker.");
    const onBack = vi.fn<() => void>();
    const view: AgentsView = { kind: "transcript", agent: worker };
    render(<AgentsPanel live={live} onBack={onBack} onRetry={() => undefined} view={view} />);
    const section = await screen.findByRole("region", {
      name: "Transcript of Scan the repository",
    });
    expect(section).toBeTruthy();
    const back = screen.getByRole("button", { name: "Back" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    await live.roster.dispose();
    await live.client.dispose();
  });
});

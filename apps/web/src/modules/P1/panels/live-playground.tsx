import type { AppClient } from "@omp-app/client";
import {
  type AppError,
  AppFailure,
  AppPort,
  type CapabilityMap,
  RpcSessionPort,
  ThreadId,
} from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessibilityProvider } from "@/a11y/live-region";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "@/launch";
import { createSubagentClient, type SubagentClient } from "@/modules/P1/client";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import { AgentRosterStore } from "@/modules/P1/roster";
import { createSelectedThreadHistoryController } from "@/modules/R1/history";
import {
  type AgentHubActions,
  type AgentHubController,
  type CancelAction,
  createAgentHubController,
} from "./controller";
import { AgentHubPanel } from "./hub";
import { useAgentHub } from "./use-agent-hub";

/**
 * Test harness for the real-omp proof: the Agent Hub on one real chat. It opens the chat through
 * the app's own connection and store (R1 history, R0 store), then wires P1.2's subagent client and
 * P1.3's roster into the panel's callbacks. The app's layout does not place the panel yet; this
 * page is where the e2e drives it. The transcript stays unconnected until P1.4 lands.
 */
const TRANSCRIPT_REASON = "The transcript view is not connected in this window yet.";

interface LiveHub {
  readonly controller: AgentHubController;
  readonly roster: AgentRosterStore;
  readonly subagents: SubagentClient;
}

type Setup =
  | { readonly state: "starting" }
  | { readonly state: "ready"; readonly hub: LiveHub }
  | { readonly state: "failed"; readonly error: AppError };

function failureOf(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return { code: "internal", message: "The agent hub could not start.", retryable: true };
}

function cancelFor(capabilities: CapabilityMap, subagents: SubagentClient): CancelAction {
  if (capabilities[P1CapabilityKeys.cancel]?.state !== "available") {
    return { state: "unavailable", reason: "This omp cannot cancel workers." };
  }
  return { state: "available", run: (agent) => subagents.cancel(agent.id) };
}

async function startHub(client: AppClient, threadId: ThreadId): Promise<LiveHub> {
  const app = client.port(AppPort);
  const [server, capabilities] = await Promise.all([app.serverInfo({}), app.capabilities({})]);
  const history = createSelectedThreadHistoryController({ client, folder: server.launchFolder });
  const store = await history.openExisting(threadId);
  const subagents = createSubagentClient({
    threadId,
    session: client.port(RpcSessionPort),
    runtime: store,
    capabilities,
  });
  const roster = new AgentRosterStore({ threadId, client: subagents });
  try {
    await roster.start();
  } catch (error) {
    await subagents.dispose();
    throw error;
  }
  const actions: AgentHubActions = {
    cancel: cancelFor(capabilities, subagents),
    openTranscript: { state: "unavailable", reason: TRANSCRIPT_REASON },
  };
  const controller = createAgentHubController({
    roster,
    initialLoad: { state: "ready" },
    actions: () => actions,
  });
  return { controller, roster, subagents };
}

async function stopHub(hub: LiveHub): Promise<void> {
  await hub.roster.dispose();
  await hub.subagents.dispose();
}

function threadFromAddress(): ThreadId | null {
  const parsed = ThreadId.safeParse(new URLSearchParams(window.location.search).get("thread"));
  return parsed.success ? parsed.data : null;
}

function HubView({ controller }: { readonly controller: AgentHubController }) {
  const state = useAgentHub(controller);
  return (
    <div className="h-screen w-96 max-w-full" data-testid="p1-hub-live-panel">
      <AgentHubPanel
        model={state.model}
        onCancel={(key) => void controller.cancel(key)}
        onOpenChange={() => undefined}
        onOpenTranscript={(key) => controller.openTranscript(key)}
        onSelect={(key) => controller.select(key)}
        onViewChange={(view) => controller.setView(view)}
      />
    </div>
  );
}

function HubPage() {
  const connection = useAppConnection();
  const client = connection.client;
  const [setup, setSetup] = useState<Setup>({ state: "starting" });
  useEffect(() => {
    if (!client) return;
    const threadId = threadFromAddress();
    if (!threadId) {
      setSetup({
        state: "failed",
        error: {
          code: "invalid_args",
          message: "The page address names no chat.",
          retryable: false,
        },
      });
      return;
    }
    let active = true;
    let started: LiveHub | undefined;
    startHub(client, threadId).then(
      (hub) => {
        if (!active) {
          void stopHub(hub);
          return;
        }
        started = hub;
        setSetup({ state: "ready", hub });
      },
      (error: unknown) => {
        if (active) setSetup({ state: "failed", error: failureOf(error) });
      },
    );
    return () => {
      active = false;
      if (started) void stopHub(started);
    };
  }, [client]);
  if (setup.state === "failed") {
    return (
      <p className="text-danger p-4 text-sm" role="alert">
        {setup.error.message}
      </p>
    );
  }
  if (setup.state === "starting") {
    return (
      <p className="text-muted-foreground p-4 text-sm" role="status">
        Opening the agent hub…
      </p>
    );
  }
  return <HubView controller={setup.hub.controller} />;
}

function LiveHubPlayground() {
  return (
    <AccessibilityProvider>
      <AppConnectionProvider>
        <AppConnectionGate>
          <main className="bg-background text-foreground min-h-screen" data-testid="p1-hub-live">
            <HubPage />
          </main>
        </AppConnectionGate>
      </AppConnectionProvider>
    </AccessibilityProvider>
  );
}

const root = document.getElementById("p1-5-hub-live-root");
if (!root) throw new Error("The live Agent Hub root is missing.");
createRoot(root).render(
  <StrictMode>
    <LiveHubPlayground />
  </StrictMode>,
);

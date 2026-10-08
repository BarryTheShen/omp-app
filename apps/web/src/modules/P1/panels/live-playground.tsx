import type { AppClient } from "@omp-app/client";
import {
  type AppError,
  AppFailure,
  AppPort,
  type CapabilityMap,
  RpcSessionPort,
  SessionFilePath,
  SessionFileStore,
  ThreadId,
} from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessibilityProvider } from "@/a11y/live-region";
import { Button } from "@/components/ui/button";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "@/launch";
import {
  createSubagentClient,
  type SubagentClient,
  type SubagentSession,
} from "@/modules/P1/client";
import { type FocusedAgentRuntime, P1CapabilityKeys } from "@/modules/P1/contract";
import {
  AgentRosterStore,
  createFinishedWorkerSource,
  type FinishedWorkerSource,
} from "@/modules/P1/roster";
import { createFocusedAgentRuntime, FocusedAgentTranscript } from "@/modules/P1/transcript";
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
 * P1.3's roster into the panel's callbacks. The roster also lists the chat's finished workers from
 * their transcripts, so a reload still shows them, and Open transcript shows the focused view. The
 * app's layout does not place the panel yet; this page is where the e2e drives it.
 */

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

/**
 * The chat's finished workers, read from its own files. Needs the session-files capability and the
 * chat's file, which omp reports in its state; without either, only the live roster is shown.
 */
async function finishedWorkersOf(
  client: AppClient,
  session: SubagentSession,
  threadId: ThreadId,
  capabilities: CapabilityMap,
): Promise<FinishedWorkerSource | undefined> {
  if (capabilities["host.session-files"]?.state !== "available") return undefined;
  const state = await session.send({ threadId, command: { type: "get_state" } });
  const sessionFile = SessionFilePath.safeParse(state.sessionFile);
  if (!sessionFile.success) return undefined;
  return createFinishedWorkerSource({
    threadId,
    sessionFile: sessionFile.data,
    files: client.port(SessionFileStore),
  });
}

async function startHub(
  client: AppClient,
  threadId: ThreadId,
  openTranscript: (runtime: FocusedAgentRuntime) => void,
): Promise<LiveHub> {
  const app = client.port(AppPort);
  const [server, capabilities] = await Promise.all([app.serverInfo({}), app.capabilities({})]);
  const history = createSelectedThreadHistoryController({ client, folder: server.launchFolder });
  const store = await history.openExisting(threadId);
  const rpc = client.port(RpcSessionPort);
  const subagents = createSubagentClient({ threadId, session: rpc, runtime: store, capabilities });
  const finished = await finishedWorkersOf(client, rpc, threadId, capabilities);
  const roster = new AgentRosterStore({ threadId, client: subagents, finished });
  try {
    await roster.start();
  } catch (error) {
    await subagents.dispose();
    throw error;
  }
  const actions: AgentHubActions = {
    cancel: cancelFor(capabilities, subagents),
    openTranscript: {
      state: "available",
      open: (agent) =>
        openTranscript(createFocusedAgentRuntime({ agent, client: subagents, finished })),
    },
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

/** One worker's focused transcript, with a way back to the Hub. */
function TranscriptView({
  runtime,
  onBack,
}: {
  readonly runtime: FocusedAgentRuntime;
  readonly onBack: () => void;
}) {
  return (
    <div className="flex h-screen w-96 max-w-full flex-col" data-testid="p1-transcript-live">
      <div className="p-2">
        <Button onClick={onBack} size="sm" variant="outline">
          Back to the Agent Hub
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <FocusedAgentTranscript runtime={runtime} onBack={onBack} />
      </div>
    </div>
  );
}

function HubPage() {
  const connection = useAppConnection();
  const client = connection.client;
  const [setup, setSetup] = useState<Setup>({ state: "starting" });
  const [transcript, setTranscript] = useState<FocusedAgentRuntime | null>(null);
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
    startHub(client, threadId, setTranscript).then(
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
  if (transcript) return <TranscriptView runtime={transcript} onBack={() => setTranscript(null)} />;
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

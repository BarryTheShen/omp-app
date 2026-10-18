import type { AppClient } from "@omp-app/client";
import { type AppError, AppFailure, AppPort, type FolderPath, ThreadId } from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessibilityProvider } from "@/a11y/live-region";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "@/launch";
import type { AdvisorState } from "../contract";
import {
  type AdvisorCommandController,
  type AdvisorConfigController,
  createAdvisorCommandController,
  createAdvisorCommandSource,
  createAdvisorConfigController,
} from "./advisor";
import { AdvisorConfigurationView } from "./configuration";
import { AdvisorNoteList } from "./note-card";
import { AdvisorStatusChip } from "./status-chip";

interface AdvisorSetup {
  readonly command: AdvisorCommandController;
  readonly config: AdvisorConfigController;
  readonly folder: FolderPath;
}

type LoadState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly setup: AdvisorSetup }
  | { readonly state: "error"; readonly error: AppError };

function failureOf(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return { code: "internal", message: "Advisor controls could not start.", retryable: true };
}

function threadFromAddress(): ThreadId | null {
  const value = new URLSearchParams(window.location.search).get("thread");
  const parsed = ThreadId.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function startAdvisor(client: AppClient, threadId: ThreadId): Promise<AdvisorSetup> {
  const app = client.port(AppPort);
  const server = await app.serverInfo({});
  const command = createAdvisorCommandController(createAdvisorCommandSource(client, threadId));
  const config = createAdvisorConfigController(client, {
    folder: server.launchFolder,
    layer: "global",
  });
  await config.read();
  return { command, config, folder: server.launchFolder };
}

function AdvisorPage() {
  const connection = useAppConnection();
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [advisorState] = useState<AdvisorState>({ mode: "unknown", status: "unknown", note: null });
  const client = connection.client;

  useEffect(() => {
    if (!client) return;
    const threadId = threadFromAddress();
    if (!threadId) {
      setLoad({
        state: "error",
        error: {
          code: "invalid_args",
          message: "The page address names no chat.",
          retryable: false,
        },
      });
      return;
    }
    let active = true;
    let setup: AdvisorSetup | undefined;
    void startAdvisor(client, threadId).then(
      (next) => {
        setup = next;
        if (active) setLoad({ state: "ready", setup: next });
        else {
          next.command.dispose();
          next.config.dispose();
        }
      },
      (error: unknown) => {
        if (active) setLoad({ state: "error", error: failureOf(error) });
      },
    );
    return () => {
      active = false;
      setup?.command.dispose();
      setup?.config.dispose();
    };
  }, [client]);

  if (load.state === "loading") return <p role="status">Opening advisor controls…</p>;
  if (load.state === "error") return <p role="alert">{load.error.message}</p>;
  return (
    <main
      className="bg-background text-foreground min-h-screen space-y-4 p-4"
      data-testid="p1-advisor-live"
    >
      <AdvisorStatusChip state={advisorState} commands={load.setup.command} />
      <AdvisorConfigurationView
        state={load.setup.config.getSnapshot()}
        controller={load.setup.config}
      />
      <AdvisorNoteList notes={[]} />
    </main>
  );
}

function LiveAdvisorPlayground() {
  return (
    <AccessibilityProvider>
      <AppConnectionProvider>
        <AppConnectionGate>
          <AdvisorPage />
        </AppConnectionGate>
      </AppConnectionProvider>
    </AccessibilityProvider>
  );
}

const root = document.getElementById("p1-7-advisor-live-root");
if (!root) throw new Error("The live advisor root is missing.");
createRoot(root).render(
  <StrictMode>
    <LiveAdvisorPlayground />
  </StrictMode>,
);

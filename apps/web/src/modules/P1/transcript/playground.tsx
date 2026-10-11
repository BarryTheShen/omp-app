/**
 * P1.4's real-omp check page. It runs the app's own composition (the connection, the chat's history and
 * events, the subagent client and the roster) around the focused transcript, against the real app server.
 * The e2e spec builds it into `dist/` and opens it on that server with the same launch token, so the
 * transcript and the steer editor are exercised against real omp. The app does not link this page; the
 * Agent Hub (P1.5) places the view later.
 */
import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type FolderPath,
  RpcSessionPort,
  type SessionFile,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  AppConnectionGate,
  AppConnectionProvider,
  useAppConnection,
} from "@/launch/app-connection";
import { createSubagentClient, type SubagentClient } from "@/modules/P1/client";
import { AgentRosterStore, type RosterAgent } from "@/modules/P1/roster";
import {
  createSelectedThreadHistoryController,
  type SelectedThreadHistoryController,
} from "@/modules/R1/history/history";
import { FocusedAgentTranscript } from "./focused-view";
import { createFocusedAgentRuntime } from "./source";

interface Session {
  readonly history: SelectedThreadHistoryController;
  readonly subagents: SubagentClient;
  readonly roster: AgentRosterStore;
}

const STATUS_LABEL = {
  pending: "Waiting to start",
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  aborted: "Cancelled",
  stopped: "Stopped",
} as const;

function messageOf(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  if (error instanceof Error) return error.message;
  return "The check page could not start.";
}

/**
 * The folder's newest chat. The app's own tab already holds the chat's process, so the check page must
 * attach to that chat by id: `openLatest` would start a second process for it and the server refuses.
 */
async function newestThreadId(client: AppClient, folder: FolderPath): Promise<ThreadId> {
  const { sessions } = await client.port(SessionFileStore).listSessions({ folder });
  let newest: SessionFile | undefined;
  for (const session of sessions) {
    if (newest === undefined || Date.parse(session.updatedAt) > Date.parse(newest.updatedAt)) {
      newest = session;
    }
  }
  if (newest === undefined) {
    throw new AppFailure({
      code: "not_found",
      message: "This folder has no chat yet.",
      retryable: false,
    });
  }
  return newest.id;
}

/** Opens the folder's newest chat, and the roster for it. */
async function openSession(client: AppClient): Promise<Session> {
  const app = client.port(AppPort);
  const [capabilities, serverInfo] = await Promise.all([app.capabilities({}), app.serverInfo({})]);
  const threadId = await newestThreadId(client, serverInfo.launchFolder);
  const history = createSelectedThreadHistoryController({
    client,
    folder: serverInfo.launchFolder,
  });
  const store = await history.openExisting(threadId);
  const subagents = createSubagentClient({
    threadId,
    session: client.port(RpcSessionPort),
    runtime: store,
    capabilities,
  });
  const roster = new AgentRosterStore({ threadId, client: subagents });
  const session: Session = { history, subagents, roster };
  try {
    await roster.start();
  } catch (error) {
    await closeSession(session);
    throw error;
  }
  return session;
}

async function closeSession(session: Session): Promise<void> {
  await session.roster.dispose();
  await session.subagents.dispose();
  await session.history.close();
}

function RosterAndTranscript({ session }: { readonly session: Session }) {
  const snapshot = useSyncExternalStore(
    (listener) => session.roster.subscribe(listener),
    () => session.roster.getSnapshot(),
    () => session.roster.getSnapshot(),
  );
  const agents = snapshot.order
    .map((key) => snapshot.agents[key])
    .filter((agent): agent is RosterAgent => agent !== undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(true);
  const agent =
    agents.find((candidate) => candidate.id === chosen) ??
    agents.find((candidate) => candidate.status === "running") ??
    agents[0];
  const runtime = useMemo(
    () =>
      agent === undefined
        ? undefined
        : createFocusedAgentRuntime({ agent, client: session.subagents }),
    [agent, session.subagents],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {agents.length === 0 ? (
        <p className="text-muted-foreground" role="status">
          No workers in this chat yet.
        </p>
      ) : (
        <ul aria-label="Workers" className="flex flex-wrap gap-2">
          {agents.map((item) => (
            <li key={item.key}>
              <button
                aria-pressed={item.id === agent?.id}
                className="border-border rounded-md border px-3 py-1.5 text-sm aria-pressed:bg-muted"
                onClick={() => {
                  setChosen(item.id);
                  setOpen(true);
                }}
                type="button"
              >
                {item.description?.trim() || item.agent} · {STATUS_LABEL[item.status]}
              </button>
            </li>
          ))}
        </ul>
      )}
      {runtime !== undefined && open ? (
        <div className="border-border flex h-[70dvh] min-h-0 flex-col overflow-hidden rounded-lg border">
          <FocusedAgentTranscript
            onBack={() => setOpen(false)}
            onExit={() => setOpen(false)}
            runtime={runtime}
          />
        </div>
      ) : null}
      {runtime !== undefined && !open ? (
        <p className="text-muted-foreground" role="status">
          The transcript is closed.
        </p>
      ) : null}
    </div>
  );
}

function Check({ client }: { readonly client: AppClient }) {
  const [session, setSession] = useState<Session | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    let opened: Session | undefined;
    openSession(client).then(
      (next) => {
        if (!active) {
          void closeSession(next).catch((error: unknown) => setFailure(messageOf(error)));
          return;
        }
        opened = next;
        setSession(next);
      },
      (error: unknown) => {
        if (active) setFailure(messageOf(error));
      },
    );
    return () => {
      active = false;
      if (opened !== undefined) {
        void closeSession(opened).catch((error: unknown) => setFailure(messageOf(error)));
      }
    };
  }, [client]);

  if (failure !== undefined) {
    return (
      <p className="text-destructive" role="alert">
        {failure}
      </p>
    );
  }
  if (session === undefined) {
    return (
      <p className="text-muted-foreground" role="status">
        Opening the chat…
      </p>
    );
  }
  return <RosterAndTranscript session={session} />;
}

function CheckApp() {
  const connection = useAppConnection();
  if (connection.client === null) {
    return (
      <p className="text-muted-foreground" role="status">
        {connection.reason ?? "Connecting to the app server…"}
      </p>
    );
  }
  return <Check client={connection.client} />;
}

const root = document.getElementById("p1-4-transcript-root");
if (!root) throw new Error("The P1.4 check page root is missing.");
createRoot(root).render(
  <AppConnectionProvider>
    <AppConnectionGate>
      <main
        className="bg-background text-foreground flex min-h-dvh min-w-0 flex-col gap-4 p-4 text-sm"
        data-testid="p1-4-transcript-check"
      >
        <h1 className="text-base font-semibold">Worker transcript check</h1>
        <CheckApp />
      </main>
    </AppConnectionGate>
  </AppConnectionProvider>,
);

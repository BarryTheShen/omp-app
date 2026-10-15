/**
 * T5.2's real-omp check page. It runs the app's own composition (the connection, the chat's store, the
 * subagent client and the roster) around the task card, against the real app server. The e2e spec builds
 * it into `dist/` and opens it on that server with the same launch token. It attaches to the folder's
 * newest chat by id (a second connection would start a second omp process, which the server refuses),
 * takes the chat's task call as the app's transcript converts it, and renders its card with each worker's
 * read-only transcript.
 */
import { ThreadPrimitive } from "@assistant-ui/react";
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import {
  AppConnectionGate,
  AppConnectionProvider,
  useAppConnection,
} from "@/launch/app-connection";
import { createSubagentClient, type SubagentClient } from "@/modules/P1/client";
import type { FocusedAgentRuntime } from "@/modules/P1/contract";
import { AgentRosterStore, type RosterAgent } from "@/modules/P1/roster";
import { createFocusedAgentRuntime, ReadOnlyThread } from "@/modules/P1/transcript";
import { convertExternalMessage, OmpRuntimeController } from "@/modules/R0/runtime/runtime";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store/store";
import {
  createSelectedThreadHistoryController,
  type SelectedThreadHistoryController,
} from "@/modules/R1/history/history";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { TaskCard, type TaskSubagentLookup, TaskSubagentsContext } from "./task";

interface Session {
  readonly store: OmpRuntimeStore;
  readonly controller: OmpRuntimeController;
  readonly subagents: SubagentClient;
  readonly roster: AgentRosterStore;
  readonly history: SelectedThreadHistoryController;
}

function messageOf(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  if (error instanceof Error) return error.message;
  return "The check page could not start.";
}

/** The folder's newest chat: the one the spec's app tab is running. */
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

async function openSession(client: AppClient): Promise<Session> {
  const app = client.port(AppPort);
  const rpc = client.port(RpcSessionPort);
  const [capabilities, serverInfo] = await Promise.all([app.capabilities({}), app.serverInfo({})]);
  const threadId = await newestThreadId(client, serverInfo.launchFolder);
  const history = createSelectedThreadHistoryController({
    client,
    folder: serverInfo.launchFolder,
  });
  const store = await history.openExisting(threadId);
  const controller = new OmpRuntimeController({ capabilities, send: rpc.send, store });
  const subagents = createSubagentClient({
    threadId,
    session: rpc,
    runtime: store,
    capabilities,
  });
  const roster = new AgentRosterStore({ threadId, client: subagents });
  const session: Session = { store, controller, subagents, roster, history };
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

/**
 * The chat's first task call, as the app's transcript converts it: the call's arguments, and the result
 * omp recorded for it (a tool result is its own message, paired by the call id).
 */
function taskCallOf(
  controller: OmpRuntimeController,
  snapshot: RuntimeSnapshot,
): ToolRendererProps | undefined {
  const results = new Map<string, unknown>();
  let call:
    | {
        readonly toolCallId: string;
        readonly args: unknown;
        readonly result: unknown;
        readonly isError: boolean;
      }
    | undefined;
  for (const view of controller.messages(snapshot)) {
    const message = convertExternalMessage(view);
    if (message.role === "tool") {
      results.set(message.toolCallId, message.result);
      continue;
    }
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (
        call === undefined &&
        part.type === "tool-call" &&
        part.toolName === "task" &&
        part.toolCallId !== undefined
      ) {
        call = {
          toolCallId: part.toolCallId,
          args: part.args,
          result: part.result,
          isError: part.isError === true,
        };
      }
    }
  }
  if (call === undefined) return undefined;
  return {
    toolCallId: call.toolCallId,
    toolName: "task",
    args: call.args,
    argsText: JSON.stringify(call.args ?? {}),
    result: call.result ?? results.get(call.toolCallId),
    isError: call.isError,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

/** The check: the chat's task call, rendered by the real card, with its workers' transcripts through P1. */
function TaskCheck({ session }: { readonly session: Session }) {
  const roster = useSyncExternalStore(
    (listener) => session.roster.subscribe(listener),
    () => session.roster.getSnapshot(),
    () => session.roster.getSnapshot(),
  );
  const runtime = useSyncExternalStore(
    (listener) => session.store.subscribe(listener),
    () => session.store.getSnapshot(),
    () => session.store.getSnapshot(),
  );
  // One source per roster entry: a roster update for the same worker hands its new reference to the same view.
  const sources = useRef(
    new Map<string, { readonly agent: RosterAgent; readonly source: FocusedAgentRuntime }>(),
  ).current;
  const lookup = useCallback<TaskSubagentLookup>(
    (parentToolCallId) =>
      roster.order
        .map((key) => roster.agents[key])
        .filter(
          (agent): agent is RosterAgent =>
            agent !== undefined && agent.parentToolCallId === parentToolCallId,
        )
        .map((agent) => {
          const cached = sources.get(agent.key);
          if (cached !== undefined && cached.agent === agent) return cached;
          const next = {
            agent,
            source: createFocusedAgentRuntime({ agent, client: session.subagents }),
          };
          sources.set(agent.key, next);
          return next;
        }),
    [roster, session.subagents, sources],
  );

  const props = useMemo(
    () => taskCallOf(session.controller, runtime),
    [session.controller, runtime],
  );
  if (props === undefined) {
    return (
      <p className="text-muted-foreground" role="status">
        No task call in this chat yet.
      </p>
    );
  }
  return (
    <ReadOnlyThread messages={[]}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <TaskSubagentsContext.Provider value={lookup}>
            <TaskCard rendererProps={props} />
          </TaskSubagentsContext.Provider>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ReadOnlyThread>
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
  return <TaskCheck session={session} />;
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

const root = document.getElementById("t5-2-task-card-root");
if (!root) throw new Error("The T5.2 check page root is missing.");
createRoot(root).render(
  <AppConnectionProvider>
    <AppConnectionGate>
      <main
        className="bg-background text-foreground font-sans flex min-h-dvh min-w-0 flex-col gap-4 p-4 text-sm"
        data-testid="t5-2-task-check"
      >
        <h1 className="text-base font-semibold">Task card check</h1>
        <CheckApp />
      </main>
    </AppConnectionGate>
  </AppConnectionProvider>,
);

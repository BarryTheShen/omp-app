/**
 * D4.3's real-omp check page. It runs the app's own composition (the connection, the overlay host and U4's
 * DialogHost) around the export slash commands, against the real app server. The e2e spec builds it into
 * `dist/` and opens it on that server with the same launch token. It attaches to the folder's newest chat,
 * reads its messages through U1.7, and offers one button per export command. Each button runs its command
 * directly: the page does not route typed text, so the composer's routing is checked by the unit tests.
 * Downloads go through the app's own `saveTextFile`, so the spec sees them as real browser downloads.
 * `?window=<bytes>` sets a smaller history window, so the spec can split a short chat into several windows and check
 * that the export loads them all.
 */
import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type FolderPath,
  OmpCommandGateway,
  type PortClient,
  type RpcSessionClient,
  RpcSessionPort,
  type SessionFile,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { saveTextFile } from "@/app/save-file";
import { Button } from "@/components/ui/button";
import {
  AppConnectionGate,
  AppConnectionProvider,
  useAppConnection,
} from "@/launch/app-connection";
import { SessionHistoryLoader } from "@/modules/R0/history/history";
import { OmpRuntimeController } from "@/modules/R0/runtime/runtime";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store/store";
import {
  createSelectedThreadHistoryController,
  type SelectedThreadHistoryController,
} from "@/modules/R1/history/history";
import type { KeyedTranscriptMessage } from "@/modules/U1/copy";
import { renderDialogRequest } from "@/modules/U4/dialogs";
import { DialogHostController } from "@/modules/U4/host";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import { createExportSlashCommands } from "./commands";
import { createExportPort } from "./port";
import type { ChatHistory } from "./whole-chat";

interface Session {
  readonly store: OmpRuntimeStore;
  /** Keeps the store live as omp streams, so an export after new output uses the newest text. */
  readonly controller: OmpRuntimeController;
  readonly history: SelectedThreadHistoryController;
  readonly threadId: ThreadId;
  readonly rpc: RpcSessionClient;
  readonly gateway: PortClient<typeof OmpCommandGateway>;
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
  const rpc = client.port(RpcSessionPort) as RpcSessionClient;
  const [capabilities, serverInfo] = await Promise.all([app.capabilities({}), app.serverInfo({})]);
  const threadId = await newestThreadId(client, serverInfo.launchFolder);
  const windowBytes = windowBytesFromUrl();
  const history = createSelectedThreadHistoryController({
    client,
    folder: serverInfo.launchFolder,
    ...(windowBytes === undefined
      ? {}
      : {
          createLoader: (id, session, store) =>
            smallWindowLoader(client, id, session, store, windowBytes),
        }),
  });
  const store = await history.openExisting(threadId);
  const controller = new OmpRuntimeController({ capabilities, send: rpc.send, store });
  return { store, controller, history, threadId, rpc, gateway: client.port(OmpCommandGateway) };
}

/** The chat's messages in transcript order, with the keys the app gave them. */
function orderedMessages(snapshot: RuntimeSnapshot): readonly KeyedTranscriptMessage[] {
  return snapshot.messageOrder.flatMap((key) => {
    const record = snapshot.messages[key];
    return record === undefined ? [] : [{ key: record.key, message: record.message }];
  });
}

/** The open chat for the export: its messages now, and its older pages through the history controller. */
function chatHistoryOf(session: Session): ChatHistory<KeyedTranscriptMessage> {
  return {
    messages: () => orderedMessages(session.store.getSnapshot()),
    loadedEntries: () => session.store.getSnapshot().transcript.order.length,
    hasOlder: () => session.store.getSnapshot().transcript.hasOlder,
    loadOlder: () => session.history.loadOlder(),
  };
}

/** The window size the spec sets with `?window=`, in bytes. Without it, the app's own window applies. */
function windowBytesFromUrl(): number | undefined {
  const value = new URLSearchParams(window.location.search).get("window");
  if (value === null) return undefined;
  const bytes = Number(value);
  return Number.isInteger(bytes) && bytes >= 1024 ? bytes : undefined;
}

/**
 * The app's history loader with a smaller window. A short chat then splits into several windows, and the export
 * has to load the older ones before it can answer.
 */
function smallWindowLoader(
  client: AppClient,
  threadId: ThreadId,
  session: RpcSessionClient,
  store: OmpRuntimeStore,
  byteBudget: number,
): SessionHistoryLoader {
  const files = client.port(SessionFileStore);
  return new SessionHistoryLoader({
    threadId,
    send: session.send,
    store,
    readWindow: (args, options) => files.readEntryWindow({ ...args, byteBudget }, options),
    readOutput: (args, options) => files.readEntryOutput(args, options),
  });
}

function Loaded({ session }: { readonly session: Session }) {
  const overlay = useStableOverlayHost();
  const dialogs = useMemo(
    () =>
      new DialogHostController({
        overlay,
        answerDialog: async () => undefined,
        render: renderDialogRequest,
      }),
    [overlay],
  );
  const snapshot = useSyncExternalStore(
    (listener) => session.store.subscribe(listener),
    () => session.store.getSnapshot(),
  );
  const commands = useMemo(() => {
    const port = createExportPort({
      threadId: session.threadId,
      history: chatHistoryOf(session),
      session: session.rpc,
      gateway: session.gateway,
    });
    return createExportSlashCommands({
      threadId: session.threadId,
      port,
      dialogs,
      download: saveTextFile,
    });
  }, [session, dialogs]);
  const [busy, setBusy] = useState(false);
  const [outcomeText, setOutcomeText] = useState("Nothing run yet.");

  async function run(name: string, args?: string) {
    const command = commands.find((entry) => entry.name === name);
    if (command === undefined) throw new Error(`no /${name} command in the check page`);
    setBusy(true);
    try {
      const outcome = await command.run(args === undefined ? {} : { args });
      setOutcomeText(outcome.message ?? "Done.");
    } catch (error) {
      setOutcomeText(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const messageCount = orderedMessages(snapshot).length;
  return (
    <section className="flex flex-col gap-3">
      <p className="text-muted-foreground" role="status" data-testid="d4-3-readiness">
        Ready: {messageCount} messages in this chat.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy}
          onClick={() => void run("export")}
          data-testid="d4-3-export"
        >
          Export this chat
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run("dump")}
          data-testid="d4-3-dump"
        >
          Dump this chat
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run("dump", "all")}
          data-testid="d4-3-dump-all"
        >
          Where omp archived this chat
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run("open")}
          data-testid="d4-3-open"
        >
          Open the last link
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run("record")}
          data-testid="d4-3-record"
        >
          Record the screen
        </Button>
      </div>
      <p role="status" data-testid="d4-3-outcome">
        {outcomeText}
      </p>
    </section>
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
          void next.history.close().catch((error: unknown) => setFailure(messageOf(error)));
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
        void opened.history.close().catch((error: unknown) => setFailure(messageOf(error)));
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
  return <Loaded session={session} />;
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

const root = document.getElementById("d4-3-export-root");
if (!root) throw new Error("The D4.3 check page root is missing.");
createRoot(root).render(
  <AppConnectionProvider>
    <AppConnectionGate>
      <OverlayHost>
        <main
          className="bg-background text-foreground font-sans flex min-h-dvh min-w-0 flex-col gap-4 p-4 text-sm"
          data-testid="d4-3-export-check"
        >
          <h1 className="text-base font-semibold">Export check</h1>
          <CheckApp />
        </main>
      </OverlayHost>
    </AppConnectionGate>
  </AppConnectionProvider>,
);

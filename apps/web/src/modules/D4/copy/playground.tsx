/**
 * D4.2's real-omp check page. It runs the app's own composition (the connection, the overlay host, U4's
 * DialogHost and the chat's store) around the copy picker, against the real app server. The e2e spec builds
 * it into `dist/` and opens it on that server with the same launch token. It attaches to the folder's newest
 * chat and reads its messages through U1.7. Its seed button sends a bash-mode command through the chat's
 * runtime, the same `bash` path the composer's Bash mode will use; the composer does not route `!` yet.
 * `?clipboard=denied` makes the page's clipboard refuse every write, so the recovery path can be checked.
 */
import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type ChatSessionClient,
  ChatSessionPort,
  type FolderPath,
  type SessionFile,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { saveTextFile } from "@/app/save-file";
import { Button } from "@/components/ui/button";
import {
  AppConnectionGate,
  AppConnectionProvider,
  useAppConnection,
} from "@/launch/app-connection";
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
import type { ClipboardPort } from "../contract";
import {
  type CopyPicker,
  createCopyPicker,
  createCopySourceReader,
  createTranscriptActions,
  describeCopyOutcome,
} from "./index";

interface Session {
  readonly store: OmpRuntimeStore;
  /** Keeps the store live as omp streams, so a copy after new output uses the newest text. */
  readonly controller: OmpRuntimeController;
  readonly history: SelectedThreadHistoryController;
  readonly threadId: ThreadId;
}

/** The command the seed button runs: short, fixed, and printed exactly once. */
const SEED_COMMAND = "echo copy-me";

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
  const [capabilities, serverInfo] = await Promise.all([app.capabilities({}), app.serverInfo({})]);
  const threadId = await newestThreadId(client, serverInfo.launchFolder);
  const history = createSelectedThreadHistoryController({
    client,
    folder: serverInfo.launchFolder,
  });
  const store = await history.openExisting(threadId);
  const chat = client.port(ChatSessionPort) as ChatSessionClient;
  const controller = new OmpRuntimeController({ capabilities, send: chat.request, store });
  return { store, controller, history, threadId };
}

/** The chat's messages in transcript order, with the keys the app gave them. */
function orderedMessages(snapshot: RuntimeSnapshot): readonly KeyedTranscriptMessage[] {
  return snapshot.messageOrder.flatMap((key) => {
    const record = snapshot.messages[key];
    return record === undefined ? [] : [{ key: record.key, message: record.message }];
  });
}

/** The page's clipboard. A denied page refuses every write, as a browser that blocked clipboard access would. */
function clipboardFor(denied: boolean): ClipboardPort {
  return {
    async writeText(text) {
      if (denied) {
        throw new DOMException("Clipboard writes are blocked for this check.", "NotAllowedError");
      }
      await navigator.clipboard.writeText(text);
    },
  };
}

function Loaded({
  session,
  clipboard,
}: {
  readonly session: Session;
  readonly clipboard: ClipboardPort;
}) {
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
  const picker = useMemo(() => {
    const readSource = createCopySourceReader();
    const actions = createTranscriptActions({
      threadId: session.threadId,
      messages: () => readSource(orderedMessages(session.store.getSnapshot())),
      clipboard,
    });
    return createCopyPicker({
      threadId: session.threadId,
      dialogs,
      actions,
      download: saveTextFile,
    });
  }, [session, clipboard, dialogs]);
  const messages = orderedMessages(snapshot);
  return (
    <CopyCheck
      picker={picker}
      messageCount={messages.length}
      onSeed={() =>
        session.controller.submitPrompt({ mode: "bash", text: SEED_COMMAND, delivery: "new" })
      }
    />
  );
}

function CopyCheck({
  picker,
  messageCount,
  onSeed,
}: {
  readonly picker: CopyPicker;
  readonly messageCount: number;
  readonly onSeed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [outcomeText, setOutcomeText] = useState("Nothing copied yet.");
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The picker's dialogs return focus when they close, but a clipboard recovery is a second dialog and
  // focus can end on the page. The trigger takes focus from an effect, after the close has committed:
  // while a dialog is open the page behind it is inert, and focus() on an inert element does nothing.
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (settled > 0) buttonRef.current?.focus();
  }, [settled]);

  async function run() {
    const outcome = await picker.run();
    setOutcomeText(describeCopyOutcome(outcome));
    setSettled((count) => count + 1);
  }

  async function seed() {
    setBusy(true);
    try {
      await onSeed();
      setOutcomeText(`Ran "${SEED_COMMAND}" in bash.`);
    } catch (error) {
      setOutcomeText(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-muted-foreground" role="status" data-testid="d4-2-readiness">
        Ready: {messageCount} messages in this chat.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={buttonRef}
          type="button"
          onClick={() => void run()}
          data-testid="d4-2-open-picker"
        >
          Copy from this chat
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void seed()}
          data-testid="d4-2-seed-bash"
        >
          Run a bash command
        </Button>
      </div>
      <p role="status" data-testid="d4-2-outcome">
        {outcomeText}
      </p>
    </section>
  );
}

function Check({ client }: { readonly client: AppClient }) {
  const [session, setSession] = useState<Session | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const denied = new URLSearchParams(window.location.search).get("clipboard") === "denied";
  const clipboard = useMemo(() => clipboardFor(denied), [denied]);

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
  return <Loaded session={session} clipboard={clipboard} />;
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

const root = document.getElementById("d4-2-copy-root");
if (!root) throw new Error("The D4.2 check page root is missing.");
createRoot(root).render(
  <AppConnectionProvider>
    <AppConnectionGate>
      <OverlayHost>
        <main
          className="bg-background text-foreground font-sans flex min-h-dvh min-w-0 flex-col gap-4 p-4 text-sm"
          data-testid="d4-2-copy-check"
        >
          <h1 className="text-base font-semibold">Copy picker check</h1>
          <CheckApp />
        </main>
      </OverlayHost>
    </AppConnectionGate>
  </AppConnectionProvider>,
);

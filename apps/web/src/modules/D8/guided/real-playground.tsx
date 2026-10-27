import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  AppPort,
  type ChatSessionClient,
  type ChatSessionEvent,
  ChatSessionPort,
  FolderPath,
  type ThreadId,
} from "@omp-app/contracts";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createChatSessionAppClient } from "../../../launch/chat-session-shim";
import { readLaunchToken, websocketUrl } from "../../../launch/token";
import { OverlayHost, useStableOverlayHost } from "../../../overlay";
import { OmpRuntimeStore } from "../../R0/store";
import { renderDialogRequest } from "../../U4/dialogs";
import { DialogHostController } from "../../U4/host";
import { createAutonomyPort } from "../goal/runtime";
import { GuidedGoalController } from "./controller";
import { goalSourceOf } from "./goal-source";
import { useGuidedGoal } from "./hook";
import { GuidedGoalView } from "./view";

interface ActiveSession {
  readonly chat: ChatSessionClient;
  readonly threadId: ThreadId;
}

declare global {
  interface Window {
    mountRealGuidedGoal?: (folder: string) => void;
    unmountRealGuidedGoal?: () => void;
    readRealGoal?: () => Promise<{
      readonly objective: string;
      readonly tokenBudget?: number;
    } | null>;
  }
}

let activeSession: ActiveSession | null = null;
let realRoot: Root | null = null;
let mountNode: HTMLDivElement | null = null;

function waitForClient(client: AppClient): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  const timer = window.setTimeout(() => {
    unsubscribe();
    reject(new Error("Timed out connecting to the app."));
  }, 10_000);
  const finish = () => {
    window.clearTimeout(timer);
    unsubscribe();
    resolve();
  };
  unsubscribe = client.onConnectionState((event) => {
    if (event.state === "open") finish();
    else if (event.state === "closed") {
      window.clearTimeout(timer);
      unsubscribe();
      reject(new Error("The app connection closed."));
    }
  });
  if (client.connectionState === "open") finish();
  return promise;
}

function RealGuidedSurface({ controller }: { readonly controller: GuidedGoalController }) {
  const view = useGuidedGoal(controller);
  return (
    <main className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground">
      <div className="w-full max-w-xl">
        <GuidedGoalView onRetry={view.retry} onStart={view.start} snapshot={view.snapshot} />
      </div>
    </main>
  );
}

function RealGuidedGoal({ folder }: { readonly folder: string }) {
  const overlay = useStableOverlayHost();
  const [controller, setController] = useState<GuidedGoalController | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const messageRef = useRef("");

  useEffect(() => {
    let active = true;
    let client: AppClient | undefined;
    let subscription: AppClientSubscription<ChatSessionEvent> | undefined;
    let dialogHost: DialogHostController | undefined;
    let guided: GuidedGoalController | undefined;

    const connect = async () => {
      const token = readLaunchToken().token;
      if (!token) throw new Error("The signed-in session is unavailable.");
      client = createChatSessionAppClient({ url: websocketUrl(window.location), token });
      await waitForClient(client);
      if (!active) return;

      const chat = client.port(ChatSessionPort) as ChatSessionClient;
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      if (!active) return;
      const threadId = opened.threadId;
      activeSession = { chat, threadId };
      const runtime = new OmpRuntimeStore({ threadId });
      subscription = await client.subscribe(ChatSessionPort, "event", { scope: threadId });
      subscription.onEvent((event, sequence) => runtime.ingest(event, sequence));
      const state = await chat.request({ threadId, method: "get_state", params: {} });
      runtime.applyHostState(state);
      const capabilities = await client.port(AppPort).capabilities({});
      if (!active) return;

      dialogHost = new DialogHostController({
        overlay,
        capabilities,
        answerDialog: async (id, answer, options) => {
          await chat.answer({ threadId, id, answer }, options);
        },
        render: renderDialogRequest,
      });
      guided = new GuidedGoalController({
        threadId,
        autonomy: createAutonomyPort({
          request: chat.request,
          store: runtime,
        }),
        dialogs: dialogHost,
        capabilities: () => capabilities,
        goal: goalSourceOf(runtime),
        restoreFocus: () =>
          requestAnimationFrame(() =>
            document.querySelector<HTMLButtonElement>("[data-testid=guided-start]")?.focus(),
          ),
        composer: {
          read: () => messageRef.current,
          write: async (text) => {
            messageRef.current = text;
            setMessage(text);
          },
        },
      });
      if (active) setController(guided);
    };

    void connect().catch(() => {
      if (active) setFailed(true);
    });

    return () => {
      active = false;
      guided?.dispose();
      dialogHost?.dispose();
      if (subscription) void subscription.unsubscribe();
      client?.dispose();
    };
  }, [folder, overlay]);

  if (failed) {
    return <p role="alert">A real goal session could not be opened.</p>;
  }
  if (!controller) {
    return <p role="status">Opening a real conversation.</p>;
  }
  return (
    <>
      <RealGuidedSurface controller={controller} />
      <label className="m-4 flex max-w-xl flex-col gap-2 text-sm">
        Message box
        <textarea
          aria-label="Message box"
          className="min-h-24 rounded-md border bg-background p-2"
          onChange={(event) => {
            messageRef.current = event.target.value;
            setMessage(event.target.value);
          }}
          value={message}
        />
      </label>
    </>
  );
}

window.mountRealGuidedGoal = (folder) => {
  window.unmountRealGuidedGoal?.();
  mountNode = document.createElement("div");
  document.body.append(mountNode);
  realRoot = createRoot(mountNode);
  realRoot.render(
    <StrictMode>
      <OverlayHost>
        <RealGuidedGoal folder={folder} />
      </OverlayHost>
    </StrictMode>,
  );
};

window.unmountRealGuidedGoal = () => {
  realRoot?.unmount();
  realRoot = null;
  mountNode?.remove();
  mountNode = null;
  activeSession = null;
};

/** Reads the goal back from omp itself (`goal get`), so the spec checks what omp stored. */
window.readRealGoal = async () => {
  if (!activeSession) throw new Error("No real conversation is open.");
  const result = await activeSession.chat.request({
    threadId: activeSession.threadId,
    method: "goal",
    params: { op: "get" },
  });
  if (result.goal === null) return null;
  return {
    objective: result.goal.objective,
    ...(result.goal.tokenBudget === undefined ? {} : { tokenBudget: result.goal.tokenBudget }),
  };
};

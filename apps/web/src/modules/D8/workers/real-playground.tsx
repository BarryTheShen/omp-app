import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  FolderPath,
  type RpcSessionClient,
  type RpcSessionEvent,
  RpcSessionPort,
} from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createChatSessionAppClient } from "../../../launch/chat-session-shim";
import { readLaunchToken, websocketUrl } from "../../../launch/token";
import { OverlayHost } from "../../../overlay";
import { createSubagentClient, type SubagentClient } from "../../P1/client";
import { AgentRosterStore } from "../../P1/roster";
import { OmpRuntimeStore } from "../../R0/store";
import { createWorkersController, type WorkersController } from "./controller";
import { useWorkersPanel } from "./hook";
import { WorkersPanelView } from "./view";

declare global {
  interface Window {
    mountRealWorkersPanel?: (folder: string) => Promise<void>;
    unmountRealWorkersPanel?: () => void;
    sendRealWorkersPrompt?: (message: string) => Promise<void>;
  }
}

function waitForClient(client: AppClient): Promise<void> {
  if (client.connectionState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
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
  });
}

function WorkersPanelReady({ controller }: { readonly controller: WorkersController }) {
  const snapshot = useWorkersPanel(controller);
  const [open, setOpen] = useState(true);
  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="real-workers-panel">
      <WorkersPanelView
        open={open}
        position="right"
        snapshot={snapshot}
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
        onRetry={() => controller.retry()}
        onStop={(id) => void controller.stop(id)}
      />
    </main>
  );
}

function RealWorkersPanel({ folder }: { readonly folder: string }) {
  const [controller, setController] = useState<WorkersController | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let client: AppClient | undefined;
    let subscription: AppClientSubscription<RpcSessionEvent> | undefined;
    let subagents: SubagentClient | undefined;
    let roster: AgentRosterStore | undefined;
    let workers: WorkersController | undefined;

    const connect = async () => {
      const token = readLaunchToken().token;
      if (!token) throw new Error("The signed-in session is unavailable.");
      client = createChatSessionAppClient({ url: websocketUrl(window.location), token });
      await waitForClient(client);
      if (!active) return;

      const rpc = client.port(RpcSessionPort) as RpcSessionClient;
      const opened = await rpc.open({ folderPath: FolderPath.parse(folder), start: "new" });
      if (!active) return;
      const threadId = opened.threadId;
      const runtime = new OmpRuntimeStore({ threadId });
      subscription = await client.subscribe(RpcSessionPort, "event", { scope: threadId });
      subscription.onEvent((event, sequence) => runtime.ingest(event, sequence));
      const session = await rpc.send({ threadId, command: { type: "get_state" } });
      runtime.applySessionState(session);
      if (!active) return;

      window.sendRealWorkersPrompt = async (message) => {
        await rpc.send({ threadId, command: { type: "prompt", message } });
      };
      subagents = createSubagentClient({
        threadId,
        session: rpc,
        runtime,
        capabilities: opened.capabilities,
      });
      const store = new AgentRosterStore({ threadId, client: subagents });
      roster = store;
      workers = createWorkersController({
        roster: store,
        start: () => store.start(),
        client: subagents,
        capabilities: () => opened.capabilities,
        debugLog: (cause) => console.error("[omp-app] workers panel:", cause),
      });
      if (active) setController(workers);
    };

    void connect().catch(() => {
      if (active) setFailed(true);
    });

    return () => {
      active = false;
      workers?.dispose();
      if (roster) void roster.dispose();
      if (subagents) void subagents.dispose();
      if (subscription) void subscription.unsubscribe();
      client?.dispose();
    };
  }, [folder]);

  if (failed) {
    return <p role="alert">A real workers session could not be opened.</p>;
  }
  if (!controller) {
    return <p role="status">Opening a real conversation.</p>;
  }
  return <WorkersPanelReady controller={controller} />;
}

let realRoot: Root | null = null;
let mountNode: HTMLDivElement | null = null;

const realWindow = window;
realWindow.mountRealWorkersPanel = async (folder) => {
  if (realRoot) throw new Error("A real workers panel is already mounted.");
  mountNode = document.createElement("div");
  mountNode.dataset.realWorkersPanel = "true";
  document.body.append(mountNode);
  realRoot = createRoot(mountNode);
  realRoot.render(
    <StrictMode>
      <OverlayHost>
        <RealWorkersPanel folder={folder} />
      </OverlayHost>
    </StrictMode>,
  );
};
realWindow.unmountRealWorkersPanel = () => {
  realRoot?.unmount();
  realRoot = null;
  mountNode?.remove();
  mountNode = null;
};

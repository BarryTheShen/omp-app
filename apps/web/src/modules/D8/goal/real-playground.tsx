import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  FolderPath,
  type RpcSessionClient,
  type RpcSessionEvent,
  RpcSessionPort,
  UiRequestId,
} from "@omp-app/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createChatSessionAppClient } from "../../../launch/chat-session-shim";
import { readLaunchToken, websocketUrl } from "../../../launch/token";
import { OverlayHost, useStableOverlayHost } from "../../../overlay";
import { OmpRuntimeStore } from "../../R0/store";
import { type ConfigSnapshot, effectiveEntry } from "../../S1/settings-kit";
import {
  createTasksSettingsRuntime,
  type TaskSettingsSectionRuntime,
} from "../../S3/tasks/settings-runtime";
import { renderDialogRequest } from "../../U4/dialogs";
import { DialogHostController } from "../../U4/host";
import { GoalController } from "./controller";
import { useGoalPanel } from "./hook";
import { createAutonomyPort } from "./runtime";
import { GoalPanelView } from "./view";

declare global {
  interface Window {
    mountRealGoalPanel?: (folder: string) => Promise<void>;
    unmountRealGoalPanel?: () => void;
  }
}

/** omp's effective `goal.continuationModes`; `null` while the setting cannot be read. */
function continuationModesOf(config: ConfigSnapshot | null): readonly string[] | null {
  const entry = config === null ? undefined : effectiveEntry(config, "goal.continuationModes");
  if (entry === undefined || entry.secret) return null;
  const value = entry.value;
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : null;
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

function GoalPanelReady({ controller }: { readonly controller: GoalController }) {
  const view = useGoalPanel(controller);
  const [open, setOpen] = useState(true);
  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="real-goal-panel">
      <GoalPanelView
        open={open}
        position="right"
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
        {...view}
      />
    </main>
  );
}

function RealGoalPanel({ folder }: { readonly folder: string }) {
  const overlay = useStableOverlayHost();
  const [controller, setController] = useState<GoalController | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let client: AppClient | undefined;
    let subscription: AppClientSubscription<RpcSessionEvent> | undefined;
    let dialogHost: DialogHostController | undefined;
    let goalController: GoalController | undefined;
    let modes: TaskSettingsSectionRuntime | undefined;

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

      dialogHost = new DialogHostController({
        overlay,
        capabilities: opened.capabilities,
        answerExtensionUi: async (response, options) => {
          await rpc.answerExtensionUi(
            {
              threadId,
              response: { ...response, id: UiRequestId.parse(response.id) },
            },
            options,
          );
        },
        render: renderDialogRequest,
      });
      const settings = createTasksSettingsRuntime(client, {
        section: "modes",
        folder: FolderPath.parse(folder),
        layer: "global",
      });
      modes = settings;
      void settings.read().catch(() => undefined);
      goalController = new GoalController({
        threadId,
        autonomy: createAutonomyPort({
          rpc: (args, callOptions) => rpc.send(args, callOptions),
          store: runtime,
        }),
        runtime,
        dialogs: dialogHost,
        capabilities: () => opened.capabilities,
        continuationModes: {
          getSnapshot: () => continuationModesOf(settings.getSnapshot().config),
          subscribe: (listener) => settings.subscribe(() => listener()),
        },
      });
      if (active) setController(goalController);
    };

    void connect().catch(() => {
      if (active) setFailed(true);
    });

    return () => {
      active = false;
      goalController?.dispose();
      modes?.dispose();
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
  return <GoalPanelReady controller={controller} />;
}

let realRoot: Root | null = null;
let mountNode: HTMLDivElement | null = null;

const realWindow = window;
realWindow.mountRealGoalPanel = async (folder) => {
  if (realRoot) throw new Error("A real goal panel is already mounted.");
  mountNode = document.createElement("div");
  mountNode.dataset.realGoalPanel = "true";
  document.body.append(mountNode);
  realRoot = createRoot(mountNode);
  realRoot.render(
    <StrictMode>
      <OverlayHost>
        <RealGoalPanel folder={folder} />
      </OverlayHost>
    </StrictMode>,
  );
};
realWindow.unmountRealGoalPanel = () => {
  realRoot?.unmount();
  realRoot = null;
  mountNode?.remove();
  mountNode = null;
};

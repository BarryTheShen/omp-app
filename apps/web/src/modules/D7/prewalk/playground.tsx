import type { AppClient, ConnectionState, ConnectionStateEvent } from "@omp-app/client";
import {
  AppFailure,
  CapabilityStatus,
  type CommandRunArgs,
  type CommandRunResult,
  OmpCommandGateway,
  ThreadId,
} from "@omp-app/contracts";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost } from "@/overlay";
import type { ToolAvailability } from "../contract";
import { ToolAvailabilitySurface } from "../tools";
import { createD74CommandClient } from "./commands";
import { PrewalkSurface } from "./index";
import { useD74Command } from "./use-d74-command";

const root = document.getElementById("d7-4-playground-root");
if (!root) throw new Error("The D7.4 playground root is missing.");

const threadId = ThreadId.parse("d74-playground-thread");
const capabilities = {
  "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
};
const initialToolAvailability: readonly ToolAvailability[] = [
  { tool: "browser", state: "available", mode: "browser", capability: "host.command-gateway" },
  {
    tool: "computer",
    state: "fallback",
    mode: "computer",
    capability: "host.command-gateway",
    reason: "The app can only partly provide this tool.",
  },
  { tool: "vision", state: "unknown", mode: "vision" },
];

function fakeAppClient(): AppClient {
  let connectionState: ConnectionState = "open";
  let failNextTools = true;
  const gateway = {
    run: async ({ command }: CommandRunArgs): Promise<CommandRunResult> => {
      if (command === "/tools" && failNextTools) {
        failNextTools = false;
        throw new AppFailure({
          code: "internal",
          message: "The tools list could not be refreshed.",
          retryable: true,
        });
      }
      const outputText =
        command === "/tools"
          ? ["* bash", "- browser", "~ xd://time"].join("\n")
          : command.startsWith("/shake")
            ? "omp removed the selected content from its conversation context."
            : command === "/prewalk"
              ? "Prewalk on: switching models at the next edit or write."
              : command === "/prewalk restart"
                ? "Prewalk restarted and returned to the default model."
                : command === "/prewalk off"
                  ? "Prewalk off."
                  : command === "/skillful status"
                    ? "Skill listing is off."
                    : command === "/skillful toggle"
                      ? "Skill listing toggled."
                      : command === "/skillful on"
                        ? "Skill listing is on."
                        : "Skill listing is off.";
      return {
        command,
        status: "completed",
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        outputs: [{ text: outputText }],
        sessionUpdates: [],
        configUpdates: [],
      };
    },
  };
  return {
    get connectionState() {
      return connectionState;
    },
    instanceId: "d74-playground-instance",
    onConnectionState(listener: (event: ConnectionStateEvent) => void) {
      listener({ state: connectionState, attempt: 0 });
      return () => undefined;
    },
    onResync: () => () => undefined,
    port: (port: unknown) => {
      if (port !== OmpCommandGateway)
        throw new Error("The playground uses only the command gateway.");
      return gateway;
    },
    subscribe: async () => {
      throw new Error("The playground does not subscribe to server events.");
    },
    dispose: () => {
      connectionState = "closed";
    },
  } as unknown as AppClient;
}

function ConnectedPlayground() {
  const client = useMemo(() => fakeAppClient(), []);
  const commandClient = useMemo(() => createD74CommandClient(client), [client]);
  const controller = useD74Command({ client, commandClient, threadId, capabilities });
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <PrewalkSurface
          canRun={controller.canRun}
          onRetry={controller.actions.retry}
          onRun={controller.actions.run}
          surface={controller.surface}
        />
        <ToolAvailabilitySurface
          canRun={controller.canRun}
          onList={() => controller.actions.run("/tools")}
          onRetry={controller.actions.retry}
          onSkillful={controller.actions.run}
          surface={controller.surface}
          tools={initialToolAvailability}
        />
      </div>
    </main>
  );
}

function Playground() {
  return (
    <OverlayHost>
      <ConnectedPlayground />
    </OverlayHost>
  );
}

createRoot(root).render(<Playground />);

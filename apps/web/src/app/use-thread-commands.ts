import type { RpcSessionClient } from "@omp-app/contracts";
import {
  AppFailure,
  AppPort,
  type CapabilityMap,
  type DescriptorId,
  McpCommandsPort,
  type OmpCommandGateway,
  type PortClient,
  type RpcSessionPort,
  type RpcSessionSend,
  type ThreadId,
} from "@omp-app/contracts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { conversationBusy } from "@/app/rewind/rewind-tree";
import { useConversationTransitions } from "@/app/rewind/use-conversation-transitions";
import type { SlashAppCommand } from "@/modules/D2/slash/routing";
import { D3_LOGIN_COMMAND } from "@/modules/D3/descriptors";
import { SHARE_IMPORT_UNAVAILABLE_REASON } from "@/modules/D4/fork";
import { runShareCommand } from "@/modules/D4/share";
import type { ShareController } from "@/modules/D4/share/controller";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle/commands";
import type { OmpRuntime } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import { openDestructiveCommandConfirm } from "@/modules/U4/dialogs/confirm-destructive-command";
import type { OverlayHostApi } from "@/overlay";
import type { CommandPaletteHandler } from "@/palette";
import { U0_SHORTCUT_SHEET_COMMAND } from "@/palette/descriptor";
import { useShortcutRegistry } from "@/shortcuts";
import { setThemePreference } from "@/theme";
import type { AgentHubOpenResult } from "./agents/agent-hub-shortcut";
import type { ThreadAgents } from "./agents/thread-agents";
import { reportClientError } from "./client-errors";
import { useCommandReport } from "./command-report/command-report";
import { composerInput } from "./composer-input";
import { runCopyFromChat } from "./copy/use-copy-from-chat";
import { openProviderSignIn, requireProviderLogin } from "./provider-login-section";
import { saveTextFile } from "./save-file";
import {
  agentHubSlashCommand,
  askFirstSlashCommands,
  branchSlashCommand,
  clearSlashCommand,
  copySlashCommand,
  forkSlashCommand,
  freshSlashCommand,
  type HistoryPanel,
  hotkeysSlashCommand,
  loginSlashCommand,
  mcpReloadSlashCommand,
  newChatSlashCommand,
  restartQuestion,
  restartSlashCommand,
  settingsSlashCommand,
  shareSlashCommand,
  treeSlashCommand,
  useSlashCommands,
} from "./slash-commands";
import type { ActiveThreadProps } from "./thread-props";
import { useGoalCommands } from "./use-goal-command";

interface ThreadPaletteInput {
  readonly agents: ThreadAgents | null;
  readonly capabilities: CapabilityMap;
  readonly overlay: OverlayHostApi;
  readonly client: ActiveThreadProps["client"];
  readonly threadId: ThreadId;
  readonly rpc: PortClient<typeof RpcSessionPort>;
  readonly store: OmpRuntimeStore;
  readonly setCommandError: Dispatch<SetStateAction<string | null>>;
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: ActiveThreadProps["openThread"];
  readonly catalog: SessionCatalogModel | null;
  readonly remote: ActiveThreadProps["remote"];
  readonly openSessionBrowser: () => void;
  readonly onOpenSettings: ActiveThreadProps["onOpenSettings"];
  readonly setDiagnosticPanelOpen: Dispatch<SetStateAction<boolean>>;
  readonly setDiagnosticPanel: Dispatch<SetStateAction<"reports" | "security" | null>>;
  readonly setDiagnosticPanelReveal: Dispatch<SetStateAction<number>>;
}

export function useThreadPalette({
  agents,
  capabilities,
  overlay,
  client,
  threadId,
  rpc,
  store,
  setCommandError,
  setCommandStatus,
  lifecycle,
  openThread,
  catalog,
  remote,
  openSessionBrowser,
  onOpenSettings,
  setDiagnosticPanelOpen,
  setDiagnosticPanel,
  setDiagnosticPanelReveal,
}: ThreadPaletteInput) {
  // The Agent Hub, opened by a double-tap of ← in the empty composer (omp's gesture), by Alt+A and by `/hub`. The Agents
  // tab comes to the front and its sidebar opens if it is closed; only a session with an agent to show opens it.
  const [agentsReveal, setAgentsReveal] = useState(0);
  const openAgentHub = useCallback(async (): Promise<AgentHubOpenResult> => {
    if (agents === null) return "unavailable";
    try {
      await agents.start();
    } catch (error) {
      reportClientError({
        kind: "error",
        message: `The Agent Hub could not start: ${error instanceof Error ? error.message : "unknown error"}`,
      });
      return "unavailable";
    }
    if (agents.roster.getSnapshot().order.length === 0) return "empty";
    setAgentsReveal((count) => count + 1);
    return "opened";
  }, [agents]);
  const openLogin = useCallback(() => {
    requireProviderLogin(capabilities);
    openProviderSignIn({
      overlay,
      client,
      threadId,
      capabilities,
      restoreFocus: composerInput() ?? undefined,
    });
  }, [capabilities, client, overlay, threadId]);
  // omp's goal over RPC: the typed `/goal` and the palette's goal commands (use-goal-command.ts).
  const { command: goalCommand, runFromPalette: runGoalFromPalette } = useGoalCommands({
    capabilities,
    fail: setCommandError,
    notify: setCommandStatus,
    rpc: rpc as RpcSessionClient,
    store,
    threadId,
  });
  const commandHandlers = useMemo(() => {
    const handlers = new Map<DescriptorId, CommandPaletteHandler>();
    handlers.set("D5.new", () => {
      setCommandError(null);
      setCommandStatus("Starting a new chat…");
      if (!lifecycle) {
        setCommandStatus(null);
        setCommandError("Starting a new chat requires a selected workspace folder.");
        return;
      }
      void lifecycle
        .newSession()
        .then(async (outcome) => {
          if (outcome.status === "completed") {
            await openThread(outcome.value);
          } else if (outcome.status === "error" || outcome.status === "unavailable") {
            setCommandError(outcome.error.message);
          }
          setCommandStatus(null);
        })
        .catch(() => {
          setCommandStatus(null);
          setCommandError("The new chat could not be started. Try again.");
        });
    });
    handlers.set("D5.fresh", (signal) => {
      setCommandError(null);
      setCommandStatus(null);
      if (!lifecycle) {
        setCommandError("Refreshing the model connection is unavailable for this session.");
        return;
      }
      void lifecycle
        .fresh(signal)
        .then((outcome) => {
          if (outcome.status === "error" || outcome.status === "unavailable") {
            setCommandError(outcome.error.message);
          } else if (outcome.status === "completed") {
            // Say what omp said instead of claiming success: omp refuses while a reply is still
            // streaming ("Wait for the current response to finish…") and answers in its own words.
            const reply = outcome.value.outputs
              .map((output) => output.text.trim())
              .filter((text) => text !== "")
              .join(" ");
            setCommandStatus(reply === "" ? "omp had nothing to say about it." : `omp: ${reply}`);
          }
        })
        .catch(() => {
          setCommandError("The model connection could not be refreshed. Try again.");
        });
    });
    handlers.set("D5.clear", () => {
      setCommandError(null);
      setCommandStatus(null);
      if (!lifecycle) {
        setCommandError("Clearing the conversation only works in the omp terminal for now.");
        return;
      }
      void lifecycle
        .clear()
        .then((outcome) => {
          if (outcome.status === "error" || outcome.status === "unavailable") {
            setCommandError(outcome.error.message);
          }
        })
        .catch(() => setCommandError("Clearing the conversation is unavailable."));
    });
    handlers.set("U0.saveDebugLog", () => {
      setCommandError(null);
      setCommandStatus("Saving the debug log…");
      void client
        .port(AppPort)
        .debugReport({})
        .then((report) => {
          saveTextFile(report.fileName, report.text);
          setCommandStatus(
            `Saved ${report.fileName} to your downloads. Attach it to a bug report.`,
          );
        })
        .catch((error: unknown) => {
          setCommandStatus(null);
          setCommandError(
            error instanceof AppFailure
              ? error.appError.message
              : "The debug log could not be saved. Try again.",
          );
        });
    });
    if (catalog && remote) handlers.set("R1.openSession", openSessionBrowser);
    handlers.set(D3_LOGIN_COMMAND.id, () => openLogin());
    handlers.set("S1.settings", () => onOpenSettings(threadId, composerInput() ?? undefined));
    handlers.set("D6.reports", () => {
      setDiagnosticPanelOpen(false);
      setDiagnosticPanel("reports");
      setDiagnosticPanelReveal((reveal) => reveal + 1);
    });
    handlers.set("D6.security", () => {
      setDiagnosticPanelOpen(false);
      setDiagnosticPanel("security");
      setDiagnosticPanelReveal((reveal) => reveal + 1);
    });
    handlers.set("U0.themeSystem", () => setThemePreference("system"));
    handlers.set("U0.themeLight", () => setThemePreference("light"));
    handlers.set("U0.themeDark", () => setThemePreference("dark"));
    // The palette's goal commands send the same operations as the typed `/goal` and report in the same header line.
    handlers.set("U0.goalShow", () => runGoalFromPalette(""));
    handlers.set("U0.goalPause", () => runGoalFromPalette("pause"));
    handlers.set("U0.goalResume", () => runGoalFromPalette("resume"));
    handlers.set("U0.goalDrop", () => runGoalFromPalette("drop"));
    return handlers;
  }, [
    catalog,
    client,
    lifecycle,
    onOpenSettings,
    openLogin,
    openSessionBrowser,
    openThread,
    remote,
    runGoalFromPalette,
    threadId,
    setCommandStatus,
    setDiagnosticPanelReveal,
    setDiagnosticPanelOpen,
    setDiagnosticPanel,
    setCommandError,
  ]);
  const clearReason =
    lifecycle?.getAvailability("clear").reason ??
    "Clearing the conversation only works in the omp terminal for now.";
  const commandUnavailableReasons = useMemo(
    () =>
      new Map<DescriptorId, string>([
        ["D5.clear", clearReason],
        ["D4.importShare", SHARE_IMPORT_UNAVAILABLE_REASON],
      ]),
    [clearReason],
  );
  return {
    agentsReveal,
    openAgentHub,
    openLogin,
    goalCommand,
    commandHandlers,
    commandUnavailableReasons,
  };
}

interface ThreadSlashCommandsInput {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly capabilities: CapabilityMap;
  readonly client: ActiveThreadProps["client"];
  readonly guardedSend: RpcSessionSend;
  readonly runtimeController: OmpRuntime["controller"];
  readonly switchChat: ActiveThreadProps["switchChat"];
  readonly pickCount: ActiveThreadProps["pickCount"];
  readonly deliverNote: ActiveThreadProps["deliverNote"];
  readonly closeDiagnosticPanel: () => void;
  readonly diagnosticPanel: "reports" | "security" | null;
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: ActiveThreadProps["openThread"];
  readonly shareController: ShareController;
  readonly exportCommands: readonly SlashAppCommand[];
  readonly goalCommand: SlashAppCommand;
  readonly catalog: SessionCatalogModel | null;
  readonly title: string;
  readonly overlay: OverlayHostApi;
  readonly commandGateway: PortClient<typeof OmpCommandGateway>;
  readonly onOpenSettings: ActiveThreadProps["onOpenSettings"];
  readonly openAgentHub: () => Promise<AgentHubOpenResult>;
  readonly openLogin: () => void;
  readonly restartOmp: () => Promise<void>;
}

export function useThreadSlashCommands({
  threadId,
  store,
  capabilities,
  client,
  guardedSend,
  runtimeController,
  switchChat,
  pickCount,
  deliverNote,
  closeDiagnosticPanel,
  diagnosticPanel,
  lifecycle,
  openThread,
  shareController,
  exportCommands,
  goalCommand,
  catalog,
  title,
  overlay,
  commandGateway,
  onOpenSettings,
  openAgentHub,
  openLogin,
  restartOmp,
}: ThreadSlashCommandsInput) {
  const shortcutRegistry = useShortcutRegistry();
  // The output of the last command that printed several lines, in the chat it ran in, until the person closes it.
  const {
    reveal: commandOutputReveal,
    show: showCommandOutput,
    surface: commandOutputSurface,
  } = useCommandReport({ threadId });
  const previousCommandOutputReveal = useRef(commandOutputReveal);
  useEffect(() => {
    if (previousCommandOutputReveal.current === commandOutputReveal) return;
    previousCommandOutputReveal.current = commandOutputReveal;
    if (diagnosticPanel !== null) closeDiagnosticPanel();
  }, [closeDiagnosticPanel, commandOutputReveal, diagnosticPanel]);
  // The composer's running flag (thread.isRunning, a tool step included): ThreadRunningFlag keeps it current.
  const threadRunning = useRef(false);
  // The transition port the rewind panel and `/fork` share: it rewinds, forks and branches the chat on screen.
  const transitions = useConversationTransitions({
    store,
    send: guardedSend,
    capabilities,
    submitPrompt: runtimeController.submitPrompt,
    switchThread: switchChat,
    pickCount,
    deliverNote,
    threadRunning,
  });
  // The conversation-history panel `/tree` and `/branch` open: the registry's own command, offered while omp has it.
  const historyPanel = useMemo<HistoryPanel>(
    () => ({
      available: () => shortcutRegistry.commandFor("P4.treeCommand") !== undefined,
      open: () => void shortcutRegistry.commandFor("P4.treeCommand")?.run(),
    }),
    [shortcutRegistry],
  );
  // Slash commands for this chat: omp's list (with MCP prompts) and the app's own `/new` and `/fresh`.
  const appSlashCommands = useMemo(
    () => [
      newChatSlashCommand({ lifecycle, openThread }),
      clearSlashCommand({
        lifecycle,
        openThread,
        isBusy: () => conversationBusy(store, threadRunning.current),
        deliverNote,
        focusComposer: () => composerInput()?.focus({ preventScroll: true }),
      }),
      freshSlashCommand({ lifecycle }),
      shareSlashCommand({ run: () => runShareCommand(shareController) }),
      copySlashCommand({ copy: () => runCopyFromChat(shortcutRegistry) }),
      treeSlashCommand({ panel: historyPanel }),
      branchSlashCommand({
        panel: historyPanel,
        isBusy: () => conversationBusy(store, threadRunning.current),
      }),
      forkSlashCommand({
        transitions,
        threadId,
        isBusy: () => conversationBusy(store, threadRunning.current),
        deliverNote,
        focusComposer: () => composerInput()?.focus({ preventScroll: true }),
      }),
      ...exportCommands,
      loginSlashCommand({ openLogin }),
      settingsSlashCommand({
        openSettings: () => onOpenSettings(threadId, composerInput() ?? undefined),
      }),
      hotkeysSlashCommand({
        openShortcuts: () => {
          void shortcutRegistry.commandFor(U0_SHORTCUT_SHEET_COMMAND.id)?.run();
        },
      }),
      ...askFirstSlashCommands({
        catalog,
        threadId,
        fallbackTitle: title,
        overlay,
        gateway: commandGateway,
        lifecycle,
        openThread,
        showReport: showCommandOutput,
      }),
      mcpReloadSlashCommand({ commands: client.port(McpCommandsPort), threadId }),
      agentHubSlashCommand({ openAgentHub }),
      goalCommand,
      restartSlashCommand({
        confirm: (running) => openDestructiveCommandConfirm(overlay, restartQuestion(running)),
        restart: restartOmp,
        isBusy: () => conversationBusy(store, threadRunning.current),
      }),
    ],
    [
      catalog,
      client,
      commandGateway,
      deliverNote,
      exportCommands,
      goalCommand,
      historyPanel,
      lifecycle,
      onOpenSettings,
      openAgentHub,
      openLogin,
      openThread,
      overlay,
      restartOmp,
      shareController,
      shortcutRegistry,
      showCommandOutput,
      store,
      threadId,
      title,
      transitions,
    ],
  );
  const slashProvider = useSlashCommands({
    client,
    threadId,
    capabilities,
    appCommands: appSlashCommands,
  });
  // The chat's command gateway for a background job's Stop control: omp's own words come back for the card that asked.
  const runBackgroundJobCommand = useMemo(
    () =>
      slashProvider === null
        ? undefined
        : async (command: string) =>
            (await slashProvider.execute(command)).outputs.map((output) => output.text),
    [slashProvider],
  );
  // The stops omp confirmed for this chat's background jobs, kept by the server. A card reads them when the chat opens,
  // so a stop made in one browser shows as stopped in every other browser that opens the chat.
  const loadBackgroundJobStops = useCallback(
    (threadId: ThreadId) =>
      commandGateway.backgroundJobStops({ threadId }).then((read) => read.stops),
    [commandGateway],
  );
  return {
    commandOutputReveal,
    commandOutputSurface,
    showCommandOutput,
    threadRunning,
    transitions,
    appSlashCommands,
    slashProvider,
    runBackgroundJobCommand,
    loadBackgroundJobStops,
  };
}

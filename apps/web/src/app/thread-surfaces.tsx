import type {
  CapabilityMap,
  ChatSessionRequest,
  ProviderErrorResult,
  ThreadId,
} from "@omp-app/contracts";
import type { Dispatch, SetStateAction } from "react";
import { agentsSurface } from "@/app/agents/agents-tab";
import { useRewindPanel } from "@/app/rewind/use-rewind-panel";
import { Notice } from "@/components/blocks";
import type { Surface, SurfaceMap } from "@/layout";
import type { DiagnosticCommandPort } from "@/modules/D6/contract/contract";
import { ReportsPanel } from "@/modules/D6/reports";
import { SecurityReportPanel } from "@/modules/D6/security";
import { RulesPanel } from "@/modules/I3/rules";
import type { RulesController } from "@/modules/I3/rules/controller";
import { useLiveVoiceSurfaces } from "@/modules/I5/live";
import { NotificationFeedback, NotificationNotices } from "@/modules/N1/feedback";
import type { NotificationProjector } from "@/modules/N1/notifications/projection";
import { StatusSegments } from "@/modules/N1/status";
import type { P3EditTarget, P3Runs } from "@/modules/P3/runs";
import { P3EditSurface, P3RunStatusSurface } from "@/modules/P3/runs";
import type { P3RunHandlers } from "@/modules/P3/runs/handlers";
import type { ConversationTransitionPort } from "@/modules/P4/transitions/transitions";
import { QueueLaneBar } from "@/modules/P6/bar/bar";
import type { QueueAdapterController } from "@/modules/P6/contract/contract";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { ToolCallsControl } from "@/modules/U1/policy/tool-calls-control";
import { ToolsHiddenNotice } from "@/modules/U1/policy/tools-hidden-notice";
import { ScrollFollowControls } from "@/modules/U1/scroll";
import type { ThreadScrollController } from "@/modules/U1/scroll/thread-scroll-controller";
import type { AttachmentManager } from "@/modules/U2/attachments";
import { AttachmentChips } from "@/modules/U2/attachments";
import { ModeIndicator } from "@/modules/U2/modes";
import type { PanelFocusToken } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import { TodoChecklist } from "@/modules/U5/todo/checklist/checklist";
import type { TodoModel } from "@/modules/U5/todo/model";
import type { ShortcutPreferenceError } from "@/shortcuts";
import { ShortcutPreferenceNotice } from "@/shortcuts";
import type { ThreadAgents } from "./agents/thread-agents";
import { reportClientError } from "./client-errors";
import { SessionContextPanel } from "./context-panel";
import { useExecutionModesSurface } from "./execution-modes";
import { SessionModelControl, SessionStatusBar } from "./session-controls";
import { SettingsButton } from "./thread-chrome";
import type { ActiveThreadProps } from "./thread-props";

/** The status bar's unexpected read failures go to the debug log; the bar itself shows nothing for them. */
function reportStatusFailure(error: unknown): void {
  reportClientError({
    kind: "error",
    message: `The status bar could not read the workspace: ${error instanceof Error ? error.message : "unknown error"}`,
  });
}

interface ThreadSurfacesInput {
  readonly title: string;
  readonly shortcutPreferenceError: ShortcutPreferenceError | undefined;
  readonly commandStatus: string | null;
  readonly commandError: string | null;
  readonly capabilities: CapabilityMap;
  readonly client: ActiveThreadProps["client"];
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly folder: ActiveThreadProps["folder"];
  readonly onOpenSettings: ActiveThreadProps["onOpenSettings"];
  readonly todoModel: TodoModel;
  readonly rulesController: RulesController;
  readonly agents: ThreadAgents | null;
  readonly agentsReveal: number;
  readonly resolveProviderError: (text: string) => Promise<ProviderErrorResult>;
  readonly guardedSend: ChatSessionRequest;
  readonly transitions: ConversationTransitionPort;
  readonly diagnosticPanel: "reports" | "security" | null;
  readonly diagnosticPanelOpen: boolean;
  readonly diagnosticPanelReveal: number;
  readonly diagnosticFocusToken: PanelFocusToken;
  readonly restoreDiagnosticPanelFocus: (token: PanelFocusToken) => void;
  readonly diagnosticPort: DiagnosticCommandPort;
  readonly closeDiagnosticPanel: () => void;
  readonly commandOutputSurface: Surface;
  readonly retireFastRefusalNotice: () => void;
  readonly queueOpen: boolean;
  readonly editing: P3EditTarget | null;
  readonly setEditing: Dispatch<SetStateAction<P3EditTarget | null>>;
  readonly queueConnection: {
    readonly state: "connected" | "reconnecting" | "connecting" | "closed";
    readonly reason: string | undefined;
  };
  readonly queueAdapter: QueueAdapterController;
  readonly attachmentManager: AttachmentManager;
  readonly notificationProjector: NotificationProjector;
  readonly p3Runs: P3Runs;
  readonly p3Handlers: P3RunHandlers;
  readonly openThread: ActiveThreadProps["openThread"];
  readonly scrollController: ThreadScrollController;
  readonly connectionSurface: Surface;
  readonly watchSurface: Surface;
  readonly onRefreshAfterCommand: ActiveThreadProps["onRefreshAfterCommand"];
}

export function useThreadSurfaces({
  title,
  shortcutPreferenceError,
  commandStatus,
  commandError,
  capabilities,
  client,
  store,
  threadId,
  folder,
  onOpenSettings,
  todoModel,
  rulesController,
  agents,
  agentsReveal,
  resolveProviderError,
  guardedSend,
  transitions,
  diagnosticPanel,
  diagnosticPanelOpen,
  diagnosticPanelReveal,
  diagnosticFocusToken,
  restoreDiagnosticPanelFocus,
  diagnosticPort,
  closeDiagnosticPanel,
  commandOutputSurface,
  retireFastRefusalNotice,
  queueOpen,
  editing,
  setEditing,
  queueConnection,
  queueAdapter,
  attachmentManager,
  notificationProjector,
  p3Runs,
  p3Handlers,
  openThread,
  scrollController,
  connectionSurface,
  watchSurface,
  onRefreshAfterCommand,
}: ThreadSurfacesInput) {
  // What each surface id renders for an open conversation. Where it goes: `@/layout` (LAYOUT).
  const threadSurfaces: SurfaceMap = {
    title: {
      title: "Conversation",
      grow: true,
      render: () => (
        <div className="relative min-w-0 flex-1">
          <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
          {/* Messages about the shortcuts and about a command float over the top of the chat, so the header keeps its height. */}
          {(shortcutPreferenceError !== undefined ||
            commandStatus !== null ||
            commandError !== null) && (
            <div className="absolute start-0 top-full z-10 flex w-max max-w-[min(26rem,calc(100vw-4.5rem))] flex-col gap-1 pt-1">
              <ShortcutPreferenceNotice />
              {commandStatus ? <Notice message={commandStatus} /> : null}
              {commandError ? <Notice message={commandError} tone="danger" /> : null}
            </div>
          )}
        </div>
      ),
    },
    model: {
      title: "Model",
      render: () => (
        <SessionModelControl
          capabilities={capabilities}
          client={client}
          store={store}
          threadId={threadId}
          folder={folder}
        />
      ),
    },
    settings: {
      title: "Settings",
      render: () => (
        <SettingsButton
          onOpenSettings={(requestThreadId) => onOpenSettings(requestThreadId, undefined)}
          threadId={threadId}
        />
      ),
    },
    todo: {
      title: "Todo checklist",
      grow: true,
      render: () => (
        <PanelShell
          body={todoModel.phases.length === 0 ? null : <TodoChecklist model={todoModel} />}
          state={{
            open: true,
            lifecycle: todoModel.phases.length === 0 ? "empty" : "populated",
            position: "right",
            title: "Todo checklist",
            error: todoModel.error,
            readOnly: true,
            pendingUpdates: 0,
          }}
        />
      ),
    },
    contextCard: {
      title: "Context",
      requires: ["omp.cmd.get_state", "omp.cmd.compact", "omp.cmd.set_auto_compaction"],
      render: () => (
        <SessionContextPanel
          client={client}
          onCompacted={onRefreshAfterCommand}
          store={store}
          threadId={threadId}
        />
      ),
    },
    agents: agentsSurface({ agents, reveal: agentsReveal, resolveProviderError }),
    rules: {
      title: "Rules",
      grow: true,
      render: () => <RulesPanel controller={rulesController} closable={false} />,
    },
    rewind: useRewindPanel({
      threadId,
      store,
      send: guardedSend,
      capabilities,
      transitions,
    }),
    commandOutput:
      diagnosticPanel === null
        ? commandOutputSurface
        : {
            title: diagnosticPanel === "reports" ? "Reports" : "Security",
            open: true,
            reveal: diagnosticPanelReveal,
            render: () =>
              diagnosticPanel === "reports" ? (
                <ReportsPanel
                  invokingFocus={diagnosticFocusToken}
                  onOpenChange={(open) => {
                    if (!open) closeDiagnosticPanel();
                  }}
                  open={diagnosticPanelOpen}
                  port={diagnosticPort}
                  restoreFocus={restoreDiagnosticPanelFocus}
                  threadId={threadId}
                />
              ) : (
                <SecurityReportPanel
                  invokingFocus={diagnosticFocusToken}
                  onOpenChange={(open) => {
                    if (!open) closeDiagnosticPanel();
                  }}
                  open={diagnosticPanelOpen}
                  port={diagnosticPort}
                  restoreFocus={restoreDiagnosticPanelFocus}
                  threadId={threadId}
                />
              ),
          },
    executionModes: useExecutionModesSurface({
      client,
      threadId,
      capabilities,
      onFastRefused: retireFastRefusalNotice,
    }),
    ...useLiveVoiceSurfaces({
      client,
      threadId,
      capabilities,
      admitTurn: (turn) => store?.admitVoiceTurn(turn),
    }),
    mode: {
      title: "Input mode",
      render: () => <ModeIndicator capabilities={capabilities} />,
    },
    queue: {
      title: "Queued messages",
      open: queueOpen && editing === null,
      render: () => <QueueLaneBar connection={queueConnection} controller={queueAdapter} />,
    },
    attachments: {
      title: "Attachments",
      render: () => <AttachmentChips manager={attachmentManager} />,
    },
    context: {
      title: "Context",
      render: () => <SessionStatusBar client={client} store={store} threadId={threadId} />,
    },
    statusSegments: {
      title: "Status",
      grow: true,
      render: () => (
        <StatusSegments
          capabilities={capabilities}
          client={client}
          folder={folder}
          reportFailure={reportStatusFailure}
          roster={agents?.roster ?? null}
          runtime={store}
          threadId={threadId}
        />
      ),
    },
    editHandoff: {
      title: "Edit message",
      render: () => (
        <P3EditSurface
          onClose={() => setEditing(null)}
          runs={p3Runs}
          store={store}
          target={editing}
        />
      ),
    },
    toolsHidden: {
      title: "Tool activity hidden",
      render: () => <ToolsHiddenNotice />,
    },
    toolCalls: {
      title: "Tool calls",
      render: () => <ToolCallsControl />,
    },
    scrollFollow: {
      title: "Transcript actions",
      render: () => (
        <ScrollFollowControls
          onFollowLatest={scrollController.followLatest}
          isAtBottom={scrollController.isAtBottom}
        />
      ),
    },
    editRun: {
      title: "Edit status",
      render: () => (
        <P3RunStatusSurface
          onOpenSource={openThread}
          onRetry={p3Handlers.retry}
          runs={p3Runs}
          threadId={threadId}
        />
      ),
    },
    notifications: {
      title: "Notifications",
      render: () => <NotificationFeedback notices="none" projector={notificationProjector} />,
    },
    notices: {
      title: "Notices",
      render: () => <NotificationNotices projector={notificationProjector} />,
    },
    connection: connectionSurface,
    watchNotice: watchSurface,
  };
  return { threadSurfaces };
}

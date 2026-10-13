import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import {
  type AppError,
  AppFailure,
  type AppHealth,
  AppPort,
  type AppServerInfo,
  AttachmentBlobStore,
  type CapabilityMap,
  type DescriptorId,
  DraftScope,
  FolderPath,
  type HostCallId,
  HostMetadataPort,
  type ModelChoice,
  OmpCommandGateway,
  type OmpWire,
  type RpcSessionClient,
  RpcSessionPort,
  type RpcSessionSend,
  SessionFileStore,
  ThreadId,
  ToolCallId,
  UiRequestId,
} from "@omp-app/contracts";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AccessibilityProvider } from "@/a11y";
import { agentsSurface, RevealAgentHub } from "@/app/agents/agents-tab";
import { TaskSubagentsScope, useThreadAgents } from "@/app/agents/thread-agents-scope";
import { useRewindPanel } from "@/app/rewind/use-rewind-panel";
import { ToolRunScope } from "@/app/tool-run-scope";
import { Button } from "@/components/ui/button";
import {
  AppConnectionGate,
  AppConnectionProvider,
  ConnectionBanner,
  LaunchStatusScreen,
  OmpUnavailableScreen,
  rememberLogFile,
  SEND_BLOCKED_TEXT,
  useAppConnection,
  useWatchNotice,
  WatchNotice,
} from "@/launch";
import { LayoutArea, type LayoutAreaName, type Surface, type SurfaceMap } from "@/layout";
import type { CredentialActions } from "@/modules/D3/auth/credential-actions";
import { readProviderSignIns } from "@/modules/D3/auth/sign-in";
import { D3_LOGIN_COMMAND } from "@/modules/D3/descriptors";
import { runShareCommand } from "@/modules/D4/share";
import type {
  SessionCapabilitiesSource,
  SessionInfoMetadataSource,
  SessionInfoRuntimeSource,
} from "@/modules/D5/contract";
import { SessionLifecycleController } from "@/modules/D5/lifecycle";
import { FAST_REFUSAL_NOTICE_SOURCE } from "@/modules/D7/modes";
import { NotificationFeedback, NotificationNotices } from "@/modules/N1/feedback";
import { NotificationProjector, sessionRetiredNotices } from "@/modules/N1/notifications";
import {
  createP3Runs,
  P3EditSurface,
  type P3EditTarget,
  P3MessageActions,
  P3RunStatusSurface,
  type P3Runs,
  storedEntryId,
  useP3RunHandlers,
} from "@/modules/P3/runs";
import { BranchSummaryRow, branchSummaryOfRow } from "@/modules/P3/summary";
import { QueueLaneBar } from "@/modules/P6/bar/bar";
import { resolveQueueSubmitPolicy } from "@/modules/P6/composer/composer";
import { createQueueAdapter } from "@/modules/P6/contract";
import { createQueueController, type QueueController } from "@/modules/R0/actions";
import { type StoppedQueue, useOmpRuntime } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import { watchSessionFileChanges } from "@/modules/R1/catalog/session-changes";
import {
  createSelectedThreadHistoryController,
  type SelectedThreadHistoryController,
  type SelectedThreadHistoryState,
} from "@/modules/R1/history";
import { createNativeRemoteThreadListAdapter, deleteChatFile } from "@/modules/R1/remote";
import { type NewChatStatus, SessionCatalogSidebar } from "@/modules/R1/ui";
import { MessageParts } from "@/modules/U1/parts";
import { TranscriptDisplayPolicyProvider } from "@/modules/U1/policy";
import { ToolCallsControl } from "@/modules/U1/policy/tool-calls-control";
import { ToolsHiddenNotice } from "@/modules/U1/policy/tools-hidden-notice";
import {
  type ReadingPlace,
  readStoredReadingPlace,
  ScrollFollowControls,
  useThreadScrollController,
} from "@/modules/U1/scroll";
import { TranscriptShortcuts } from "@/modules/U1/shortcuts";
import { ThreadShell, TurnCancelScope } from "@/modules/U1/thread";
import { type ToolRendererResolver, ToolRendererResolverContext } from "@/modules/U1/tool-slots";
import { AttachmentChips, AttachmentManager, attachmentHoldReason } from "@/modules/U2/attachments";
import { createAttachmentBlobStore } from "@/modules/U2/attachments/blob-store";
import { ComposerSurface } from "@/modules/U2/composer";
import type {
  AttachmentAdapter,
  DraftRestoreRequest,
  PromptIntent,
  SubmitPolicy,
} from "@/modules/U2/contract";
import {
  createDraftStoreAdapter,
  type DraftController,
  DraftNotice,
  sessionDraftBuffer,
  useChatDraft,
  useComposerDraft,
} from "@/modules/U2/drafts";
import { createStorePromptSource, useIsRecalledPrompt } from "@/modules/U2/history";
import { ModeIndicator } from "@/modules/U2/modes";
import { NestedTranscript } from "@/modules/U3/tool-card/nested";
import { createToolRegistry } from "@/modules/U3/tool-card/registry";
import {
  cancelledHostToolResult,
  cancelledHostUriResult,
  type HostRequestAnswer,
} from "@/modules/U4/contract/host-answers";
import { renderDialogRequest } from "@/modules/U4/dialogs";
import { openChatDeleteConfirm } from "@/modules/U4/dialogs/confirm-chat-delete";
import { DialogHostController, useDisposeWhenReplaced } from "@/modules/U4/host";
import {
  ExtensionUiRequestRouterController,
  optIntoRichAsk,
  richAskOffered,
  subscribeNonModalExtensionUi,
} from "@/modules/U4/router";
import { PanelShell } from "@/modules/U5/panel/shell";
import { TodoChecklist } from "@/modules/U5/todo/checklist/checklist";
import { projectTodoSnapshot } from "@/modules/U5/todo/model";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import { type CommandPaletteHandler, CommandPaletteHost } from "@/palette";
import { U0_SHORTCUT_SHEET_COMMAND } from "@/palette/descriptor";
import { idleCommandHandlers } from "@/palette/idle-commands";
import { DESCRIPTORS, RENDERERS, registry, TOOL_RENDERERS } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { AppShell, ComposerNote } from "@/shell";
import {
  type PreferenceStore,
  ShortcutRegistryProvider,
  ShortcutSheetHost,
  useShortcutRegistry,
} from "@/shortcuts";
import { setThemePreference, ThemeApplier, ThemeButton } from "@/theme";
import { type AgentHubOpenResult, useAgentHubShortcut } from "./agents/agent-hub-shortcut";
import { reportClientError, setClientErrorSink } from "./client-errors";
import { useComposerClipboardShortcuts } from "./composer-clipboard";
import { useComposerEditingShortcuts } from "./composer-editing";
import { ComposerHistory } from "./composer-history";
import { composerInput } from "./composer-input";
import { ComposerTriggers } from "./composer-triggers";
import { SessionContextPanel } from "./context-panel";
import { browserClipboard, useCopyFromChat } from "./copy/use-copy-from-chat";
import { reportDraftFailure, useComposerDraftOwner } from "./draft-owner";
import { type EmptyStateCopy, emptyStateCopy } from "./empty-state";
import { useExecutionModesSurface } from "./execution-modes";
import {
  ExternalEditorDialog,
  type ExternalEditRequest,
  useExternalEditorShortcut,
} from "./external-editor-dialog";
import { FolderSwitcher } from "./folder-switcher";
import { HistorySearchDialog, useHistorySearchShortcut } from "./history-search-dialog";
import { useChatSessionInfo, useChatTodoStore } from "./owned-stores";
import { useRetryShortcut } from "./p3-retry-shortcut";
import { openProviderSignIn, requireProviderLogin } from "./provider-login-section";
import { useQueueDequeueShortcut } from "./queue-dequeue-shortcut";
import {
  composeRestoredDraft,
  restoredCount,
  restoredQueueText,
  stopRestoreNotice,
} from "./queue-stop-restore";
import {
  imageUploadTo,
  restoreStoppedQueueIntoSavedDraft,
  storeRestoredImages,
} from "./queue-stop-saved-draft";
import { saveTextFile } from "./save-file";
import { openSavedChatModelPicker } from "./saved-chat-model-picker";
import { openSessionModelDialog, SessionModelControl, SessionStatusBar } from "./session-controls";
import { useSessionTitle } from "./session-title";
import { SettingsScreen } from "./settings-screen";
import { useShareFromChat } from "./share/use-share-from-chat";
import {
  agentHubSlashCommand,
  askFirstSlashCommands,
  freshSlashCommand,
  guardOmpSend,
  hotkeysSlashCommand,
  loginSlashCommand,
  newChatSlashCommand,
  routeSubmit,
  runSlashRoute,
  settingsSlashCommand,
  shareSlashCommand,
  useSlashCommands,
} from "./slash-commands";
import { finishedAnswerAt } from "./turn-end";
import { useGoalCommands } from "./use-goal-command";

const FOLDER_KEY = "omp.app.root.folder";
const THREAD_KEY = "omp.app.root.thread";
/**
 * The settings frame is 60 rem (960 px at the default size) and never wider than 94% of the window,
 * so a phone still shows a margin. It does not scroll: its panel's body does, so the title stays whole.
 * Its one grid column may be narrower than the header's content (`minmax(0, 1fr)`), so the header's
 * Close button stays inside the frame at 200% zoom on a phone, and the title truncates instead.
 */
const SETTINGS_FRAME_CLASS =
  "w-[min(60rem,94vw)] max-w-none grid-cols-[minmax(0,1fr)] overflow-hidden p-0";
const EMPTY_HISTORY: SelectedThreadHistoryState = {
  threadId: undefined,
  store: undefined,
  capabilities: undefined,
  isLoading: false,
  error: null,
  openedNew: false,
};
const EMPTY_CAPABILITIES: CapabilityMap = Object.freeze({});
function useNotificationProjector(
  store: OmpRuntimeStore,
  onEditorText: (text: string, context: { readonly threadId: ThreadId }) => void,
  instanceId: () => string | undefined,
): NotificationProjector {
  const projectorRef = useRef<NotificationProjector | null>(null);
  const generationRef = useRef(0);
  if (projectorRef.current === null) {
    projectorRef.current = new NotificationProjector({
      source: store,
      events: store,
      onEditorText,
      retired: sessionRetiredNotices(window.sessionStorage, instanceId),
    });
  }
  useEffect(() => {
    const projector = projectorRef.current;
    const generation = ++generationRef.current;
    return () => {
      queueMicrotask(() => {
        if (generationRef.current !== generation || projectorRef.current !== projector) return;
        projector?.dispose();
        projectorRef.current = null;
      });
    };
  }, []);
  return projectorRef.current;
}

/** The app's tool claims. The chat's exact-name map and the prefix resolver below both read it. */
const toolRegistry = createToolRegistry(TOOL_RENDERERS);

/**
 * U1 asks this for a tool name its exact-name map lacks. A prefix claim (an MCP tool's name) gets its
 * card; a name nothing claims gets T7's fallback card, which shows its arguments and result text.
 */
const resolveToolRenderer: ToolRendererResolver = (toolName) =>
  toolRegistry.resolve(toolName).renderer;

function readSessionValue(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Reload persistence is best effort; the visible application remains usable.
  }
}
function SettingsButton({
  onOpenSettings,
  threadId,
}: {
  readonly onOpenSettings: (threadId: ThreadId | null) => void;
  readonly threadId: ThreadId | null;
}) {
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => onOpenSettings(threadId)}>
      Settings
    </Button>
  );
}

/** A chat that did not open because its saved model is gone: the empty screen offers the picker for it. */
interface OpenFailure {
  readonly threadId: ThreadId;
  readonly error: AppError;
}

function EmptyTranscript({
  copy,
  action,
}: {
  readonly copy: EmptyStateCopy;
  readonly action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-lg font-medium tracking-tight">{copy.title}</p>
      <p className="text-muted-foreground text-sm">{copy.detail}</p>
      {action}
    </div>
  );
}

function RouterBridge({
  store,
  threadId,
  queueController,
  dialogHost,
  notificationProjector,
  askDialogOffered,
  send,
}: {
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly queueController: QueueController;
  readonly dialogHost: DialogHostController;
  readonly notificationProjector: NotificationProjector;
  readonly askDialogOffered: boolean;
  readonly send: RpcSessionSend;
}) {
  // Stable: the router must not be rebuilt every time some overlay opens or closes.
  const overlay = useStableOverlayHost();
  const hostAnswers = useMemo(() => {
    const submit = async (
      answer: HostRequestAnswer,
      options?: { readonly signal?: AbortSignal },
    ): Promise<void> => {
      const id = answer.requestId;
      if (answer.kind === "uri-result") {
        await queueController.answerHostUri(
          { type: "host_uri_result", id, ...answer.result },
          options,
        );
      } else if (answer.kind === "tool-update") {
        await queueController.answerHostTool(
          { type: "host_tool_update", id, partialResult: answer.partialResult },
          options,
        );
      } else {
        await queueController.answerHostTool(
          { type: "host_tool_result", id, result: answer.result, isError: answer.result.isError },
          options,
        );
      }
    };
    return {
      submit,
      cancel: (
        requestId: HostCallId,
        reason: string,
        options?: { readonly signal?: AbortSignal },
      ) =>
        submit(
          store.getSnapshot().pending.hostUris[requestId]
            ? cancelledHostUriResult(requestId, reason)
            : cancelledHostToolResult(requestId, reason),
          options,
        ),
    };
  }, [queueController, store]);
  const router = useMemo(
    () =>
      new ExtensionUiRequestRouterController({
        dialogHost,
        overlay,
        hostAnswers,
        presentations: notificationProjector,
      }),
    [dialogHost, hostAnswers, notificationProjector, overlay],
  );
  useEffect(() => {
    const sync = () => {
      const pending = store.getSnapshot().pending;
      void router
        .sync(
          {
            extensionUi: pending.extensionUi,
            hostTools: pending.hostTools,
            hostUris: pending.hostUris,
          },
          { threadId },
        )
        .catch(() =>
          notificationProjector.present(
            { kind: "notify", message: "An omp update could not be shown.", notifyType: "error" },
            { threadId },
          ),
        );
    };
    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
    };
  }, [router, store, threadId, notificationProjector.present]);
  useEffect(
    () => subscribeNonModalExtensionUi(store, router, { threadId }),
    [router, store, threadId],
  );

  // omp asks each question as a select list until this session opts in to rich `ask` requests. A page sends the opt-in
  // each time it shows the chat, which covers a restarted server; the server keeps it for the chat and re-sends it to
  // every new omp (rpc-session.ts, #respawn).
  useEffect(() => {
    if (!askDialogOffered) return;
    void optIntoRichAsk(send, threadId).catch((error: unknown) =>
      reportClientError({
        kind: "error",
        message: `Rich ask questions could not be turned on: ${error instanceof Error ? error.message : "unknown error"}`,
      }),
    );
  }, [askDialogOffered, send, threadId]);
  return null;
}

function DraftComposer({
  chat,
  controller,
  capabilities,
  submit,
  cancel,
  policy,
  toolbar,
  footer,
  footerOpen,
  editing,
  manager,
  onRetry,
  onResolve,
  sendBlockedReason,
  onDoubleLeftArrow,
}: {
  readonly controller: DraftController;
  /** The chat the draft belongs to (see `useChatDraft`): a different one once the person switches chats. */
  readonly chat: object;
  readonly capabilities: CapabilityMap;
  readonly submit: (intent: PromptIntent) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly policy: SubmitPolicy;
  /** The composer's areas from the layout (`composerToolbar`, `composerFooter`). */
  readonly toolbar: ReactNode;
  readonly footer: ReactNode;
  readonly footerOpen: boolean;
  readonly editing: boolean;
  readonly manager: AttachmentManager;
  /** Runs the step that failed again: the composer's Retry. */
  readonly onRetry: () => void;
  /** Keeps this tab's text, or takes the other tab's, for a draft conflict. */
  readonly onResolve: (choice: "local" | "remote") => Promise<void>;
  /** Why the composer cannot send right now; the text stays in the composer while it is set. */
  readonly sendBlockedReason?: string;
  readonly onDoubleLeftArrow: () => void;
}) {
  const aui = useAui();
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  const attachmentState = useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getState(),
    () => manager.getState(),
  );
  const hasAttachmentOutput =
    attachmentState.pending.length > 0 || attachmentState.complete.length > 0;
  const text = useAuiState((state) => state.composer.text);
  useComposerDraftOwner(controller);
  const isRecalledPrompt = useIsRecalledPrompt();
  useComposerDraft({
    chat,
    controller,
    text,
    composer: aui.composer,
    attachments: manager,
    isRecalledPrompt,
  });
  return (
    <ComposerSurface
      capabilities={capabilities}
      cancel={cancel}
      disabled={snapshot.status === "error"}
      replaced={editing}
      policy={policy}
      attachmentHoldReason={attachmentHoldReason(attachmentState)}
      sendBlockedReason={sendBlockedReason}
      submitPrompt={submit}
      toolbar={toolbar}
      showAttachmentNames={false}
      onDoubleLeftArrow={onDoubleLeftArrow}
    >
      <DraftNotice
        onResolve={onResolve}
        onResolveReplaced={(choice) => controller.resolveReplaced(choice)}
        onRetry={onRetry}
        snapshot={snapshot}
      />
      {hasAttachmentOutput || footerOpen ? footer : null}
    </ComposerSurface>
  );
}

interface ActiveThreadProps {
  readonly deliverToOpenChat: (intent: PromptIntent) => Promise<void>;
  readonly registerLiveChat: (
    threadId: ThreadId,
    deliver: (intent: PromptIntent) => Promise<void>,
  ) => () => void;
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly history: SelectedThreadHistoryState;
  /** Loads the page of messages older than the ones shown; the thread offers it while history is older. */
  readonly onLoadOlder?: () => Promise<void>;
  /** Loads the full text of a tool output the thread shows shortened. */
  readonly onLoadFullOutput?: (toolCallId: string) => Promise<void>;
  /** Brings the open thread up to date after a `!` command; omp saves a command's result without a turn. */
  readonly onRefreshAfterCommand?: () => Promise<void>;
  readonly capabilities: CapabilityMap;
  readonly folder: FolderPath | null;
  readonly catalog: SessionCatalogModel | null;
  readonly onOpenSettings: (threadId: ThreadId | null, restoreFocus?: HTMLElement) => void;
  readonly remote: ReturnType<typeof createNativeRemoteThreadListAdapter> | null;
  /** Called when the person sends a message (the sidebar's list is fetched again once it is answered). */
  readonly onPromptSent: () => void;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
  readonly leftSidebar: ReactNode;
  readonly title: string;
  readonly p3Runs: P3Runs;
  /** The place the reader was in when the page last closed, for the reload that reopens this chat. */
  readonly resumePlace: ReadingPlace | null;
  /** The connection banner's surface: over the chat while the app reconnects (`connection` in `LAYOUT`). */
  readonly connectionSurface: Surface;
  /** The watch notice's surface: over the chat while the server cannot watch some files (`watchNotice` in `LAYOUT`). */
  readonly watchSurface: Surface;
}

function ActiveThreadContent(props: ActiveThreadProps) {
  if (!props.history.store || !props.history.threadId) return null;
  return <ActiveThreadReady {...props} />;
}

function ActiveThreadReady({
  client,
  capabilities,
  folder,
  catalog,
  history,
  leftSidebar,
  onPromptSent,
  openThread,
  deliverToOpenChat,
  registerLiveChat,
  onOpenSettings,
  remote,
  title,
  p3Runs,
  resumePlace,
  connectionSurface,
  watchSurface,
  onLoadOlder,
  onLoadFullOutput,
  onRefreshAfterCommand,
}: ActiveThreadProps) {
  const store = history.store as OmpRuntimeStore;
  const threadId = history.threadId as ThreadId;
  const connection = useAppConnection();
  const rpc = useMemo(() => client.port(RpcSessionPort), [client]);
  const guardedSend = useMemo(() => guardOmpSend(rpc.send), [rpc.send]);
  const sessionFiles = useMemo(() => client.port(SessionFileStore), [client]);
  const agents = useThreadAgents({
    threadId,
    store,
    session: rpc,
    files: sessionFiles,
    capabilities,
  });
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  // The message being edited, and the row button that opened the editor (focus returns to it on cancel).
  const [editing, setEditing] = useState<P3EditTarget | null>(null);
  // Edit and Regenerate need omp's branch command, and a row omp has saved: a streaming row has no entry yet.
  const branchAvailable = capabilities["omp.cmd.branch"]?.state === "available";
  const rowActions = (row: { readonly id: string; readonly role: string }): ReactNode => {
    if (!branchAvailable) return undefined;
    const entryId = storedEntryId(store, row.id);
    if (entryId === null) return undefined;
    return (
      <P3MessageActions
        onEdit={row.role === "user" ? (trigger) => setEditing({ entryId, trigger }) : undefined}
      />
    );
  };
  // A header message about a palette command goes away on its own; an error that stayed until the
  // next command left "could not be started" on screen long after the moment had passed.
  useEffect(() => {
    if (commandStatus === null && commandError === null) return;
    const timer = window.setTimeout(() => {
      setCommandStatus(null);
      setCommandError(null);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [commandStatus, commandError]);
  // Stable, so the dialog host below isn't torn down (cancelling a dialog that was just presented)
  // when the command palette or any other overlay opens.
  const overlay = useStableOverlayHost();
  const commandGateway = useMemo(() => client.port(OmpCommandGateway), [client]);
  // Answers go through R0's queue controller (assigned below), because it forgets the request once
  // omp accepts the answer. Answering through the raw RPC port left the request "pending" in the
  // store, and the router presented the same question a second time.
  const answerExtensionUiRef = useRef<QueueController["answerExtensionUi"] | null>(null);
  // The newest capability map, read when a question arrives, so replacing the map (a reconnect
  // reloads it) never rebuilds the host and cancels a question the user is looking at.
  const capabilitiesRef = useRef(capabilities);
  useLayoutEffect(() => {
    capabilitiesRef.current = capabilities;
  });
  // One host per thread: a host only presents dialogs for the thread it first served.
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadId deliberately re-keys the host.
  const dialogHost = useMemo(
    () =>
      new DialogHostController({
        overlay,
        capabilities: () => capabilitiesRef.current,
        answerExtensionUi: (response, options) => {
          const answer = answerExtensionUiRef.current;
          if (answer === null) {
            throw new AppFailure({
              code: "unavailable",
              message: "omp's question can't be answered right now. Try again.",
              retryable: true,
            });
          }
          return answer({ ...response, id: UiRequestId.parse(response.id) }, options);
        },
        render: renderDialogRequest,
      }),
    [overlay, threadId],
  );
  useDisposeWhenReplaced(dialogHost);
  useCopyFromChat({
    threadId,
    store,
    dialogs: dialogHost,
    clipboard: browserClipboard,
    download: saveTextFile,
    showStatus: setCommandStatus,
  });
  const shareController = useShareFromChat({
    client,
    threadId,
    folder,
    dialogs: dialogHost,
    clipboard: browserClipboard,
    showStatus: setCommandStatus,
    showError: setCommandError,
  });
  const runtimeSource = useMemo<SessionInfoRuntimeSource>(
    () => ({
      getSnapshot: () => ({ threadId, session: store.getSnapshot().session }),
      subscribe: (listener) => store.subscribe(listener),
    }),
    [store, threadId],
  );
  const metadataSource = useMemo<SessionInfoMetadataSource>(
    () => ({
      getSnapshot: () =>
        catalog?.getSnapshot().sessions.find((session) => session.id === threadId) ?? null,
      subscribe: (listener) => catalog?.subscribe(() => listener()) ?? (() => undefined),
    }),
    [catalog, threadId],
  );
  const sessionInfo = useChatSessionInfo(runtimeSource, metadataSource);
  const sessionCapabilities = useMemo<SessionCapabilitiesSource>(
    () => ({ getSnapshot: () => capabilities }),
    [capabilities],
  );
  const lifecycle = useMemo(
    () =>
      remote
        ? new SessionLifecycleController({
            remote,
            gateway: commandGateway,
            dialogs: dialogHost,
            capabilities: sessionCapabilities,
            session: sessionInfo,
          })
        : null,
    [commandGateway, dialogHost, remote, sessionCapabilities, sessionInfo],
  );
  const openSessionBrowser = useCallback(() => {
    if (!catalog || !remote) {
      throw new AppFailure({
        code: "unavailable",
        message: "Session browsing is unavailable for this workspace.",
        retryable: false,
        capability: "host.session-files",
      });
    }
    const restoreFocus =
      document.querySelector<HTMLElement>('[aria-label="Search sessions"]') ?? false;
    overlay.open({
      kind: "modal",
      label: "Open session",
      width: "content",
      restoreFocus,
      content: ({ close }) => (
        <div className="max-h-[75vh] overflow-y-auto">
          <SessionCatalogSidebar
            catalog={catalog}
            currentThreadId={threadId}
            onNewChat={async (newThreadId) => {
              await openThread(newThreadId);
              close("programmatic");
            }}
            onOpenThread={async (selectedThreadId) => {
              await openThread(selectedThreadId);
              close("programmatic");
            }}
            confirmDelete={(_session, title) => openChatDeleteConfirm(overlay, title)}
            currentTurnRunning={() => store.getSnapshot().prompt.streaming === true}
            remote={remote}
          />
        </div>
      ),
    });
  }, [catalog, openThread, overlay, remote, store, threadId]);
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
  ]);
  const clearReason =
    lifecycle?.getAvailability("clear").reason ??
    "Clearing the conversation only works in the omp terminal for now.";
  const commandUnavailableReasons = useMemo(
    () => new Map<DescriptorId, string>([["D5.clear", clearReason]]),
    [clearReason],
  );
  const attachmentManager = useMemo(
    () =>
      new AttachmentManager({
        blobStore: createAttachmentBlobStore(client.port(AttachmentBlobStore)),
      }),
    [client],
  );
  const runtimeAttachments = useMemo<AttachmentAdapter>(
    () => ({
      accept: attachmentManager.accept,
      add: async ({ file }) => {
        const pending = await attachmentManager.add({ file });
        const complete = await attachmentManager.send(pending);
        return { ...pending, content: complete.content };
      },
      send: (attachment, options) => attachmentManager.send(attachment, options),
      remove: (attachment) => attachmentManager.remove(attachment),
      getState: () => attachmentManager.getState(),
      subscribe: (listener) => attachmentManager.subscribe(listener),
      toDraftRefs: () => attachmentManager.toDraftRefs(),
    }),
    [attachmentManager],
  );
  const p3Handlers = useP3RunHandlers({ store, send: guardedSend, openThread, runs: p3Runs });
  // The banner of an omp that stopped on its own offers this: the server starts omp again on this chat.
  const restartOmp = useCallback(async (): Promise<void> => {
    await rpc.restart({ threadId });
  }, [rpc, threadId]);
  useRetryShortcut({ threadId, status: p3Runs.status, retry: p3Handlers.retry });
  useAgentHubShortcut(openAgentHub);
  useComposerClipboardShortcuts({ notify: setCommandStatus, fail: setCommandError });
  // Stop hands back what omp withdrew. The chat on screen takes it through its draft; any other chat keeps it in its
  // saved draft by its thread id, so it waits there whether or not that chat is still on screen.
  const restoreStoppedRef = useRef<
    ((restored: OmpWire.AbortAndRestoreQueueResult) => Promise<void>) | null
  >(null);
  const uploadRestoredImage = useMemo(
    () => imageUploadTo(createAttachmentBlobStore(client.port(AttachmentBlobStore))),
    [client],
  );
  const handleQueueRestored = useCallback(
    (stopped: StoppedQueue) => {
      const restoreMounted = restoreStoppedRef.current;
      if (stopped.threadId === threadId && restoreMounted !== null) {
        void restoreMounted(stopped.restored);
        return;
      }
      void restoreStoppedQueueIntoSavedDraft(
        {
          drafts: createDraftStoreAdapter(client),
          scope: DraftScope.parse({ kind: "thread", threadId: stopped.threadId }),
          upload: uploadRestoredImage,
        },
        stopped.restored,
      )
        .then((lost) => {
          if (lost > 0) {
            reportDraftFailure("Storing a queued image in that chat's draft failed")(
              new Error(`${lost} image(s) were not stored`),
            );
          }
        })
        .catch(reportDraftFailure("Keeping what Stop withdrew in that chat's draft failed"));
    },
    [client, threadId, uploadRestoredImage],
  );
  const { controller: runtimeController, runtime } = useOmpRuntime({
    store,
    send: guardedSend,
    capabilities,
    attachments: runtimeAttachments,
    onEdit: p3Handlers.onEdit,
    onReload: p3Handlers.onReload,
    onQueueRestored: handleQueueRestored,
  });
  useEffect(
    () => p3Runs.handoff.attach(threadId, runtimeController),
    [p3Runs, runtimeController, threadId],
  );
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);
  const scrollController = useThreadScrollController(transcriptRootRef);
  const queueController = useMemo(
    () => createQueueController({ store, send: guardedSend, capabilities }),
    [capabilities, guardedSend, store],
  );
  useLayoutEffect(() => {
    answerExtensionUiRef.current = (response, options) =>
      queueController.answerExtensionUi(response, options);
    return () => {
      answerExtensionUiRef.current = null;
    };
  }, [queueController]);
  const queueAdapter = useMemo(() => createQueueAdapter(queueController), [queueController]);
  const todoStore = useChatTodoStore(store);
  const todoSnapshot = useSyncExternalStore(
    (listener) => todoStore.subscribe(listener),
    () => todoStore.getSnapshot(),
    () => todoStore.getSnapshot(),
  );
  const todoModel = useMemo(() => projectTodoSnapshot(todoSnapshot), [todoSnapshot]);
  const toolRenderers = useMemo(
    () =>
      Object.fromEntries(
        TOOL_RENDERERS.flatMap((descriptor) =>
          descriptor.match.by === "name"
            ? [[descriptor.match.name, toolRegistry.resolve(descriptor.match.name).renderer]]
            : [],
        ),
      ),
    [],
  );
  const draftStore = useMemo(() => createDraftStoreAdapter(client), [client]);
  // Unsent text is also kept in this tab, so it survives the app's server stopping before the autosave saves it.
  const draftBuffer = useMemo(
    () => sessionDraftBuffer(reportDraftFailure("Keeping unsent draft text in this tab failed")),
    [],
  );
  // The composer's draft: this chat's own draft once it has messages, the folder's new-chat draft before that.
  const chatDraft = useChatDraft({
    draftStore,
    folder,
    threadId,
    startsUnsent: history.openedNew,
    messages: store,
    loaded: !history.isLoading,
    buffer: draftBuffer,
  });
  const draftController = chatDraft.controller;
  const setEditorText = useCallback(
    (text: string) => draftController.setDraft(text, attachmentManager.toDraftRefs()),
    [attachmentManager, draftController],
  );

  // Stop with queued messages in the chat on screen: the withdrawn images are stored and the draft takes them ahead of
  // its attachments, and the text goes in ahead of what was typed. An answer that withdrew nothing changes nothing.
  const restoreStopped = useCallback(
    async (restored: OmpWire.AbortAndRestoreQueueResult): Promise<void> => {
      if (restoredCount(restored) === 0) return;
      const { refs, lost } = await storeRestoredImages(restored, uploadRestoredImage);
      draftController.setDraft(
        composeRestoredDraft(restoredQueueText(restored), draftController.getSnapshot().text),
        [...refs, ...attachmentManager.toDraftRefs()],
      );
      setCommandStatus(stopRestoreNotice(restored));
      if (lost > 0) {
        setCommandError(
          lost === 1
            ? "A queued image could not be brought back into the message box."
            : "Some queued images could not be brought back into the message box.",
        );
      }
    },
    [attachmentManager, draftController, uploadRestoredImage],
  );
  useLayoutEffect(() => {
    restoreStoppedRef.current = restoreStopped;
    return () => {
      restoreStoppedRef.current = null;
    };
  }, [restoreStopped]);

  const queueDraft = useCallback(
    (): DraftRestoreRequest => ({
      text: draftController.getSnapshot().text,
      attachmentRefs: attachmentManager.toDraftRefs(),
    }),
    [attachmentManager, draftController],
  );
  const restoreQueued = useCallback(
    (request: DraftRestoreRequest) => setEditorText(request.text),
    [setEditorText],
  );
  useQueueDequeueShortcut({
    queue: queueAdapter,
    draft: queueDraft,
    restore: restoreQueued,
    notify: setCommandStatus,
    fail: setCommandError,
  });
  const promptSource = useMemo(() => createStorePromptSource(store), [store]);
  const readPrompts = useCallback(() => promptSource.getUserPrompts(), [promptSource]);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const openHistorySearch = useCallback(() => setHistorySearchOpen(true), []);
  useHistorySearchShortcut(openHistorySearch);
  useComposerEditingShortcuts({ notify: setCommandStatus });
  const [editRequest, setEditRequest] = useState<ExternalEditRequest | null>(null);
  const editInDialog = useCallback(
    (initialText: string) =>
      new Promise<string>((resolve) => setEditRequest({ initialText, resolve })),
    [],
  );
  const readDraftText = useCallback(() => draftController.getSnapshot().text, [draftController]);
  useExternalEditorShortcut({ readDraft: readDraftText, edit: editInDialog, apply: setEditorText });
  // The server instance now, read through a ref that a layout effect refreshes, since the client can be replaced.
  const instanceIdOf = useRef<() => string | undefined>(() => undefined);
  useLayoutEffect(() => {
    instanceIdOf.current = () => connection.client?.instanceId;
  });
  const notificationProjector = useNotificationProjector(store, setEditorText, () =>
    instanceIdOf.current(),
  );
  // A Fast mode change omp refuses leaves omp's own notice; the Execution modes dialog already says it, so it goes.
  const retireFastRefusalNotice = useCallback(() => {
    notificationProjector?.getBus().retireQuietFrom(threadId, FAST_REFUSAL_NOTICE_SOURCE);
  }, [notificationProjector, threadId]);
  const shortcutRegistry = useShortcutRegistry();
  // Slash commands for this chat: omp's list (with MCP prompts) and the app's own `/new` and `/fresh`.
  const appSlashCommands = useMemo(
    () => [
      newChatSlashCommand({ lifecycle, openThread }),
      freshSlashCommand({ lifecycle }),
      shareSlashCommand({ run: () => runShareCommand(shareController) }),
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
      }),
      agentHubSlashCommand({ openAgentHub }),
      goalCommand,
    ],
    [
      catalog,
      commandGateway,
      goalCommand,
      lifecycle,
      onOpenSettings,
      openAgentHub,
      openLogin,
      openThread,
      overlay,
      shareController,
      shortcutRegistry,
      threadId,
      title,
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
  // What a send does in the chat it is for: a slash command, or omp's prompt. It is read at the send, so a send that
  // waited for a chat to open runs in the chat on screen, never in the one before it.
  const deliver = useCallback(
    async (intent: PromptIntent): Promise<void> => {
      const route = await routeSubmit({
        intent,
        hasAttachments: attachmentManager.toDraftRefs().length > 0,
        provider: slashProvider,
        appCommands: appSlashCommands,
      });
      if (route === null) {
        await runtimeController.submitPrompt({
          ...intent,
          attachmentRefs: attachmentManager.toDraftRefs(),
        });
        return;
      }
      await runSlashRoute({
        route,
        intent,
        provider: slashProvider,
        showStatus: setCommandStatus,
        runMode: (request, options) => commandGateway.modeChange({ threadId, request }, options),
      });
    },
    [
      attachmentManager,
      appSlashCommands,
      commandGateway,
      runtimeController,
      slashProvider,
      threadId,
    ],
  );
  // The view for the chat on screen registers how a send reaches it (see `deliverToOpenChat` in the root).
  useLayoutEffect(() => registerLiveChat(threadId, deliver), [deliver, registerLiveChat, threadId]);
  const submit = async (intent: PromptIntent): Promise<void> => {
    onPromptSent();
    // Sending shows the newest message, wherever the reader had scrolled to; the transcript then
    // keeps following by itself because it is at the bottom.
    scrollController.jumpToLatest();
    // The draft keeps the text until the send is admitted. The send goes to the chat that is open when it is delivered.
    await chatDraft.submit(intent, deliverToOpenChat);
    if (intent.mode === "bash") void onRefreshAfterCommand?.();
    attachmentManager.clearAfterSend();
    scrollController.jumpToLatest();
  };
  const cancel = (): Promise<void> => runtimeController.cancel();
  const queueConnection = {
    state:
      connection.state === "connected"
        ? ("connected" as const)
        : connection.state === "reconnecting"
          ? ("reconnecting" as const)
          : connection.state === "connecting"
            ? ("connecting" as const)
            : ("closed" as const),
    reason: connection.reason,
  };
  // While the app reconnects the chat stays on screen: the composer keeps the text and says it cannot send yet.
  const sendBlockedReason = connection.state === "connected" ? undefined : SEND_BLOCKED_TEXT;
  // What a refused-key notice in the transcript can do: open the model list, open sign-in, and read each
  // provider's sign-in. Built once per open chat; a view only calls these.
  const credentialActions = useMemo<CredentialActions>(
    () => ({
      chooseModel: () =>
        openSessionModelDialog({ overlay, client, store, threadId, capabilities, folder }),
      signIn: () => openProviderSignIn({ overlay, client, threadId, capabilities }),
      readSignIns: () => readProviderSignIns({ client, threadId }),
    }),
    [overlay, client, store, threadId, capabilities, folder],
  );
  // What each surface id renders for an open conversation. Where it goes: `@/layout` (LAYOUT).
  const threadSurfaces: SurfaceMap = {
    title: {
      title: "Conversation",
      grow: true,
      render: () => (
        <div className="relative min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">omp</h1>
          <p className="text-muted-foreground truncate text-xs">{title}</p>
          {/* A message about a command floats over the top of the chat, so the header keeps its height. */}
          {(commandStatus !== null || commandError !== null) && (
            <div className="absolute start-0 top-full z-10 flex w-max max-w-[min(26rem,calc(100vw-4.5rem))] flex-col gap-1 pt-1">
              {commandStatus && (
                <p
                  className="border-border bg-popover text-popover-foreground shadow-overlay rounded-md border px-3 py-2 text-xs"
                  role="status"
                >
                  {commandStatus}
                </p>
              )}
              {commandError && (
                <p
                  className="border-border bg-popover text-danger shadow-overlay rounded-md border px-3 py-2 text-xs"
                  role="alert"
                >
                  {commandError}
                </p>
              )}
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
      render: () => <SettingsButton onOpenSettings={onOpenSettings} threadId={threadId} />,
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
      render: () => <SessionContextPanel client={client} store={store} threadId={threadId} />,
    },
    agents: agentsSurface({ agents, reveal: agentsReveal }),
    rewind: useRewindPanel({
      threadId,
      store,
      send: guardedSend,
      capabilities,
      submitPrompt: runtimeController.submitPrompt,
      switchThread: openThread,
    }),
    executionModes: useExecutionModesSurface({
      client,
      threadId,
      capabilities,
      onFastRefused: retireFastRefusalNotice,
    }),
    mode: { title: "Input mode", render: () => <ModeIndicator capabilities={capabilities} /> },
    queue: {
      title: "Queued messages",
      fullRow: true,
      render: () => <QueueLaneBar connection={queueConnection} controller={queueAdapter} />,
    },
    attachments: {
      title: "Attachments",
      render: () => <AttachmentChips manager={attachmentManager} />,
    },
    context: {
      title: "Context",
      grow: true,
      render: () => <SessionStatusBar client={client} store={store} threadId={threadId} />,
    },
    editHandoff: {
      title: "Edit message",
      render: () => (
        <P3EditSurface onClose={() => setEditing(null)} store={store} target={editing} />
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
  const area = (name: LayoutAreaName) => (
    <LayoutArea area={name} capabilities={capabilities} surfaces={threadSurfaces} />
  );
  const composer = (
    <ComposerTriggers
      capabilities={capabilities}
      client={client}
      folder={folder}
      slash={slashProvider}
    >
      <ComposerHistory store={store}>
        <DraftComposer
          capabilities={capabilities}
          cancel={cancel}
          chat={chatDraft.chat}
          controller={draftController}
          footer={area("composerFooter")}
          footerOpen={editing !== null}
          editing={editing !== null}
          manager={attachmentManager}
          onResolve={chatDraft.resolveConflict}
          onRetry={chatDraft.retry}
          onDoubleLeftArrow={openAgentHub}
          policy={resolveQueueSubmitPolicy}
          sendBlockedReason={sendBlockedReason}
          submit={submit}
          toolbar={area("composerToolbar")}
        />
      </ComposerHistory>
      <HistorySearchDialog
        open={historySearchOpen}
        onOpenChange={setHistorySearchOpen}
        readPrompts={readPrompts}
        onPick={(text) => {
          setHistorySearchOpen(false);
          setEditorText(text);
        }}
      />
      <ExternalEditorDialog
        request={editRequest}
        onFinish={(text) => {
          editRequest?.resolve(text);
          setEditRequest(null);
        }}
      />
    </ComposerTriggers>
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CommandPaletteHost
        capabilities={capabilities}
        handlers={commandHandlers}
        unavailableReasons={commandUnavailableReasons}
      />
      <RouterBridge
        dialogHost={dialogHost}
        notificationProjector={notificationProjector}
        queueController={queueController}
        store={store}
        threadId={threadId}
        askDialogOffered={richAskOffered(capabilities)}
        send={guardedSend}
      />
      <ToolRunScope runBackgroundJobCommand={runBackgroundJobCommand} store={store}>
        <TaskSubagentsScope agents={agents}>
          <TurnCancelScope cancel={cancel}>
            <AppShell
              composer={composer}
              leftSidebar={leftSidebar}
              statusBar={area("statusBar")}
              threadHeader={area("header")}
              rightSidebar={
                <>
                  {area("panels")}
                  <RevealAgentHub reveal={agentsReveal} />
                </>
              }
              transcript={
                store && threadId ? (
                  <TranscriptDisplayPolicyProvider threadId={threadId}>
                    <TranscriptShortcuts followLatest={scrollController.followLatest}>
                      <div className="h-full min-h-0" ref={transcriptRootRef}>
                        <ThreadShell
                          autoScroll={!scrollController.followPaused}
                          credentialActions={credentialActions}
                          readingPlace={{
                            threadId,
                            resumeAt: resumePlace,
                            historyLoading: history.isLoading,
                          }}
                          footer={
                            <>
                              {area("threadFooter")}
                              {area("threadOverlay")}
                            </>
                          }
                          onLoadOlder={onLoadOlder}
                          onLoadFullOutput={onLoadFullOutput}
                          onRestartOmp={restartOmp}
                          slots={{
                            renderMessage: (message, renderNested) => {
                              const branchSummary = branchSummaryOfRow(message);
                              if (branchSummary !== undefined)
                                return (
                                  <BranchSummaryRow message={message} summary={branchSummary} />
                                );
                              return (
                                <MessageParts
                                  message={message}
                                  actions={rowActions(message)}
                                  renderNested={(part) =>
                                    part.messages === undefined
                                      ? undefined
                                      : renderNested?.(
                                          part.messages,
                                          part.toolCallId,
                                          part.toolName,
                                        )
                                  }
                                  toolRenderers={toolRenderers}
                                />
                              );
                            },
                            renderNested: (messages, taskId, toolName) => {
                              const parsedTaskId = ToolCallId.safeParse(taskId);
                              return (
                                <NestedTranscript
                                  depth={0}
                                  key={taskId}
                                  messages={messages}
                                  parentTaskId={
                                    parsedTaskId.success ? parsedTaskId.data : undefined
                                  }
                                  taskName={toolName}
                                  toolRenderers={toolRenderers}
                                />
                              );
                            },
                          }}
                          store={store}
                        />
                      </div>
                    </TranscriptShortcuts>
                  </TranscriptDisplayPolicyProvider>
                ) : (
                  <EmptyTranscript
                    copy={emptyStateCopy({ opening: history.isLoading, error: history.error })}
                  />
                )
              }
            />
          </TurnCancelScope>
        </TaskSubagentsScope>
      </ToolRunScope>
    </AssistantRuntimeProvider>
  );
}

function ConnectedApp({
  client,
  capabilities,
  launchFolder,
  watchNotice,
}: {
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly capabilities: CapabilityMap;
  readonly launchFolder: FolderPath;
  readonly watchNotice: string | undefined;
}) {
  const connection = useAppConnection();
  const overlay = useStableOverlayHost();
  const lastInstanceId = useRef<string | undefined>(undefined);
  const [folderText, setFolderText] = useState(() => readSessionValue(FOLDER_KEY, launchFolder));
  // The place the reader was in when the page last closed: a reload that reopens the chat returns there.
  const [resumePlace, setResumePlace] = useState<ReadingPlace | null>(null);
  const folder = FolderPath.safeParse(folderText).success ? FolderPath.parse(folderText) : null;

  const [folderError, setFolderError] = useState<string | null>(null);
  const [openFailure, setOpenFailure] = useState<OpenFailure | null>(null);
  // The sidebar starts a New chat before the history controller opens it: its state shows here meanwhile.
  const [newChat, setNewChat] = useState<NewChatStatus>({ state: "idle" });
  const [recentFolders, setRecentFolders] = useState<readonly FolderPath[]>([]);
  const sessionFiles = useMemo(() => client.port(SessionFileStore), [client]);
  const rpc = useMemo(() => client.port(RpcSessionPort), [client]);
  // One catalog per folder for the life of the connection: going back to a folder shows its last
  // list at once, and a new connection starts clean.
  const catalogCache = useMemo(
    () => ({ sessionFiles, models: new Map<FolderPath, SessionCatalogModel>() }),
    [sessionFiles],
  );
  const catalog = useMemo(() => {
    if (!folder) return null;
    const cached = catalogCache.models.get(folder);
    if (cached) return cached;
    const created = new SessionCatalogModel({
      scope: { kind: "folder", folder },
      sessionFiles: {
        listSessions: catalogCache.sessionFiles.listSessions,
        readSession: catalogCache.sessionFiles.readSession,
      },
    });
    catalogCache.models.set(folder, created);
    return created;
  }, [catalogCache, folder]);
  const controller = useMemo<SelectedThreadHistoryController | null>(() => {
    if (!folder) return null;
    // The open folder's list is read again, so each row shows the state its chat has now.
    const readList = () => {
      const list = catalogCache.models.get(folder);
      if (list)
        void list.list({ filter: list.getSnapshot().filter, limit: 100 }).catch(() => undefined);
    };
    return createSelectedThreadHistoryController({
      client,
      folder,
      onThreadIdChange: (threadId) =>
        writeSessionValue(THREAD_KEY, threadId ? String(threadId) : null),
      // A chat left while its turn runs: its file is written after the turn starts, so no change event announces the
      // turn. The list is read now, and the row shows the turn as running.
      onLeftRunning: readList,
      // A turn ended after its chat was left: the list gets the row the chat wrote, not when the person comes back.
      onTurnSettled: readList,
    });
  }, [catalogCache, client, folder]);
  // Records a chat whose saved model omp cannot restore. With no chat open, the empty screen shows its sentence and the
  // picker, and the chat is the one this browser had open, so a reload or restart shows it again. With another chat open,
  // that chat stays on screen: the picker opens over it, with the sentence first, and the saved chat id stays the open chat's.
  const reportOpenFailure = useCallback(
    (threadId: ThreadId, error: AppError): void => {
      if (controller && controller.getSnapshot().threadId !== undefined) {
        openSavedChatModelPicker({
          overlay,
          client,
          lead: error.message,
          onPick: (model) => {
            void controller.openExisting(threadId, model).catch(() => undefined);
          },
        });
        return;
      }
      writeSessionValue(THREAD_KEY, String(threadId));
      setOpenFailure({ threadId, error });
    },
    [client, controller, overlay],
  );
  const remote = useMemo(
    () =>
      catalog
        ? createNativeRemoteThreadListAdapter({
            catalog,
            open: rpc.open,
            close: rpc.close,
            rename: rpc.rename,
            deleteThread: (threadId) =>
              deleteChatFile({ threadId, catalog, sessionFiles, close: rpc.close }),
          })
        : null,
    [catalog, rpc.open, rpc.close, rpc.rename, sessionFiles],
  );
  useEffect(() => {
    let active = true;
    void sessionFiles
      .listFolders({ limit: 50 })
      .then((result) => {
        if (active) setRecentFolders(result.folders);
      })
      .catch(() => {
        if (active) setRecentFolders([]);
      });
    return () => {
      active = false;
    };
  }, [sessionFiles]);
  const history = useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.getSnapshot() ?? EMPTY_HISTORY,
    () => controller?.getSnapshot() ?? EMPTY_HISTORY,
  );
  useEffect(() => {
    // Reopen the thread this browser had open in this folder (cleared when the folder changes). A chat nobody has
    // sent to has no file after a restart, so the folder's new chat opens in its place.
    if (!controller) return;
    const saved = ThreadId.safeParse(readSessionValue(THREAD_KEY, ""));
    if (!saved.success) return;
    // A reload returns the reader to the message they were reading. The place is read before the chat opens.
    setResumePlace(readStoredReadingPlace(saved.data));
    void controller
      .reopenSaved(saved.data)
      .catch((error: unknown) => {
        // A saved chat whose model omp can no longer restore stays the chat this browser had open: its screen offers the
        // picker, and a model remembered for the chat was already tried by the history.
        if (error instanceof AppFailure && error.appError.code === "model_unavailable") {
          reportOpenFailure(saved.data, error.appError);
          return;
        }
        writeSessionValue(THREAD_KEY, null);
      })
      .finally(() => setResumePlace(null));
  }, [controller, reportOpenFailure]);
  // The sidebar's list is fetched again after the person's message has been answered: omp writes a
  // new chat's file during its first turn, and a chat's title and time change with each turn. The
  // end of the answer is read from the messages, not from the prompt flags: a page that attaches
  // just after the turn began never sees the flags change, but the answer is there at the end.
  // Opening a chat, which loads its old answers, fetches nothing: only a sent message arms this.
  const turnWatch = useRef<{ armed: boolean; before: number | undefined; started: boolean }>({
    armed: false,
    before: undefined,
    started: false,
  });
  const onPromptSent = useCallback(() => {
    turnWatch.current = {
      armed: true,
      before: finishedAnswerAt(history.store?.getSnapshot()),
      started: false,
    };
  }, [history.store]);
  // Edit and regenerate run state outlives the chat that started a run, because a branch switches chats.
  const p3Runs = useMemo(
    () =>
      createP3Runs({
        onAdmitted: () => {
          turnWatch.current = { armed: true, before: undefined, started: false };
        },
      }),
    [],
  );
  useEffect(() => {
    const store = history.store;
    if (!store || !catalog || !folder) return;
    const look = () => {
      const watch = turnWatch.current;
      if (!watch.armed) return;
      const snapshot = store.getSnapshot();
      const answer = finishedAnswerAt(snapshot);
      // A turn also ends when omp stops under it: its chat's file is on disk by then, so the list has it.
      const answered = answer !== undefined && answer !== watch.before;
      const stopped = snapshot.process.status === "exited";
      const ended = watch.started && !snapshot.prompt.streaming;
      // A turn that has started: a chat with no row yet is listed at once, marked as running, because omp marks the chat
      // running on the server before the page sees its first event. A chat already listed takes its running mark from the
      // server's change events, so it needs no read here.
      const started = !watch.started && snapshot.prompt.streaming;
      if (!answered && !stopped && !ended && !started) return;
      const finished = answered || stopped || ended;
      turnWatch.current = finished
        ? { armed: false, before: undefined, started: false }
        : { ...watch, started: true };
      const listed = catalog
        .getSnapshot()
        .sessions.some((session) => session.id === snapshot.threadId);
      if (finished || !listed) {
        void catalog
          .list({ filter: catalog.getSnapshot().filter, limit: 100 })
          .catch(() => undefined);
      }
    };
    look();
    return store.subscribe(look);
  }, [catalog, folder, history.store]);
  useEffect(() => {
    const instanceId = client.instanceId;
    if (connection.state !== "connected" || instanceId === undefined) return;
    if (lastInstanceId.current === undefined) {
      lastInstanceId.current = instanceId;
      return;
    }
    if (lastInstanceId.current === instanceId) return;
    lastInstanceId.current = instanceId;
    if (controller && history.threadId)
      void controller.openExisting(history.threadId).catch(() => undefined);
  }, [client.instanceId, connection.state, controller, history.threadId]);
  // A chat's turn starting or settling changes its row. The server names the chat, and each open folder's list reads it again.
  useEffect(
    () =>
      watchSessionFileChanges(client, (change) => {
        for (const list of catalogCache.models.values()) void list.reconcile(change);
      }),
    [catalogCache, client],
  );
  // A list that failed while the connection was down is loaded again once the app is back.
  useEffect(() => {
    if (connection.state !== "connected" || catalog === null) return;
    const current = catalog.getSnapshot();
    if (current.error === null) return;
    void catalog.list({ filter: current.filter, limit: 50 }).catch(() => undefined);
  }, [catalog, connection.state]);
  const activeCapabilities = useMemo(
    () => (history.capabilities ? { ...capabilities, ...history.capabilities } : capabilities),
    [capabilities, history.capabilities],
  );
  const title = useSessionTitle(catalog, history.threadId);
  const selectFolder = (nextFolder: FolderPath): void => {
    if (nextFolder === folder) return;
    void controller?.close();
    setFolderError(null);
    setFolderText(nextFolder);
    writeSessionValue(FOLDER_KEY, nextFolder);
    writeSessionValue(THREAD_KEY, null);
  };
  const validateOtherFolder = async (value: string): Promise<boolean> => {
    const parsed = FolderPath.safeParse(value.trim());
    if (!parsed.success) {
      setFolderError("Enter an absolute folder path.");
      return false;
    }
    try {
      await client.port(HostMetadataPort).read({ folder: parsed.data });
      selectFolder(parsed.data);
      return true;
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Folder is unavailable.");
      return false;
    }
  };
  // Opens a chat through the history. A chat whose saved model omp cannot restore is recorded with its id, so the
  // empty screen offers the model picker for that chat, and a model picked there opens that chat with it.
  const openHistoryChat = useCallback(
    async (threadId: ThreadId, model?: ModelChoice): Promise<void> => {
      if (!controller) {
        throw new AppFailure({
          code: "unavailable",
          message: "Opening a session requires a selected workspace folder.",
          retryable: false,
          capability: "host.session-files",
        });
      }
      try {
        await controller.openExisting(threadId, model);
      } catch (error) {
        if (error instanceof AppFailure && error.appError.code === "model_unavailable") {
          reportOpenFailure(threadId, error.appError);
        }
        throw error;
      }
      setOpenFailure(null);
    },
    [controller, reportOpenFailure],
  );
  const openThread = useCallback(
    (threadId: ThreadId): Promise<void> => openHistoryChat(threadId),
    [openHistoryChat],
  );
  // The sidebar's New chat holds the chat switch from its first step until its chat is open, so a send made meanwhile
  // waits for the new chat instead of going to the chat before it.
  const newChatHold = useRef<(() => void) | undefined>(undefined);
  const reportNewChat = useCallback(
    (status: NewChatStatus): void => {
      setNewChat(status);
      if (status.state === "opening") {
        newChatHold.current ??= controller?.holdSwitch();
        return;
      }
      newChatHold.current?.();
      newChatHold.current = undefined;
    },
    [controller],
  );
  // The chat on screen registers how a send reaches it: the view that shows the open chat (see `deliverToOpenChat`).
  const liveChat = useRef<{
    readonly threadId: ThreadId;
    readonly deliver: (intent: PromptIntent) => Promise<void>;
  } | null>(null);
  const liveChatChanged = useRef<Array<() => void>>([]);
  const registerLiveChat = useCallback(
    (threadId: ThreadId, deliver: (intent: PromptIntent) => Promise<void>): (() => void) => {
      const live = { threadId, deliver };
      liveChat.current = live;
      const waiters = liveChatChanged.current;
      liveChatChanged.current = [];
      for (const wake of waiters) wake();
      return () => {
        if (liveChat.current === live) liveChat.current = null;
      };
    },
    [],
  );
  // A send goes to the chat that is open when it is delivered, through the view that shows it. While a chat is still
  // opening, the send waits until that chat is on screen: it is never written to the chat before it. If the chat did
  // not open, nothing is sent and the text stays in the composer.
  const deliverToOpenChat = useCallback(
    async (intent: PromptIntent): Promise<void> => {
      if (controller === null) {
        throw new AppFailure({
          code: "unavailable",
          message: "Open a chat to send a message.",
          retryable: false,
        });
      }
      for (;;) {
        await controller.whenSettled();
        const open = controller.getSnapshot().threadId;
        if (open === undefined) {
          throw new AppFailure({
            code: "unavailable",
            message: "The chat did not open, so the message was not sent. Try again.",
            retryable: true,
          });
        }
        const live = liveChat.current;
        if (live !== null && live.threadId === open) return live.deliver(intent);
        await new Promise<void>((wake) => {
          liveChatChanged.current.push(wake);
        });
      }
    },
    [controller],
  );
  // A new chat, started the way the sidebar's New chat starts one. Sign-in runs in a chat's omp, so this gives
  // sign-in one when no chat is open.
  const startChat = useCallback(async (): Promise<ThreadId> => {
    if (remote === null) {
      throw new AppFailure({
        code: "unavailable",
        message: "Starting a chat needs a selected workspace folder.",
        retryable: false,
      });
    }
    const initialized = await remote.initialize("new");
    const started = initialized.remoteId as ThreadId;
    await openThread(started);
    return started;
  }, [openThread, remote]);
  const openSettings = useCallback(
    (threadId: ThreadId | null, restoreFocus?: HTMLElement) => {
      overlay.open({
        kind: "modal",
        label: "Settings",
        ...(restoreFocus === undefined ? {} : { restoreFocus }),
        width: "viewport",
        className: SETTINGS_FRAME_CLASS,
        content: ({ close, requestClose, update }) => (
          <SettingsScreen
            capabilities={capabilities}
            client={client}
            folder={folder}
            threadId={threadId}
            onClose={() => requestClose()}
            onUnsavedChange={(unsavedChanges) => update({ unsavedChanges })}
            onStartChat={async () => {
              const started = await startChat();
              close("programmatic");
              openProviderSignIn({ overlay, client, threadId: started, capabilities });
            }}
          />
        ),
      });
    },
    [capabilities, client, folder, overlay, startChat],
  );
  // The palette's commands with no chat open (see `idleCommandHandlers`). Once a chat opens, its own host takes over.
  const idleHandlers = useMemo(
    () =>
      idleCommandHandlers({
        newChat: async () => {
          await startChat();
        },
        openSettings: () => openSettings(null),
        setTheme: setThemePreference,
      }),
    [openSettings, startChat],
  );
  // What each sidebar surface id renders. Where it goes: `@/layout` (LAYOUT).
  const sidebarSurfaces: SurfaceMap = {
    folder: {
      title: "Workspace folder",
      render: () => (
        <FolderSwitcher
          error={folderError}
          folder={folder}
          onFolderChange={selectFolder}
          onOtherFolder={validateOtherFolder}
          recentFolders={[launchFolder, ...recentFolders]}
        />
      ),
    },
    sessions: {
      title: "Sessions",
      grow: true,
      render: () =>
        catalog && remote ? (
          <SessionCatalogSidebar
            catalog={catalog}
            currentThreadId={history.threadId}
            onNewChat={openThread}
            onOpenThread={openThread}
            confirmDelete={(_session, title) => openChatDeleteConfirm(overlay, title)}
            currentTurnRunning={() =>
              controller?.getSnapshot().store?.getSnapshot().prompt.streaming === true
            }
            remote={remote}
            onNewChatStatus={reportNewChat}
            onOpenFailed={reportOpenFailure}
          />
        ) : null,
    },
    theme: { title: "Theme", render: () => <ThemeButton /> },
  };
  const leftSidebar = (
    <LayoutArea area="sidebar" capabilities={capabilities} surfaces={sidebarSurfaces} />
  );
  const emptyHeaderSurfaces: SurfaceMap = {
    title: {
      title: "Conversation",
      grow: true,
      render: () => (
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">omp</h1>
          <p className="text-muted-foreground truncate text-xs">New conversation</p>
        </div>
      ),
    },
    settings: {
      title: "Settings",
      render: () => <SettingsButton onOpenSettings={openSettings} threadId={null} />,
    },
  };

  // The connection banner: an open chat shows it in its footer, the empty shell at the bottom of its transcript.
  const connectionSurface: Surface = {
    title: "Connection",
    open: connection.state === "reconnecting",
    render: () => <ConnectionBanner unreachable={connection.unreachable} />,
  };
  // The watch notice: while the server cannot watch some files, changes made outside the app do not show yet.
  const watchSurface: Surface = {
    title: "Watched files",
    open: watchNotice !== undefined,
    render: () => (watchNotice === undefined ? null : <WatchNotice detail={watchNotice} />),
  };
  const emptyTranscriptSurfaces: SurfaceMap = {
    connection: connectionSurface,
    watchNotice: watchSurface,
  };
  if (history.store && history.threadId) {
    return (
      <ActiveThreadContent
        capabilities={activeCapabilities}
        catalog={catalog}
        client={client}
        folder={folder}
        history={history}
        resumePlace={resumePlace}
        connectionSurface={connectionSurface}
        watchSurface={watchSurface}
        onLoadOlder={controller === null ? undefined : () => controller.loadOlder()}
        onLoadFullOutput={controller === null ? undefined : (id) => controller.loadFullOutput(id)}
        onRefreshAfterCommand={
          controller === null ? undefined : () => controller.refreshAfterCommand()
        }
        leftSidebar={leftSidebar}
        onOpenSettings={openSettings}
        onPromptSent={onPromptSent}
        openThread={openThread}
        deliverToOpenChat={deliverToOpenChat}
        registerLiveChat={registerLiveChat}
        remote={remote}
        title={title}
        p3Runs={p3Runs}
      />
    );
  }
  const emptyError =
    history.error ??
    (newChat.state === "failed" ? newChat.error : null) ??
    openFailure?.error ??
    null;
  const emptyCopy = emptyStateCopy({
    opening: history.isLoading || newChat.state === "opening",
    error: emptyError,
  });
  // A saved chat whose model omp cannot restore gets the picker; picking a model opens that chat with it.
  const savedModelThreadId =
    controller && emptyError?.code === "model_unavailable" ? openFailure?.threadId : undefined;
  const savedModelAction =
    savedModelThreadId === undefined ? undefined : (
      <Button
        onClick={() => {
          openSavedChatModelPicker({
            overlay,
            client,
            lead: "Pick a model to open this chat with.",
            onPick: (model) => {
              // The history records a failed open on this screen (history.error), so the rejection is not raised again.
              void openHistoryChat(savedModelThreadId, model).catch(() => undefined);
            },
          });
        }}
        type="button"
      >
        Pick a model
      </Button>
    );
  return (
    <div className="h-dvh" data-app-root="true">
      <CommandPaletteHost capabilities={capabilities} handlers={idleHandlers} />
      <AppShell
        composer={
          emptyCopy.composer === null ? undefined : (
            <ComposerNote>{emptyCopy.composer}</ComposerNote>
          )
        }
        threadHeader={
          <LayoutArea area="header" capabilities={capabilities} surfaces={emptyHeaderSurfaces} />
        }
        leftSidebar={leftSidebar}
        rightSidebar={<div className="text-muted-foreground p-4 text-sm">No panel selected.</div>}
        transcript={
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <EmptyTranscript action={savedModelAction} copy={emptyCopy} />
            </div>
            <div className="border-border bg-background border-t px-6 py-2 empty:hidden">
              <LayoutArea
                area="threadFooter"
                capabilities={capabilities}
                surfaces={emptyTranscriptSurfaces}
              />
            </div>
          </div>
        }
      />
    </div>
  );
}

function ConnectedRoot() {
  const connection = useAppConnection();
  const client = connection.client;
  const [capabilities, setCapabilities] = useState<CapabilityMap>(EMPTY_CAPABILITIES);
  const [serverInfo, setServerInfo] = useState<AppServerInfo>();
  const [health, setHealth] = useState<AppHealth>();
  const [startFailed, setStartFailed] = useState(false);
  const shortcutPreferences = useMemo<PreferenceStore>(
    () => ({
      get: (key) => window.localStorage.getItem(key) ?? undefined,
      set: (key, value) => window.localStorage.setItem(key, value),
      delete: (key) => window.localStorage.removeItem(key),
    }),
    [],
  );
  useEffect(() => {
    if (!client) return;
    let active = true;
    const app = client.port(AppPort);
    // From here on, errors in the page land in the app's debug log next to the server's own lines.
    setClientErrorSink((report) => app.reportClientError(report));
    setStartFailed(false);
    void Promise.all([app.capabilities({}), app.serverInfo({}), app.health({})])
      .then(([nextCapabilities, nextServerInfo, nextHealth]) => {
        if (!active) return;
        rememberLogFile(nextServerInfo.logFile);
        setCapabilities(nextCapabilities);
        setHealth(nextHealth);
        setServerInfo(nextServerInfo);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // A blank page would say nothing: show what happened, and leave a line in the log.
        reportClientError({
          kind: "error",
          message: `The app server's first answers failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        setStartFailed(true);
      });
    return () => {
      active = false;
      setClientErrorSink(undefined);
    };
  }, [client]);
  // The page reads the server's watches now and then, so the notice shows and clears while the app runs.
  const readHealth = useMemo(
    () => (client ? () => client.port(AppPort).health({}) : undefined),
    [client],
  );
  const watchNotice = useWatchNotice(readHealth);
  if (client && !serverInfo && startFailed) {
    return (
      <LaunchStatusScreen
        reason="The app server is running but did not answer the page's first questions. Reload the page; if it happens again, attach the app's log to a bug report."
        state="closed"
      />
    );
  }
  if (!client || !serverInfo) return null;
  // Without omp no chat can open or start: say so, instead of showing an app that fails silently.
  if (serverInfo.omp === null)
    return <OmpUnavailableScreen noModel={health?.code === "no_model"} reason={health?.detail} />;
  return (
    <ToolRendererResolverContext.Provider value={resolveToolRenderer}>
      <RegistryProvider capabilities={capabilities} registry={registry} renderers={RENDERERS}>
        <ShortcutRegistryProvider descriptors={DESCRIPTORS} preferenceStore={shortcutPreferences}>
          <ShortcutSheetHost>
            <OverlayHost>
              <ConnectedApp
                capabilities={capabilities}
                client={client}
                launchFolder={serverInfo.launchFolder}
                watchNotice={watchNotice}
              />
            </OverlayHost>
          </ShortcutSheetHost>
        </ShortcutRegistryProvider>
      </RegistryProvider>
    </ToolRendererResolverContext.Provider>
  );
}

export function AppRoot() {
  return (
    <AppConnectionProvider>
      <ThemeApplier />
      <AccessibilityProvider>
        <AppConnectionGate>
          <ConnectedRoot />
        </AppConnectionGate>
      </AccessibilityProvider>
    </AppConnectionProvider>
  );
}

import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import {
  type AppError,
  AppFailure,
  AppPort,
  AttachmentBlobStore,
  type CapabilityMap,
  type DescriptorId,
  DraftScope,
  EntryId,
  FolderPath,
  type HostCallId,
  HostMetadataPort,
  MAX_ATTACHMENT_BYTES,
  McpCommandsPort,
  type ModelChoice,
  OmpCommandGateway,
  type OmpWire,
  PasteFileStore,
  ProviderErrorPort,
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
import { startWorkerStream } from "@/app/agents/thread-agents";
import { TaskSubagentsScope, useThreadAgents } from "@/app/agents/thread-agents-scope";
import { RevealCommandOutput, useCommandReport } from "@/app/command-report/command-report";
import { type OpenFailure, openFailureIn } from "@/app/open-failure";
import {
  deliverNoteWhenOpen,
  type NoSwitchNote,
  showNoSwitchNote,
} from "@/app/rewind/no-switch-notice";
import { conversationBusy } from "@/app/rewind/rewind-tree";
import { useConversationTransitions } from "@/app/rewind/use-conversation-transitions";
import { useRewindPanel } from "@/app/rewind/use-rewind-panel";
import { ToolRunScope } from "@/app/tool-run-scope";
import { Notice } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import {
  AppConnectionGate,
  AppConnectionProvider,
  ConnectionBanner,
  LaunchStatusScreen,
  OmpUnavailableScreen,
  SEND_BLOCKED_TEXT,
  useAppConnection,
  useFirstAnswers,
  useWatchNotice,
  WatchNotice,
} from "@/launch";
import { LayoutArea, type LayoutAreaName, type Surface, type SurfaceMap } from "@/layout";
import { useSlashTip } from "@/modules/D2/slash/tip";
import type { CredentialActions } from "@/modules/D3/auth/credential-actions";
import { readProviderSignIns } from "@/modules/D3/auth/sign-in";
import { D3_LOGIN_COMMAND } from "@/modules/D3/descriptors";
import { SHARE_IMPORT_UNAVAILABLE_REASON, useImportFromShare } from "@/modules/D4/fork";
import { runShareCommand } from "@/modules/D4/share";
import type {
  SessionCapabilitiesSource,
  SessionInfoMetadataSource,
  SessionInfoRuntimeSource,
} from "@/modules/D5/contract";
import { SessionLifecycleController } from "@/modules/D5/lifecycle";
import { createDiagnosticCommandPort, ReportsPanel } from "@/modules/D6/reports";
import { SecurityReportPanel } from "@/modules/D6/security";
import { FAST_REFUSAL_NOTICE_SOURCE } from "@/modules/D7/modes";
import { createRuleStoreAdapter } from "@/modules/I3/ports";
import { RulesPanel, useRulesController } from "@/modules/I3/rules";
import { useLiveVoiceSurfaces } from "@/modules/I5/live";
import {
  NotificationFeedback,
  NotificationNotices,
  transcriptNoticeSource,
} from "@/modules/N1/feedback";
import { NotificationProjector, sessionRetiredNotices } from "@/modules/N1/notifications";
import { StatusSegments } from "@/modules/N1/status";
import {
  createP3Runs,
  endNoticeOnPrompt,
  lastSavedUserEntryId,
  P3EditSurface,
  type P3EditTarget,
  P3MessageActions,
  P3RunStatusSurface,
  type P3Runs,
  p3EditTargetFromSelection,
  useP3RunHandlers,
} from "@/modules/P3/runs";
import { captureP3EditSource } from "@/modules/P3/runs/source";
import {
  type P3PreviousMessageSelectorControllerModel,
  PreviousMessageSelectorView,
  useP3PreviousMessageSelectorController,
} from "@/modules/P3/selector";
import { BranchSummaryRow, branchSummaryOfRow } from "@/modules/P3/summary";
import { QueueLaneBar, useQueueOpen } from "@/modules/P6/bar/bar";
import { resolveQueueSubmitPolicy } from "@/modules/P6/composer/composer";
import { createQueueAdapter } from "@/modules/P6/contract";
import {
  CacheMissRow,
  CompactionSummaryRow,
  compactionSummaryOfRow,
} from "@/modules/P7/compaction";
import { createQueueController, type QueueController } from "@/modules/R0/actions";
import { type StoppedQueue, useOmpRuntime } from "@/modules/R0/runtime";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store";
import { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import {
  createSessionCatalogRefreshScheduler,
  watchSessionFileChanges,
  watchSessionRunningChanges,
} from "@/modules/R1/catalog/session-changes";
import {
  createSelectedThreadHistoryController,
  HistoryLoadFailureNotice,
  type SelectedThreadHistoryController,
  type SelectedThreadHistoryState,
} from "@/modules/R1/history";
import { createNativeRemoteThreadListAdapter, deleteChatFile } from "@/modules/R1/remote";
import { type NewChatStatus, SessionCatalogSidebar } from "@/modules/R1/ui";
import { LateDiagnosticsCard } from "@/modules/T2/late-diagnostics";
import { MessageParts } from "@/modules/U1/parts";
import { ProviderErrorResolverProvider } from "@/modules/U1/parts/provider-error-resolver";
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
import { type ThreadRowSlots, ThreadShell, TurnCancelScope } from "@/modules/U1/thread";
import { type ToolRendererResolver, ToolRendererResolverContext } from "@/modules/U1/tool-slots";
import {
  AttachmentChips,
  AttachmentManager,
  attachmentHoldReason,
  withPastedText,
} from "@/modules/U2/attachments";
import { createAttachmentBlobStore } from "@/modules/U2/attachments/blob-store";
import { ComposerSurface } from "@/modules/U2/composer";
import type {
  AttachmentAdapter,
  DraftRestoreRequest,
  PromptIntent,
  SubmitPolicy,
} from "@/modules/U2/contract";
import {
  type ChatMessagesSource,
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
import { openDestructiveCommandConfirm } from "@/modules/U4/dialogs/confirm-destructive-command";
import { DialogHostController, useDisposeWhenReplaced } from "@/modules/U4/host";
import {
  ExtensionUiRequestRouterController,
  optIntoRichAsk,
  richAskOffered,
  subscribeNonModalExtensionUi,
} from "@/modules/U4/router";
import type { PanelFocusToken } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import { TodoChecklist } from "@/modules/U5/todo/checklist/checklist";
import { projectTodoSnapshot } from "@/modules/U5/todo/model";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import { type CommandPaletteHandler, CommandPaletteHost } from "@/palette";
import { U0_SHORTCUT_SHEET_COMMAND } from "@/palette/descriptor";
import { idleCommandHandlers } from "@/palette/idle-commands";
import { DESCRIPTORS, RENDERERS, registry, TOOL_RENDERERS } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { AppShell, ComposerNote, useRightSidebar } from "@/shell";
import {
  type PreferenceStore,
  ShortcutPreferenceNotice,
  ShortcutRegistryProvider,
  ShortcutSheetHost,
  useShortcutPreferenceError,
  useShortcutRegistry,
} from "@/shortcuts";
import { setThemePreference, ThemeApplier, ThemeButton } from "@/theme";
import { Icons } from "@/tokens";
import { type AgentHubOpenResult, useAgentHubShortcut } from "./agents/agent-hub-shortcut";
import { reportClientError, setClientErrorSink } from "./client-errors";
import { watchSavedCompactions } from "./compaction-watch";
import { useComposerClipboardShortcuts } from "./composer-clipboard";
import { useComposerEditingShortcuts } from "./composer-editing";
import { ComposerHistory } from "./composer-history";
import { composerInput } from "./composer-input";
import { ComposerTriggers } from "./composer-triggers";
import { SessionContextPanel } from "./context-panel";
import { browserClipboard, runCopyFromChat, useCopyFromChat } from "./copy/use-copy-from-chat";
import { reportDraftFailure, useComposerDraftOwner } from "./draft-owner";
import { type EmptyStateCopy, emptyStateCopy } from "./empty-state";
import { useExecutionModesSurface } from "./execution-modes";
import { exportSlashCommandsFor } from "./export/export-commands";
import {
  ExternalEditorDialog,
  type ExternalEditRequest,
  useExternalEditorShortcut,
} from "./external-editor-dialog";
import { FolderSwitcher } from "./folder-switcher";
import { HistorySearchDialog, useHistorySearchShortcut } from "./history-search-dialog";
import { LargePasteMenuProvider } from "./large-paste-menu";
import { type NewChatOutcome, type NewChatTicket, openNewChatTicket } from "./new-chat-outcome";
import { deliverWhenChatOpen } from "./open-chat-delivery";
import { useChatSessionInfo, useChatTodoStore } from "./owned-stores";
import { useRetryShortcut } from "./p3-retry-shortcut";
import { installPerfTrace, perfMark, perfTraceEnabled, perfTraceStart } from "./perf-trace";
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
  storeQueueImages,
  storeRestoredImages,
} from "./queue-stop-saved-draft";
import { saveTextFile } from "./save-file";
import { openSavedChatModelPicker } from "./saved-chat-model-picker";
import { openSessionModelDialog, SessionModelControl, SessionStatusBar } from "./session-controls";
import { useSessionModelShortcuts } from "./session-model-shortcuts";
import { useSessionTitle } from "./session-title";
import { createSettingsClosedSignal } from "./settings-closed-signal";
import { SettingsScreen } from "./settings-screen";
import { useShareFromChat } from "./share/use-share-from-chat";
import {
  agentHubSlashCommand,
  askFirstSlashCommands,
  branchSlashCommand,
  clearSlashCommand,
  copySlashCommand,
  forkSlashCommand,
  freshSlashCommand,
  guardOmpSend,
  type HistoryPanel,
  hotkeysSlashCommand,
  loginSlashCommand,
  mcpReloadSlashCommand,
  newChatSlashCommand,
  restartQuestion,
  restartSlashCommand,
  routeSubmit,
  runSlashRoute,
  settingsSlashCommand,
  shareSlashCommand,
  treeSlashCommand,
  useSlashCommands,
} from "./slash-commands";
import { finishedAnswerAt } from "./turn-end";
import { useGoalCommands } from "./use-goal-command";
import {
  createLastUserVersions,
  type LastUserVersions,
  useOtherVersions,
} from "./use-other-versions";

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
  isSwitching: false,
  error: null,
  openedNew: false,
};
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
  // The page keeps one projector for its life, and each chat has its own store: the projector follows the store of the
  // chat on screen (`NotificationProjector.follow`), so the chat's events and state are the ones it projects.
  useLayoutEffect(() => {
    projectorRef.current?.follow(store);
  }, [store]);
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
/** Runs `onExit` when its content leaves the screen: the overlay around it has closed, however it was closed. */
function RunOnExit({
  onExit,
  children,
}: {
  readonly onExit: () => void;
  readonly children: ReactNode;
}) {
  const latest = useRef(onExit);
  useEffect(() => {
    latest.current = onExit;
  }, [onExit]);
  useEffect(() => () => latest.current(), []);
  return <>{children}</>;
}

function SettingsButton({
  onOpenSettings,
  threadId,
}: {
  readonly onOpenSettings: (threadId: ThreadId | null) => void;
  readonly threadId: ThreadId | null;
}) {
  return (
    <Button
      aria-label="Settings"
      className="text-muted-foreground hover:text-foreground rounded-control grid size-7 place-items-center transition-colors"
      title="Settings"
      type="button"
      variant="ghost"
      onClick={() => onOpenSettings(threadId)}
    >
      <Icons.settings aria-hidden="true" className="size-4" />
      <span className="sr-only">Settings</span>
    </Button>
  );
}

function EmptyTranscript({
  copy,
  action,
}: {
  readonly copy: EmptyStateCopy;
  readonly action?: ReactNode;
}) {
  return (
    <div
      className="mx-auto flex h-full w-full max-w-(--layout-thread-width) flex-col items-center justify-center px-6 py-12 text-center"
      role="status"
    >
      <p
        className="font-display text-2xl leading-snug font-[550] tracking-[-0.01em] text-balance lg:text-[1.75rem]"
        title={copy.title}
      >
        {copy.title}
      </p>
      <p className="text-muted-foreground mt-2 max-w-[40ch] text-md leading-relaxed text-pretty">
        {copy.detail}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
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
  voice,
  footer,
  footerOpen,
  editing,
  manager,
  onRetry,
  onResolve,
  sendBlockedReason,
  onDoubleLeftArrow,
  savePasteFile,
  placeholder,
}: {
  readonly controller: DraftController;
  /** The chat the draft belongs to (see `useChatDraft`): a different one once the person switches chats. */
  readonly chat: object;
  readonly capabilities: CapabilityMap;
  readonly submit: (intent: PromptIntent) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly policy: SubmitPolicy;
  readonly toolbar: ReactNode;
  readonly voice: ReactNode;
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
  /** Saves a large paste's full text as a file the chat's agent reads; the composer puts the reference in the box. */
  readonly savePasteFile?: (text: string) => Promise<string>;
  readonly placeholder: string | undefined;
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
  // assistant-ui keeps its own composer attachment list in the runtime. Clear that list when the draft owner changes,
  // before a New chat can submit it; U2's attachment manager is restored separately by useComposerDraft.
  const previousChat = useRef(chat);
  useEffect(() => {
    if (previousChat.current === chat) return;
    previousChat.current = chat;
    void aui.composer.reset();
  }, [aui.composer, chat]);
  return (
    <ComposerSurface
      capabilities={capabilities}
      cancel={cancel}
      disabled={snapshot.status === "error"}
      replaced={editing}
      attachmentManager={manager}
      policy={policy}
      attachmentHoldReason={attachmentHoldReason(attachmentState)}
      sendBlockedReason={sendBlockedReason}
      submitPrompt={submit}
      savePasteFile={savePasteFile}
      toolbar={toolbar}
      voice={voice}
      onDoubleLeftArrow={onDoubleLeftArrow}
      placeholder={placeholder}
    >
      <DraftNotice
        onResolve={onResolve}
        onResolveReplaced={(choice) => controller.resolveReplaced(choice)}
        onRetry={onRetry}
        snapshot={snapshot}
      />
      {footerOpen ? footer : null}
    </ComposerSurface>
  );
}

/** The attachments a send carries, read when Enter is pressed in the composer that holds them (see `submit` in the view). */
interface SendAttachments {
  readonly refs: NonNullable<PromptIntent["attachmentRefs"]>;
  readonly complete: Parameters<typeof withPastedText>[1];
}

interface ActiveThreadProps {
  readonly deliverToOpenChat: (
    intent: PromptIntent,
    attachments: SendAttachments,
    newChatEnd: Promise<NewChatOutcome> | null,
    keptInNewChat: boolean,
  ) => Promise<void>;
  readonly newChatOutcomeNow: () => Promise<NewChatOutcome> | null;
  readonly registerLiveChat: (
    threadId: ThreadId,
    deliver: (intent: PromptIntent, attachments: SendAttachments) => Promise<void>,
    notice?: (note: NoSwitchNote) => void,
  ) => () => void;
  /** Writes a rewind's or fork's note into the chat on screen, when it finished without switching the view. */
  readonly deliverNote: (note: NoSwitchNote) => void;
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly history: SelectedThreadHistoryState;
  /** A brand-new chat with no saved session: its empty surface is centered even while omp starts. */
  readonly newChat: boolean;
  /** A New chat started from the chat on screen has not replaced it yet: the composer's draft is the folder's new-chat draft. */
  readonly newChatStarting: boolean;
  /** Loads the page of messages older than the ones shown; the thread offers it while history is older. */
  readonly onLoadOlder?: () => Promise<void>;
  /** Loads the full text of a tool output the thread shows shortened. */
  readonly onLoadFullOutput?: (toolCallId: string) => Promise<void>;
  /** Brings the open thread up to date after a command omp saved without a turn: a `!` command, or a compaction. */
  readonly onRefreshAfterCommand?: () => Promise<void>;
  /** Retries the selected chat's initial history after a restart read fails. */
  readonly onRetryHistory: () => Promise<void>;
  readonly capabilities: CapabilityMap;
  readonly folder: FolderPath | null;
  readonly catalog: SessionCatalogModel | null;
  readonly onOpenSettings: (threadId: ThreadId | null, restoreFocus?: HTMLElement) => void;
  readonly remote: ReturnType<typeof createNativeRemoteThreadListAdapter> | null;
  /** Called when the person sends a message (the sidebar's list is fetched again once it is answered). */
  readonly onPromptSent: () => void;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
  /** Switches to a chat a branch or a rewind made: it is opened again, whatever its id names (PR 1645). */
  readonly switchChat: (threadId: ThreadId) => Promise<void>;
  readonly pickCount: () => number;
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

const NO_MESSAGE_ORDER = { messageOrder: [] as readonly string[] };
/** The messages of a chat that is not open yet: none, so a New chat starting keeps its draft in the folder's. */
const NO_CHAT_MESSAGES: ChatMessagesSource = {
  subscribe: () => () => undefined,
  getSnapshot: () => NO_MESSAGE_ORDER,
};

/** The status bar's unexpected read failures go to the debug log; the bar itself shows nothing for them. */
function reportStatusFailure(error: unknown): void {
  reportClientError({
    kind: "error",
    message: `The status bar could not read the workspace: ${error instanceof Error ? error.message : "unknown error"}`,
  });
}

function ActiveThreadContent(props: ActiveThreadProps) {
  if (!props.history.store || !props.history.threadId) return null;
  return <ActiveThreadReady {...props} />;
}
function FocusDiagnosticPanelOnReveal({
  open,
  reveal,
  title,
}: {
  readonly open: boolean;
  readonly reveal: number;
  readonly title: string;
}) {
  const sidebar = useRightSidebar();
  const focusedReveal = useRef<number | null>(null);
  useEffect(() => {
    if (open && sidebar !== null && !sidebar.open) sidebar.show();
  }, [open, sidebar]);
  useEffect(() => {
    if (!open || sidebar?.open === false || focusedReveal.current === reveal) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const composer = composerInput();
      if (active !== document.body && active !== composer) return;
      if (active === composer && composer instanceof HTMLTextAreaElement && composer.value !== "")
        return;
      const panel = Array.from(
        document.querySelectorAll<HTMLElement>('[data-panel-open="true"]'),
      ).find((candidate) => candidate.querySelector("h2")?.textContent?.trim() === title);
      const target = panel?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (target === null || target === undefined) return;
      focusedReveal.current = reveal;
      target.focus({ preventScroll: true });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [open, reveal, sidebar?.open, title]);
  return null;
}

/** The records of one store snapshot by row id, each with its saved entry: the answer `storedEntryId` gives, built once per snapshot. */
const savedEntryIndexes = new WeakMap<RuntimeSnapshot, ReadonlyMap<string, EntryId | undefined>>();

function savedEntryIndex(snapshot: RuntimeSnapshot): ReadonlyMap<string, EntryId | undefined> {
  const cached = savedEntryIndexes.get(snapshot);
  if (cached !== undefined) return cached;
  const index = new Map<string, EntryId | undefined>();
  for (const key of snapshot.messageOrder) {
    const record = snapshot.messages[key];
    if (record === undefined) continue;
    if (!index.has(record.key)) index.set(record.key, record.entryId);
    if (record.rowKey !== undefined && !index.has(record.rowKey)) {
      index.set(record.rowKey, record.entryId);
    }
  }
  savedEntryIndexes.set(snapshot, index);
  return index;
}

/** The entry the store saved for one row, or null. Read at each store change, so a row sees an entry saved after it was drawn. */
function savedEntryOf(snapshot: RuntimeSnapshot, rowId: string): EntryId | null {
  const entryId = savedEntryIndex(snapshot).get(rowId);
  return entryId !== undefined && snapshot.transcript.entries[entryId] !== undefined
    ? entryId
    : null;
}

/**
 * One row's actions. The row's saved entry is read from the store at each change, so an entry saved after the row was
 * drawn shows its actions at once, and the row itself is not drawn again for it. The version switcher is read from the
 * chat's last user message (see `createLastUserVersions`).
 */
function RowActions({
  rowId,
  role,
  store,
  versions,
  onEdit,
  onOpenOtherVersion,
}: {
  readonly rowId: string;
  readonly role: string;
  readonly store: OmpRuntimeStore;
  readonly versions: LastUserVersions;
  readonly onEdit: (entryId: EntryId, trigger: HTMLButtonElement) => void;
  readonly onOpenOtherVersion: (threadId: ThreadId) => void;
}) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const entryId = useSyncExternalStore(subscribe, () => savedEntryOf(store.getSnapshot(), rowId));
  const otherVersions = useSyncExternalStore(versions.subscribe, () =>
    entryId === null ? undefined : versions.versionsFor(entryId),
  );
  if (entryId === null) return null;
  return (
    <P3MessageActions
      onEdit={role === "user" ? (trigger) => onEdit(entryId, trigger) : undefined}
      onOpenOtherVersion={onOpenOtherVersion}
      otherVersions={otherVersions}
    />
  );
}

function RuntimeAwarePreviousMessageSelector({
  controller,
}: {
  readonly controller: P3PreviousMessageSelectorControllerModel;
}) {
  const running = useAuiState((state) => state.thread.isRunning);
  const onRunningChange = controller.onRunningChange;
  useLayoutEffect(() => {
    onRunningChange(running);
  }, [onRunningChange, running]);
  return (
    <PreviousMessageSelectorView
      actions={controller.actions}
      running={running}
      viewModel={controller.viewModel}
    />
  );
}

function ActiveThreadReady({
  client,
  capabilities,
  folder,
  catalog,
  history,
  newChat,
  newChatStarting,
  leftSidebar,
  onPromptSent,
  openThread,
  switchChat,
  pickCount,
  deliverNote,
  deliverToOpenChat,
  newChatOutcomeNow,
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
  onRetryHistory,
}: ActiveThreadProps) {
  const store = history.store as OmpRuntimeStore;
  const threadId = history.threadId as ThreadId;
  const slashTip = useSlashTip();
  const otherVersions = useOtherVersions(catalog, threadId);
  const [lastUserVersions] = useState(createLastUserVersions);
  const connection = useAppConnection();
  const providerErrors = useMemo(() => client.port(ProviderErrorPort), [client]);
  const resolveProviderError = useCallback(
    (text: string) => providerErrors.parse({ text }),
    [providerErrors],
  );
  const rpc = useMemo(() => client.port(RpcSessionPort), [client]);
  const guardedSend = useMemo(() => guardOmpSend(rpc.send), [rpc.send]);
  // A prompt the person sends ends a finished run's notice (endNoticeOnPrompt); other sends are unchanged.
  const messageSend = useMemo(
    () => endNoticeOnPrompt(guardedSend, p3Runs.status),
    [guardedSend, p3Runs.status],
  );
  const sessionFiles = useMemo(() => client.port(SessionFileStore), [client]);
  const pasteFiles = useMemo(() => client.port(PasteFileStore), [client]);
  const savePasteFile = useCallback(
    async (text: string) => (await pasteFiles.save({ threadId, text })).reference,
    [pasteFiles, threadId],
  );
  const agents = useThreadAgents({
    threadId,
    store,
    session: rpc,
    files: sessionFiles,
    capabilities,
  });
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === undefined) return;
    setCommandStatus(null);
    setCommandError(null);
  }, [threadId]);
  const [diagnosticPanel, setDiagnosticPanel] = useState<"reports" | "security" | null>(null);
  const [diagnosticPanelOpen, setDiagnosticPanelOpen] = useState(false);
  const [diagnosticPanelReveal, setDiagnosticPanelReveal] = useState(0);
  const diagnosticPort = useMemo(() => createDiagnosticCommandPort(client), [client]);
  const diagnosticFocusToken: PanelFocusToken = `d6-panel-${diagnosticPanelReveal}`;
  const restoreDiagnosticPanelFocus = useCallback(
    (token: PanelFocusToken) => {
      if (token === diagnosticFocusToken) composerInput()?.focus({ preventScroll: true });
    },
    [diagnosticFocusToken],
  );
  const closeDiagnosticPanel = useCallback(() => {
    restoreDiagnosticPanelFocus(diagnosticFocusToken);
    setDiagnosticPanelOpen(false);
    setDiagnosticPanel(null);
  }, [diagnosticFocusToken, restoreDiagnosticPanelFocus]);
  useEffect(() => {
    if (diagnosticPanel !== null) setDiagnosticPanelOpen(true);
  }, [diagnosticPanel]);
  const shortcutPreferenceError = useShortcutPreferenceError();
  // The message being edited, and the row button that opened the editor (focus returns to it on cancel).
  const [editing, setEditing] = useState<P3EditTarget | null>(null);
  // Edit and Regenerate need omp's branch command, and a row omp has saved: a streaming row has no entry yet.
  const branchAvailable = capabilities["omp.cmd.branch"]?.state === "available";
  const currentSnapshot = store.getSnapshot();
  const lastUserEntryId = lastSavedUserEntryId(
    currentSnapshot.messageOrder.map((key) => {
      const row = currentSnapshot.messages[key];
      return {
        role: row?.message.role ?? "",
        entryId:
          row?.entryId !== undefined &&
          currentSnapshot.transcript.entries[row.entryId] !== undefined
            ? row.entryId
            : null,
      };
    }),
  );
  // The last user message and its other versions, published after the chat draws: a layout effect, so no row shows them
  // late. Each row reads its own answer from the store (RowActions), so a change draws two rows, not the transcript.
  useLayoutEffect(() => {
    lastUserVersions.publish(lastUserEntryId, otherVersions);
  }, [lastUserEntryId, lastUserVersions, otherVersions]);
  const rowActions = useCallback(
    (row: { readonly id: string; readonly role: string }): ReactNode => {
      if (!branchAvailable) return undefined;
      return (
        <RowActions
          onEdit={(entryId, trigger) => setEditing({ entryId, trigger })}
          onOpenOtherVersion={(otherThreadId) => void openThread(otherThreadId)}
          role={row.role}
          rowId={row.id}
          store={store}
          versions={lastUserVersions}
        />
      );
    },
    [branchAvailable, lastUserVersions, openThread, store],
  );
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
  // omp saves a `/compact` that finishes in the background without a turn. A1 sends the typed outcome, and the transcript
  // is read again then. The latest refresh is read through a ref, so the subscription is not made again on each render.
  const refreshAfterCommandRef = useRef(onRefreshAfterCommand);
  useLayoutEffect(() => {
    refreshAfterCommandRef.current = onRefreshAfterCommand;
  });
  useEffect(
    () => watchSavedCompactions(client, threadId, () => void refreshAfterCommandRef.current?.()),
    [client, threadId],
  );
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
  const branchMessages = useMemo(
    () => ({
      list: async (requestThreadId: ThreadId, signal?: AbortSignal) => {
        const result = (await rpc.send(
          { threadId: requestThreadId, command: { type: "get_branch_messages" } },
          { signal },
        )) as OmpWire.GetBranchMessagesResult;
        return result.messages.map((message) => ({
          entryId: EntryId.parse(message.entryId),
          text: message.text,
        }));
      },
    }),
    [rpc],
  );
  const selectorController = useP3PreviousMessageSelectorController({
    available:
      capabilities["omp.cmd.get_branch_messages"]?.state === "available" && branchAvailable,
    branchMessages,
    dialogs: dialogHost,
    threadId,
    onCurrentBranch: (entryId) => {
      const snapshot = store.getSnapshot();
      let current = snapshot.transcript.head;
      while (current !== null) {
        if (current === entryId) return true;
        current = snapshot.transcript.entries[current]?.parentId ?? null;
      }
      return false;
    },
    resolveSource: async (message) => captureP3EditSource(store, message.entryId),
    onSelect: (selection) => {
      setEditing(p3EditTargetFromSelection(selection, document.activeElement));
    },
  });
  useCopyFromChat({
    threadId,
    store,
    dialogs: dialogHost,
    clipboard: browserClipboard,
    download: saveTextFile,
    showStatus: setCommandStatus,
  });
  // The export commands for this chat: typed /export opens the picker, and typed /dump saves omp's reports as files.
  const exportCommands = useMemo(
    () =>
      exportSlashCommandsFor({
        threadId,
        store,
        loadOlder: onLoadOlder,
        session: rpc as RpcSessionClient,
        gateway: commandGateway,
        dialogs: dialogHost,
        download: saveTextFile,
      }),
    [commandGateway, dialogHost, onLoadOlder, rpc, store, threadId],
  );
  const shareController = useShareFromChat({
    client,
    threadId,
    folder,
    dialogs: dialogHost,
    clipboard: browserClipboard,
    showStatus: setCommandStatus,
    showError: setCommandError,
  });
  useImportFromShare({
    client,
    threadId,
    folder,
    dialogs: dialogHost,
    openChat: openThread,
    showStatus: setCommandStatus,
    showError: setCommandError,
    restoreComposerFocus: () => composerInput()?.focus(),
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
            confirmDelete={(_session, title, restoreFocus) =>
              openChatDeleteConfirm(overlay, title, undefined, restoreFocus)
            }
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
  const attachmentManager = useMemo(
    () =>
      new AttachmentManager({
        blobStore: createAttachmentBlobStore(client.port(AttachmentBlobStore)),
        maxBytes: MAX_ATTACHMENT_BYTES,
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
  const p3Handlers = useP3RunHandlers({ store, send: guardedSend, switchChat, runs: p3Runs });
  // The banner of an omp that stopped on its own offers this: the server starts omp again on this chat.
  const restartOmp = useCallback(async (): Promise<void> => {
    await rpc.restart({ threadId });
  }, [rpc, threadId]);
  useRetryShortcut({ threadId, status: p3Runs.status, retry: p3Handlers.retry });
  useAgentHubShortcut(openAgentHub);
  useComposerClipboardShortcuts({ notify: setCommandStatus, fail: setCommandError });
  useSessionModelShortcuts({
    client,
    store,
    threadId,
    capabilities,
    openDialog: (restoreFocus) =>
      openSessionModelDialog({
        overlay,
        client,
        store,
        threadId,
        capabilities,
        folder,
        restoreFocus,
      }),
    fail: setCommandError,
  });
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
    send: messageSend,
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
    () => createQueueController({ store, send: messageSend, capabilities }),
    [capabilities, messageSend, store],
  );
  useLayoutEffect(() => {
    answerExtensionUiRef.current = (response, options) =>
      queueController.answerExtensionUi(response, options);
    return () => {
      answerExtensionUiRef.current = null;
    };
  }, [queueController]);
  const queueAdapter = useMemo(() => createQueueAdapter(queueController), [queueController]);
  const queueOpen = useQueueOpen(queueAdapter);
  const todoStore = useChatTodoStore(store);
  const rulesAdapter = useMemo(() => createRuleStoreAdapter(client), [client]);
  const rulesController = useRulesController({
    adapter: rulesAdapter,
    folder: folder ?? ("" as FolderPath),
    open: true,
  });
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
  // The chat's row slots. Stable while nothing they read changes (rowActions, toolRenderers), so a row whose message did
  // not change is not drawn again when the chat renders for another reason (thread.tsx, MemoMessageRow).
  const slots = useMemo<ThreadRowSlots>(
    () => ({
      renderMessage: (message, renderNested) => {
        const branchSummary = branchSummaryOfRow(message);
        if (branchSummary !== undefined)
          return <BranchSummaryRow message={message} summary={branchSummary} />;
        const compactionSummary = compactionSummaryOfRow(message);
        if (compactionSummary !== undefined)
          return <CompactionSummaryRow message={message} summary={compactionSummary} />;
        const { ompCustomType, ompCustomDetails } = message.metadata.custom;
        if (ompCustomType === "lsp-late-diagnostic")
          return (
            <div data-message-id={message.id}>
              <LateDiagnosticsCard
                identity={message.id}
                snapshot={{ customType: ompCustomType, details: ompCustomDetails }}
              />
            </div>
          );
        return (
          <>
            <CacheMissRow message={message} />
            <MessageParts
              message={message}
              actions={rowActions(message)}
              renderNested={(part) =>
                part.messages === undefined
                  ? undefined
                  : renderNested?.(part.messages, part.toolCallId, part.toolName)
              }
              toolRenderers={toolRenderers}
            />
          </>
        );
      },
      renderNested: (messages, taskId, toolName) => {
        const parsedTaskId = ToolCallId.safeParse(taskId);
        return (
          <NestedTranscript
            depth={0}
            key={taskId}
            messages={messages}
            parentTaskId={parsedTaskId.success ? parsedTaskId.data : undefined}
            taskName={toolName}
            toolRenderers={toolRenderers}
          />
        );
      },
    }),
    [rowActions, toolRenderers],
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
    // A New chat that is starting takes the composer before its chat opens: its text and files are the folder's draft.
    startsUnsent: history.openedNew || newChatStarting,
    messages: newChatStarting ? NO_CHAT_MESSAGES : store,
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
    async (request: DraftRestoreRequest, images: readonly OmpWire.ImageContent[] = []) => {
      const { refs, lost } = await storeQueueImages(images, uploadRestoredImage);
      const attachmentRefs = [...refs, ...attachmentManager.toDraftRefs()];
      draftController.setDraft(request.text, attachmentRefs);
      await attachmentManager.restore(attachmentRefs);
      if (lost > 0) {
        setCommandError(
          lost === 1
            ? "A queued image could not be stored in the message box."
            : "Some queued images could not be stored in the message box.",
        );
      }
    },
    [attachmentManager, draftController, uploadRestoredImage],
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
  // A chat with messages draws its notices in the row above the composer; an empty chat keeps them over its footer, as
  // it did before, so there is one instance of the notices at a time.
  const chatHasMessages = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot().messageOrder.length > 0,
    () => store.getSnapshot().messageOrder.length > 0,
  );
  // A Fast mode change omp refuses leaves omp's own notice; the Execution modes dialog already says it, so it goes.
  const retireFastRefusalNotice = useCallback(() => {
    notificationProjector?.getBus().retireQuietFrom(threadId, FAST_REFUSAL_NOTICE_SOURCE);
  }, [notificationProjector, threadId]);
  // The chat's notices, as the thread draws them: each after the row it follows.
  const transcriptNotices = useMemo(
    () => transcriptNoticeSource(notificationProjector, threadId),
    [notificationProjector, threadId],
  );
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
  // The transition port the rewind panel and `/fork` share: it rewinds, forks and branches the chat on screen.
  const transitions = useConversationTransitions({
    store,
    send: guardedSend,
    capabilities,
    submitPrompt: runtimeController.submitPrompt,
    switchThread: switchChat,
    pickCount,
    deliverNote,
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
        isBusy: () => conversationBusy(store),
        deliverNote,
        focusComposer: () => composerInput()?.focus({ preventScroll: true }),
      }),
      freshSlashCommand({ lifecycle }),
      shareSlashCommand({ run: () => runShareCommand(shareController) }),
      copySlashCommand({ copy: () => runCopyFromChat(shortcutRegistry) }),
      treeSlashCommand({ panel: historyPanel }),
      branchSlashCommand({ panel: historyPanel, isBusy: () => conversationBusy(store) }),
      forkSlashCommand({
        transitions,
        threadId,
        isBusy: () => conversationBusy(store),
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
        isBusy: () => conversationBusy(store),
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
  // What a send does in the chat it is for: a slash command, or omp's prompt. It is read at the send, so a send that
  // waited for a chat to open runs in the chat on screen, never in the one before it. The attachments are the ones the
  // send carried when Enter was pressed (see `submit`): the chat on screen may be another view, which holds none.
  const deliver = useCallback(
    async (intent: PromptIntent, attachments: SendAttachments): Promise<void> => {
      const route = await routeSubmit({
        intent,
        hasAttachments: attachments.refs.length > 0,
        provider: slashProvider,
        appCommands: appSlashCommands,
      });
      if (route === null) {
        // A worker's end reaches the chat only through a worker stream that is on when the worker ends. The stream is requested
        // here, just before the prompt goes out, and nothing waits for it: a worker can start only after the prompt has been
        // sent and the model has answered.
        if (agents !== null) startWorkerStream(agents);
        await runtimeController.submitPrompt({
          ...intent,
          // A pasted-text chip sends its full text, from the file the composer held when Enter was pressed.
          text: withPastedText(intent.text, attachments.complete),
          attachmentRefs: attachments.refs,
        });
      } else {
        await runSlashRoute({
          route,
          intent,
          provider: slashProvider,
          showStatus: setCommandStatus,
          showReport: showCommandOutput,
          runMode: (request, options) => commandGateway.modeChange({ threadId, request }, options),
        });
        slashTip.recordSlashSend();
      }
      perfMark("send_delivered");
    },
    [
      agents,
      appSlashCommands,
      commandGateway,
      runtimeController,
      showCommandOutput,
      slashProvider,
      threadId,
      slashTip.recordSlashSend,
    ],
  );
  // The view for the chat on screen registers how a send reaches it, and how a rewind's note reaches it (see `deliverToOpenChat`).
  const showNote = useCallback(
    (note: NoSwitchNote): void => showNoSwitchNote(notificationProjector, threadId, note),
    [notificationProjector, threadId],
  );
  useLayoutEffect(
    () => registerLiveChat(threadId, deliver, showNote),
    [deliver, registerLiveChat, showNote, threadId],
  );
  const submit = async (intent: PromptIntent): Promise<void> => {
    onPromptSent();
    perfMark("send_accepted");
    // Sending shows the newest message, wherever the reader had scrolled to; the transcript then
    // keeps following by itself because it is at the bottom.
    scrollController.jumpToLatest();
    // The draft keeps the text until the send is admitted. The send goes to the chat that is open when it is delivered,
    // carrying the attachments this composer holds now: that chat's view may be another one, which holds none of them.
    const attachments: SendAttachments = {
      refs: attachmentManager.toDraftRefs(),
      complete: attachmentManager.getState().complete,
    };
    // A send made while a New chat opens takes that New chat's outcome now, not when it is delivered.
    const newChatEnd = newChatOutcomeNow();
    // Where a send that is not sent keeps its text: a New chat's text stays in the folder's new-chat box (chat-draft.ts).
    await chatDraft.submit(intent, (sent) =>
      deliverToOpenChat(
        sent,
        attachments,
        newChatEnd,
        chatDraft.controller.getSnapshot().scope.kind === "folder",
      ),
    );
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
  const sendBlockedReason = history.isSwitching
    ? "Opening session… omp is starting. This can take a few seconds."
    : connection.state === "connected"
      ? undefined
      : SEND_BLOCKED_TEXT;
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
  const area = (name: LayoutAreaName) => (
    <LayoutArea area={name} capabilities={capabilities} surfaces={threadSurfaces} />
  );
  const composer = (
    <ComposerTriggers
      capabilities={capabilities}
      client={client}
      folder={folder}
      slash={slashProvider}
      notify={setCommandStatus}
      fail={setCommandError}
    >
      <RuntimeAwarePreviousMessageSelector controller={selectorController} />
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
          savePasteFile={savePasteFile}
          sendBlockedReason={sendBlockedReason}
          submit={submit}
          toolbar={area("composerToolbar")}
          voice={threadSurfaces.liveVoice?.render() ?? null}
          placeholder={slashTip.placeholder}
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
      <TranscriptDisplayPolicyProvider threadId={history.threadId}>
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
        <ToolRunScope
          loadBackgroundJobStops={loadBackgroundJobStops}
          runBackgroundJobCommand={runBackgroundJobCommand}
          store={store}
        >
          <TaskSubagentsScope agents={agents}>
            <TurnCancelScope cancel={cancel}>
              <ProviderErrorResolverProvider resolver={resolveProviderError}>
                <AppShell
                  composer={composer}
                  newChat={newChat}
                  leftSidebar={leftSidebar}
                  statusBar={area("statusBar")}
                  threadHeader={area("header")}
                  notices={chatHasMessages ? area("threadNotices") : undefined}
                  rightSidebar={
                    <>
                      {area("panels")}
                      <RevealAgentHub reveal={agentsReveal} />
                      <RevealCommandOutput reveal={commandOutputReveal} />
                      <FocusDiagnosticPanelOnReveal
                        open={diagnosticPanelOpen}
                        reveal={diagnosticPanelReveal}
                        title={diagnosticPanel === "reports" ? "Reports" : "Security"}
                      />
                    </>
                  }
                  transcript={
                    store && threadId ? (
                      <TranscriptShortcuts followLatest={scrollController.followLatest}>
                        <div className="flex h-full min-h-0 flex-col" ref={transcriptRootRef}>
                          {history.error ? (
                            <HistoryLoadFailureNotice
                              error={history.error}
                              onRetry={onRetryHistory}
                            />
                          ) : null}
                          <div className="min-h-0 flex-1">
                            <ThreadShell
                              autoScroll={!scrollController.followPaused}
                              credentialActions={credentialActions}
                              readingPlace={{
                                threadId,
                                resumeAt: resumePlace,
                                historyLoading: history.isLoading,
                                openedNew: newChat,
                              }}
                              footer={
                                chatHasMessages ? (
                                  area("threadFooter")
                                ) : (
                                  <>
                                    {area("threadFooter")}
                                    {area("threadOverlay")}
                                  </>
                                )
                              }
                              onLoadOlder={onLoadOlder}
                              onLoadFullOutput={onLoadFullOutput}
                              onRestartOmp={restartOmp}
                              notices={transcriptNotices}
                              slots={slots}
                              store={store}
                            />
                          </div>
                        </div>
                      </TranscriptShortcuts>
                    ) : (
                      <EmptyTranscript
                        copy={emptyStateCopy({ opening: history.isLoading, error: history.error })}
                      />
                    )
                  }
                />
              </ProviderErrorResolverProvider>
            </TurnCancelScope>
          </TaskSubagentsScope>
        </ToolRunScope>
      </TranscriptDisplayPolicyProvider>
    </AssistantRuntimeProvider>
  );
}

function ConnectedApp({
  client,
  capabilities,
  launchFolder,
  watchNotice,
  onDismissWatchNotice,
}: {
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly capabilities: CapabilityMap;
  readonly launchFolder: FolderPath;
  readonly watchNotice: string | undefined;
  readonly onDismissWatchNotice: () => void;
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
  // The chat on screen when a New chat started: its composer takes the new chat's draft until another chat replaces it.
  const [newChatFrom, setNewChatFrom] = useState<ThreadId | null>(null);
  const [newChatThreadId, setNewChatThreadId] = useState<ThreadId | null>(null);
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
  const catalogRefresh = useMemo(() => createSessionCatalogRefreshScheduler(), []);
  useEffect(() => () => catalogRefresh.dispose(), [catalogRefresh]);
  const controller = useMemo<SelectedThreadHistoryController | null>(() => {
    if (!folder) return null;
    // The open folder's list is read again, so each row shows the state its chat has now.
    const readList = () => {
      const list = catalogCache.models.get(folder);
      if (list) catalogRefresh.request(list, 100);
    };
    return createSelectedThreadHistoryController({
      client,
      folder,
      onThreadIdChange: (threadId) =>
        writeSessionValue(THREAD_KEY, threadId ? String(threadId) : null),
      onPerfMark: perfMark,
      // A chat left while its turn runs: its file is written after the turn starts, so no change event announces the
      // turn. The list is read now, and the row shows the turn as running.
      onLeftRunning: readList,
      // A turn ended after its chat was left: the list gets the row the chat wrote, not when the person comes back.
      onTurnSettled: readList,
    });
  }, [catalogCache, catalogRefresh, client, folder]);
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
      setOpenFailure({ folder, threadId, error });
    },
    [client, controller, folder, overlay],
  );
  const remote = useMemo(
    () =>
      catalog
        ? createNativeRemoteThreadListAdapter({
            catalog,
            open: rpc.open,
            close: rpc.close,
            rename: rpc.rename,
            deleteThread: (threadId) => deleteChatFile({ threadId, catalog, sessionFiles }),
            loadedThreadId: () => controller?.getSnapshot().threadId,
          })
        : null,
    [catalog, controller, rpc.open, rpc.close, rpc.rename, sessionFiles],
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
  // Keep the last open chat during the brief empty-history gap while a New chat replaces it, so its composer remains
  // mounted and can receive a prompt typed during the opening.
  const lastReadyHistory = useRef<SelectedThreadHistoryState>(EMPTY_HISTORY);
  if (history.store && history.threadId) lastReadyHistory.current = history;
  const displayedHistory =
    history.store && history.threadId
      ? history
      : newChat.state === "opening" && newChatFrom !== null
        ? lastReadyHistory.current
        : EMPTY_HISTORY;
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
    setNewChatThreadId(null);
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
      // A listed chat gets its terminal state from the runningChanged event; only an unlisted chat
      // needs the turn watcher to create its first row.
      if (!listed) catalogRefresh.request(catalog, 100);
    };
    look();
    return store.subscribe(look);
  }, [catalog, catalogRefresh, folder, history.store]);
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
  // A chat whose open lost the connection is opened again once the connection is back (issue 1617).
  useEffect(() => {
    if (connection.state !== "connected" || !controller) return;
    void controller.reopenFailedOpen().catch(() => undefined);
  }, [connection.state, controller]);
  // The file-less running-list event updates only catalogs containing its folder and re-reads held catalogs after resync.
  useEffect(() => {
    const stopFileChanges = watchSessionFileChanges(client, (change) => {
      for (const list of catalogCache.models.values()) void list.reconcile(change);
    });
    const stopRunningChanges = watchSessionRunningChanges(
      client,
      catalogCache.models,
      catalogRefresh.request,
    );
    return () => {
      stopFileChanges();
      stopRunningChanges();
    };
  }, [catalogCache, catalogRefresh, client]);
  // A list that failed while the connection was down is loaded again once the app is back.
  useEffect(() => {
    if (connection.state !== "connected" || catalog === null) return;
    const current = catalog.getSnapshot();
    if (current.error === null) return;
    void catalog.list({ filter: current.filter, limit: 50 }).catch(() => undefined);
  }, [catalog, connection.state]);
  const activeCapabilities = useMemo(
    () =>
      displayedHistory.capabilities
        ? { ...capabilities, ...displayedHistory.capabilities }
        : capabilities,
    [capabilities, displayedHistory.capabilities],
  );
  const title = useSessionTitle(catalog, displayedHistory.threadId);
  const selectFolder = (nextFolder: FolderPath): void => {
    if (nextFolder === folder) return;
    void controller?.close();
    setNewChat({ state: "idle" });
    setNewChatFrom(null);
    setFolderError(null);
    setOpenFailure(null);
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
  // Every chat the person or the app opens is a pick. A rewind or fork that finishes after a pick does not
  // switch the view, so the chat the person picked last stays on screen.
  const picks = useRef(0);
  // Opens a chat through the history, with the open the caller asked for. A chat whose saved model omp cannot restore is
  // recorded with its id, so the empty screen offers the model picker for that chat, and a model picked there opens that
  // chat with it.
  const openHistoryChatThrough = useCallback(
    async (
      threadId: ThreadId,
      open: (history: SelectedThreadHistoryController) => Promise<unknown>,
    ): Promise<void> => {
      picks.current += 1;
      if (!controller) {
        throw new AppFailure({
          code: "unavailable",
          message: "Opening a session requires a selected workspace folder.",
          retryable: false,
          capability: "host.session-files",
        });
      }
      try {
        await open(controller);
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
  const openHistoryChat = useCallback(
    (threadId: ThreadId, model?: ModelChoice): Promise<void> =>
      openHistoryChatThrough(threadId, (history) => history.pickExisting(threadId, model)),
    [openHistoryChatThrough],
  );
  const pickCount = useCallback((): number => picks.current, []);
  // A chat picked from a list (the sidebar, the chat list, the palette) stays as it is when it is open and loaded: nothing
  // is reloaded (issue 1359).
  const openThread = useCallback(
    (threadId: ThreadId): Promise<void> => openHistoryChat(threadId),
    [openHistoryChat],
  );
  // The chat a New chat opened: the server started it, so it has no messages yet (see `openStarted`).
  const openStartedChat = useCallback(
    (threadId: ThreadId): Promise<void> =>
      openHistoryChatThrough(threadId, (history) => history.openStarted(threadId)),
    [openHistoryChatThrough],
  );
  // A pick from the sidebar: a chat that did not open is shown where it would open (the history's error, on the empty
  // screen), so that failure is not raised again here. Any other refusal, such as no folder being selected, still is.
  const openSidebarChat = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      perfTraceStart();
      setNewChatThreadId(null);
      try {
        await openThread(threadId);
      } catch (error) {
        if (controller !== null && controller.getSnapshot().error !== null) return;
        throw error;
      }
    },
    [controller, openThread],
  );
  // A switch to a chat a branch or a rewind made (a regenerate, an edit, a rewind). The chat on screen can still be the
  // source's store: omp moves the running session to the branch in place, so the chat is always opened again (PR 1645).
  const switchChat = useCallback(
    (threadId: ThreadId): Promise<void> => {
      setNewChatThreadId(null);
      return openHistoryChatThrough(threadId, (history) => history.openExisting(threadId));
    },
    [openHistoryChatThrough],
  );
  // The sidebar's New chat holds the chat switch from its click until its chat's open is requested, so a send made
  // meanwhile waits for the new chat instead of going to the chat before it. The sidebar reports the end of only the
  // newest New chat (an older one is superseded by a newer click and will not open), so the newest hold is the one a
  // report ends; the holds of the New chats before it end at once.
  const newChatHolds = useRef<Array<() => void>>([]);
  // The newest New chat's outcome: a send made while it opens waits for it, and is not sent when it does not open.
  const newChatTicketRef = useRef<NewChatTicket | null>(null);
  const newChatOutcomeNow = useCallback(
    (): Promise<NewChatOutcome> | null => newChatTicketRef.current?.outcome ?? null,
    [],
  );
  const reportNewChat = useCallback(
    (status: NewChatStatus): void => {
      setNewChat(status);
      if (status.state === "opening") {
        perfTraceStart();
        const shownThreadId = controller?.getSnapshot().threadId;
        if (shownThreadId !== undefined) setNewChatFrom(shownThreadId);
        for (const release of newChatHolds.current.splice(0)) release();
        newChatHolds.current.push(controller?.holdSwitch() ?? (() => undefined));
        newChatTicketRef.current?.settle("not-opened");
        newChatTicketRef.current = openNewChatTicket();
        return;
      }
      newChatTicketRef.current?.settle("not-opened");
      newChatTicketRef.current = null;
      newChatHolds.current.pop()?.();
    },
    [controller],
  );
  // The sidebar opens its New chat's chat with this. The open holds the switch from its request on (`whenSettled` waits
  // for it), so the New chat's own hold ends here, before the history of the chat loads.
  const openNewChatFromSidebar = useCallback(
    (threadId: ThreadId): Promise<void> => {
      setNewChatThreadId(threadId);
      newChatHolds.current.at(-1)?.();
      newChatTicketRef.current?.settle("opened");
      newChatTicketRef.current = null;
      return openStartedChat(threadId);
    },
    [openStartedChat],
  );
  // The chat on screen registers how a send reaches it: the view that shows the open chat (see `deliverToOpenChat`).
  const liveChat = useRef<{
    readonly threadId: ThreadId;
    readonly deliver: (intent: PromptIntent, attachments: SendAttachments) => Promise<void>;
    readonly notice?: (note: NoSwitchNote) => void;
  } | null>(null);
  const liveChatChanged = useRef<Array<() => void>>([]);
  const registerLiveChat = useCallback(
    (
      threadId: ThreadId,
      deliver: (intent: PromptIntent, attachments: SendAttachments) => Promise<void>,
      notice?: (note: NoSwitchNote) => void,
    ): (() => void) => {
      const live = { threadId, deliver, notice };
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
  // A rewind's note goes to the chat the person has open, through the view that shows it, once that chat has opened
  // (see `deliverNoteWhenOpen`). The rewind's result does not wait for the note.
  const deliverNoteToOpenChat = useCallback(
    (note: NoSwitchNote): Promise<void> => {
      if (controller === null) return Promise.resolve();
      return deliverNoteWhenOpen(
        {
          whenSettled: () => controller.whenSettled(),
          openThreadId: () => controller.getSnapshot().threadId,
          view: () => liveChat.current,
          nextView: () =>
            new Promise<void>((wake) => {
              liveChatChanged.current.push(wake);
            }),
        },
        note,
      );
    },
    [controller],
  );
  // A send goes to the chat that is open when it is delivered, through the view that shows it. While a chat is still
  // opening, the send waits until that chat is on screen: it is never written to the chat before it. If the chat did
  // not open, nothing is sent and the text stays in the composer.
  const deliverToOpenChat = useCallback(
    async (
      intent: PromptIntent,
      attachments: SendAttachments,
      newChatEnd: Promise<NewChatOutcome> | null,
      keptInNewChat: boolean,
    ): Promise<void> => {
      if (controller === null) {
        throw new AppFailure({
          code: "unavailable",
          message: "Open a chat to send a message.",
          retryable: false,
        });
      }
      await deliverWhenChatOpen(
        {
          whenSettled: () => controller.whenSettled(),
          openThreadId: () => controller.getSnapshot().threadId,
          liveChat: () => liveChat.current,
          nextChange: () =>
            new Promise<void>((wake) => {
              liveChatChanged.current.push(wake);
            }),
          newChatEnd,
          keptInNewChat,
        },
        [intent, attachments],
      );
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
    perfTraceStart();
    const initialized = await remote.initialize("new");
    const started = initialized.remoteId as ThreadId;
    setNewChatThreadId(started);
    await openStartedChat(started);
    return started;
  }, [openStartedChat, remote]);
  // Settings saves through its own runtime; the external signal refreshes only the paste reader after the exit.
  const settingsClosed = useMemo(() => createSettingsClosedSignal(), []);
  const openSettings = useCallback(
    (threadId: ThreadId | null, restoreFocus?: HTMLElement) => {
      overlay.open({
        kind: "modal",
        label: "Settings",
        ...(restoreFocus === undefined ? {} : { restoreFocus }),
        width: "viewport",
        className: SETTINGS_FRAME_CLASS,
        content: ({ close, requestClose, update }) => (
          <RunOnExit onExit={() => settingsClosed.bump()}>
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
          </RunOnExit>
        ),
      });
    },
    [capabilities, client, folder, overlay, settingsClosed, startChat],
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
            onNewChat={openNewChatFromSidebar}
            onOpenThread={openSidebarChat}
            confirmDelete={(_session, title, restoreFocus) =>
              openChatDeleteConfirm(overlay, title, undefined, restoreFocus)
            }
            confirmDeleteRunning={(title) =>
              openChatDeleteConfirm(
                overlay,
                title,
                "This chat is still running. Deleting it stops the run.",
              )
            }
            onDeletedOpenThread={() => controller?.close()}
            stopRunning={async (threadId) => {
              await rpc.send({ threadId, command: { type: "abort" } });
            }}
            currentTurnRunning={() =>
              controller?.getSnapshot().store?.getSnapshot().prompt.streaming === true
            }
            requestRefresh={catalogRefresh.request}
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
  const shortcutPreferenceError = useShortcutPreferenceError();
  const emptyHeaderSurfaces: SurfaceMap = {
    title: {
      title: "Conversation",
      grow: true,
      render: () => (
        <div className="relative min-w-0 flex-1">
          <h1 className="min-w-0 truncate text-sm font-medium">New conversation</h1>
          {shortcutPreferenceError !== undefined && (
            <div className="absolute start-0 top-full z-10 flex w-max max-w-[min(26rem,calc(100vw-4.5rem))] flex-col pt-1">
              <ShortcutPreferenceNotice />
            </div>
          )}
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
    render: () =>
      watchNotice === undefined ? null : (
        <WatchNotice detail={watchNotice} onDismiss={onDismissWatchNotice} />
      ),
  };
  const emptyTranscriptSurfaces: SurfaceMap = {
    connection: connectionSurface,
    watchNotice: watchSurface,
  };
  if (displayedHistory.store && displayedHistory.threadId) {
    return (
      <LargePasteMenuProvider client={client} folder={folder} settingsClosed={settingsClosed}>
        <ActiveThreadContent
          capabilities={activeCapabilities}
          catalog={catalog}
          client={client}
          folder={folder}
          history={displayedHistory}
          newChat={
            displayedHistory.openedNew ||
            (displayedHistory.threadId !== undefined &&
              displayedHistory.threadId === newChatThreadId)
          }
          newChatStarting={
            newChatFrom !== null &&
            newChat.state === "opening" &&
            displayedHistory.threadId === newChatFrom
          }
          resumePlace={resumePlace}
          connectionSurface={connectionSurface}
          watchSurface={watchSurface}
          onLoadOlder={controller === null ? undefined : () => controller.loadOlder()}
          onLoadFullOutput={controller === null ? undefined : (id) => controller.loadFullOutput(id)}
          onRefreshAfterCommand={
            controller === null ? undefined : () => controller.refreshAfterCommand()
          }
          onRetryHistory={() => controller?.retryHistory() ?? Promise.resolve()}
          leftSidebar={leftSidebar}
          onOpenSettings={openSettings}
          onPromptSent={onPromptSent}
          openThread={openThread}
          switchChat={switchChat}
          pickCount={pickCount}
          deliverNote={deliverNoteToOpenChat}
          deliverToOpenChat={deliverToOpenChat}
          newChatOutcomeNow={newChatOutcomeNow}
          registerLiveChat={registerLiveChat}
          remote={remote}
          title={title}
          p3Runs={p3Runs}
        />
      </LargePasteMenuProvider>
    );
  }
  const shownFailure = openFailureIn(openFailure, folder);
  const emptyError =
    history.error ??
    (newChat.state === "failed" ? newChat.error : null) ??
    shownFailure?.error ??
    null;
  const emptyCopy = emptyStateCopy({
    opening: history.isLoading || newChat.state === "opening",
    error: emptyError,
  });
  // A saved chat whose model omp cannot restore gets the picker; picking a model opens that chat with it.
  const savedModelThreadId =
    controller && emptyError?.code === "model_unavailable" ? shownFailure?.threadId : undefined;
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
  const reportFirstAnswerFailure = useCallback((error: unknown) => {
    // A blank page would say nothing: show what happened, and leave a line in the log.
    reportClientError({
      kind: "error",
      message: `The app server's first answers failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }, []);
  const { state: firstAnswers, retry: retryInitialRequest } = useFirstAnswers(
    client,
    reportFirstAnswerFailure,
  );
  const { capabilities, serverInfo, health } = firstAnswers;
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
    const app = client.port(AppPort);
    // From here on, errors in the page land in the app's debug log next to the server's own lines.
    setClientErrorSink((report) => app.reportClientError(report));
    return () => setClientErrorSink(undefined);
  }, [client]);
  useEffect(() => {
    if (!client || !perfTraceEnabled()) return;
    const app = client.port(AppPort);
    return installPerfTrace(true, (trace) => {
      void app.reportClientTrace(trace);
    });
  }, [client]);
  // The page reads the server's watches now and then, so the notice shows and clears while the app runs.
  const readHealth = useMemo(
    () => (client ? () => client.port(AppPort).health({}) : undefined),
    [client],
  );
  const watchNotice = useWatchNotice(readHealth);
  if (client && firstAnswers.status === "failed") {
    return (
      <LaunchStatusScreen
        reason="The app server is running but did not answer the page's first questions. Try again, or attach the app's log to a bug report."
        state="closed"
        onRetry={retryInitialRequest}
      />
    );
  }
  if (!client) return null;
  if (firstAnswers.status !== "ready" || !serverInfo)
    return <LaunchStatusScreen state="connecting" />;
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
                watchNotice={watchNotice.detail}
                onDismissWatchNotice={watchNotice.dismiss}
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

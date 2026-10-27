import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AppPort, type CapabilityMap, type FolderPath, type ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo } from "react";
import { AccessibilityProvider } from "@/a11y";
import { RevealAgentHub } from "@/app/agents/agents-tab";
import { TaskSubagentsScope } from "@/app/agents/thread-agents-scope";
import { RevealCommandOutput } from "@/app/command-report/command-report";
import { openFailureIn } from "@/app/open-failure";
import { ToolRunScope } from "@/app/tool-run-scope";
import { Button } from "@/components/ui/button";
import {
  AppConnectionGate,
  AppConnectionProvider,
  LaunchStatusScreen,
  OmpUnavailableScreen,
  useAppConnection,
  useFirstAnswers,
  useWatchNotice,
} from "@/launch";
import { LayoutArea, type LayoutAreaName } from "@/layout";
import { resolveQueueSubmitPolicy } from "@/modules/P6/composer/composer";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { HistoryLoadFailureNotice } from "@/modules/R1/history";
import { ProviderErrorResolverProvider } from "@/modules/U1/parts/provider-error-resolver";
import { TranscriptDisplayPolicyProvider } from "@/modules/U1/policy";
import { TranscriptShortcuts } from "@/modules/U1/shortcuts";
import { ThreadShell, TurnCancelScope } from "@/modules/U1/thread";
import { ToolRendererResolverContext } from "@/modules/U1/tool-slots";
import { richAskOffered } from "@/modules/U4/router";
import { OverlayHost } from "@/overlay";
import { CommandPaletteHost } from "@/palette";
import { DESCRIPTORS, RENDERERS, registry } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { AppShell, ComposerNote } from "@/shell";
import { type PreferenceStore, ShortcutRegistryProvider, ShortcutSheetHost } from "@/shortcuts";
import { ThemeApplier } from "@/theme";
import { useAppSurfaces } from "./app-surfaces";
import { reportClientError, setClientErrorSink } from "./client-errors";
import { ComposerHistory } from "./composer-history";
import { ComposerTriggers } from "./composer-triggers";
import {
  DraftComposer,
  RuntimeAwarePreviousMessageSelector,
  ThreadRunningFlag,
} from "./draft-composer";
import { emptyStateCopy } from "./empty-state";
import { ExternalEditorDialog } from "./external-editor-dialog";
import { HistorySearchDialog } from "./history-search-dialog";
import { LargePasteMenuProvider } from "./large-paste-menu";
import { installPerfTrace, perfTraceEnabled } from "./perf-trace";
import { RouterBridge } from "./router-bridge";
import { openSavedChatModelPicker } from "./saved-chat-model-picker";
import { rememberLaunchFolder } from "./session-storage";
import { EmptyTranscript, FocusDiagnosticPanelOnReveal } from "./thread-chrome";
import type { ActiveThreadProps } from "./thread-props";
import { useThreadSurfaces } from "./thread-surfaces";
import { resolveToolRenderer } from "./tool-renderers";
import { useAppChatState } from "./use-app-chat-state";
import { useAppOverlays } from "./use-app-overlays";
import { useChatDelivery } from "./use-chat-delivery";
import { useChatHistory } from "./use-chat-history";
import { useChatOpen } from "./use-chat-open";
import { useChatTurns, useChatWatchers } from "./use-chat-turns";
import { useNewChat, useStartChat } from "./use-new-chat";
import { useThreadPalette, useThreadSlashCommands } from "./use-thread-commands";
import { useThreadComposerTools } from "./use-thread-composer-tools";
import { useThreadDrafts } from "./use-thread-drafts";
import {
  useThreadChatActions,
  useThreadDialogs,
  useThreadSessionInfo,
} from "./use-thread-overlays";
import { useThreadPanels } from "./use-thread-panels";
import { useThreadRuntime } from "./use-thread-runtime";
import { useThreadSend } from "./use-thread-send";
import {
  useThreadCommandStatus,
  useThreadMessageActions,
  useThreadServices,
} from "./use-thread-state";

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
  newChat,
  newChatStarting,
  opening,
  leftSidebar,
  claimReloadTarget,
  onPromptSent,
  openThread,
  switchChat,
  pickCount,
  deliverNote,
  deliverToOpenChat,
  newChatTicketNow,
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
  const {
    slashTip,
    otherVersions,
    lastUserVersions,
    connection,
    resolveProviderError,
    chat,
    guardedSend,
    messageSend,
    savePasteFile,
    saveTextAttachment,
    agents,
  } = useThreadServices({ store, threadId, catalog, client, capabilities, p3Runs });
  const {
    commandError,
    setCommandError,
    commandStatus,
    setCommandStatus,
    diagnosticPanel,
    setDiagnosticPanel,
    diagnosticPanelOpen,
    setDiagnosticPanelOpen,
    diagnosticPanelReveal,
    setDiagnosticPanelReveal,
    diagnosticPort,
    diagnosticFocusToken,
    restoreDiagnosticPanelFocus,
    closeDiagnosticPanel,
    shortcutPreferenceError,
  } = useThreadCommandStatus({ threadId, client });
  const { editing, setEditing, branchAvailable, rowActions } = useThreadMessageActions({
    store,
    capabilities,
    lastUserVersions,
    otherVersions,
    openThread,
  });
  const { overlay, commandGateway, answerDialogRef, dialogHost } = useThreadDialogs({
    commandStatus,
    commandError,
    setCommandStatus,
    setCommandError,
    client,
    threadId,
    capabilities,
    onRefreshAfterCommand,
  });
  const { selectorController, exportCommands, shareController } = useThreadChatActions({
    chat,
    capabilities,
    branchAvailable,
    dialogHost,
    threadId,
    store,
    setEditing,
    commandGateway,
    onLoadOlder,
    client,
    folder,
    setCommandStatus,
    setCommandError,
    openThread,
  });
  const { lifecycle, openSessionBrowser } = useThreadSessionInfo({
    store,
    threadId,
    catalog,
    capabilities,
    remote,
    commandGateway,
    dialogHost,
    overlay,
    openThread,
  });
  const {
    agentsReveal,
    openAgentHub,
    openLogin,
    goalCommand,
    commandHandlers,
    commandUnavailableReasons,
  } = useThreadPalette({
    agents,
    capabilities,
    overlay,
    client,
    threadId,
    chat,
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
  });
  const {
    attachmentManager,
    p3Handlers,
    restartOmp,
    runtimeController,
    runtime,
    scrollController,
    transcriptRootRef,
    queueController,
    queueAdapter,
    queueOpen,
    restoreStoppedRef,
    uploadRestoredImage,
  } = useThreadRuntime({
    client,
    capabilities,
    folder,
    store,
    threadId,
    chat,
    guardedSend,
    messageSend,
    switchChat,
    p3Runs,
    overlay,
    setCommandStatus,
    setCommandError,
    openAgentHub,
    answerDialogRef,
  });
  const { todoModel, rulesController, slots } = useThreadPanels({
    store,
    client,
    folder,
    rowActions,
  });
  const { chatDraft, draftController, setEditorText } = useThreadDrafts({
    client,
    history,
    newChatStarting,
    store,
    folder,
    threadId,
    attachmentManager,
    uploadRestoredImage,
    restoreStoppedRef,
    setCommandStatus,
    setCommandError,
    queueAdapter,
  });
  const {
    historySearchOpen,
    setHistorySearchOpen,
    readPrompts,
    editRequest,
    setEditRequest,
    notificationProjector,
    chatHasMessages,
    transcriptNotices,
    retireFastRefusalNotice,
  } = useThreadComposerTools({
    store,
    setCommandStatus,
    draftController,
    setEditorText,
    connection,
    threadId,
  });
  const {
    commandOutputReveal,
    commandOutputSurface,
    showCommandOutput,
    threadRunning,
    transitions,
    appSlashCommands,
    slashProvider,
    runBackgroundJobCommand,
    loadBackgroundJobStops,
  } = useThreadSlashCommands({
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
  });
  const { submit, cancel, queueConnection, sendBlockedReason, credentialActions } = useThreadSend({
    agents,
    slashTip,
    connection,
    appSlashCommands,
    slashProvider,
    showCommandOutput,
    runtimeController,
    scrollController,
    attachmentManager,
    chatDraft,
    notificationProjector,
    commandGateway,
    overlay,
    claimReloadTarget,
    registerLiveChat,
    deliverToOpenChat,
    onPromptSent,
    newChatTicketNow,
    onRefreshAfterCommand,
    history,
    threadId,
    client,
    store,
    capabilities,
    folder,
    setCommandStatus,
  });
  const { threadSurfaces } = useThreadSurfaces({
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
  });
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
      opening={opening}
    >
      <RuntimeAwarePreviousMessageSelector controller={selectorController} />
      <ThreadRunningFlag flag={threadRunning} />
      <ComposerHistory store={store}>
        <DraftComposer
          capabilities={capabilities}
          cancel={cancel}
          chat={chatDraft.chat}
          hold={chatDraft.hold}
          controller={draftController}
          switching={history.isSwitching}
          footer={area("composerFooter")}
          footerOpen={editing !== null}
          editing={editing !== null}
          manager={attachmentManager}
          onResolve={chatDraft.resolveConflict}
          onRetry={chatDraft.retry}
          onDoubleLeftArrow={openAgentHub}
          policy={resolveQueueSubmitPolicy}
          savePasteFile={savePasteFile}
          saveTextAttachment={saveTextAttachment}
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
          switching={history.isSwitching}
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
  const {
    connection,
    overlay,
    lastInstanceId,
    setFolderText,
    resumePlace,
    setResumePlace,
    folder,
    folderError,
    setFolderError,
    openFailure,
    setOpenFailure,
    newChat,
    setNewChat,
    newChatFrom,
    setNewChatFrom,
    newlyStartedThread,
    setNewlyStartedThread,
    unsentThread,
    openingUnsentThread,
    newChatThreadId,
    setNewChatThreadId,
    recentFolders,
    setRecentFolders,
    sessionFiles,
    rpc,
    chat,
    catalogCache,
    catalog,
    catalogRefresh,
  } = useAppChatState({ client, launchFolder });
  const { controller, reportOpenFailure, remote, history, displayedHistory } = useChatHistory({
    client,
    folder,
    rpc,
    sessionFiles,
    catalogCache,
    catalog,
    catalogRefresh,
    overlay,
    unsentThread,
    openingUnsentThread,
    newChat,
    newChatFrom,
    setNewlyStartedThread,
    setOpenFailure,
    setResumePlace,
    setRecentFolders,
  });
  const { claimReloadTarget, onPromptSent, p3Runs, turnWatch } = useChatTurns({
    history,
    unsentThread,
    newlyStartedThread,
    setNewlyStartedThread,
    setNewChatThreadId,
  });
  const { activeCapabilities, title } = useChatWatchers({
    client,
    capabilities,
    connection,
    folder,
    lastInstanceId,
    catalog,
    catalogCache,
    catalogRefresh,
    history,
    displayedHistory,
    controller,
    turnWatch,
  });
  const {
    selectFolder,
    validateOtherFolder,
    openHistoryChat,
    pickCount,
    openThread,
    openStartedChat,
    openSidebarChat,
    switchChat,
  } = useChatOpen({
    client,
    folder,
    controller,
    reportOpenFailure,
    unsentThread,
    setFolderText,
    setFolderError,
    setNewChat,
    setNewChatFrom,
    setNewChatThreadId,
    setOpenFailure,
  });
  const { newChatTicketNow, reportNewChat, openNewChatFromSidebar } = useNewChat({
    controller,
    unsentThread,
    setNewChat,
    setNewChatFrom,
    setNewChatThreadId,
    setNewlyStartedThread,
    openStartedChat,
  });
  const { registerLiveChat, deliverNoteToOpenChat, deliverToOpenChat } = useChatDelivery({
    controller,
  });
  const { startChat } = useStartChat({
    remote,
    unsentThread,
    setNewlyStartedThread,
    setNewChatThreadId,
    openStartedChat,
  });
  const { settingsClosed, openSettings, idleHandlers } = useAppOverlays({
    overlay,
    capabilities,
    client,
    folder,
    startChat,
  });
  const {
    leftSidebar,
    emptyHeaderSurfaces,
    connectionSurface,
    watchSurface,
    emptyTranscriptSurfaces,
  } = useAppSurfaces({
    folder,
    folderError,
    selectFolder,
    validateOtherFolder,
    launchFolder,
    recentFolders,
    catalog,
    remote,
    history,
    overlay,
    openNewChatFromSidebar,
    openSidebarChat,
    catalogRefresh,
    chat,
    controller,
    reportNewChat,
    newChatTicketNow,
    reportOpenFailure,
    capabilities,
    openSettings,
    connection,
    watchNotice,
    onDismissWatchNotice,
  });
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
            (newChatFrom !== null &&
              newChat.state === "opening" &&
              displayedHistory.threadId === newChatFrom) ||
            displayedHistory.threadId === newlyStartedThread
          }
          opening={history.isLoading || newChat.state === "opening"}
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
          claimReloadTarget={claimReloadTarget}
          onPromptSent={onPromptSent}
          openThread={openThread}
          switchChat={switchChat}
          pickCount={pickCount}
          deliverNote={deliverNoteToOpenChat}
          deliverToOpenChat={deliverToOpenChat}
          newChatTicketNow={newChatTicketNow}
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
    <AppConnectionProvider onLaunchFolder={rememberLaunchFolder}>
      <ThemeApplier />
      <AccessibilityProvider>
        <AppConnectionGate>
          <ConnectedRoot />
        </AppConnectionGate>
      </AccessibilityProvider>
    </AppConnectionProvider>
  );
}

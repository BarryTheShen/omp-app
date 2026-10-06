import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import {
  AppPort,
  type AppServerInfo,
  AttachmentBlobStore,
  type CapabilityMap,
  FolderPath,
  type HostCallId,
  HostMetadataPort,
  type RpcSessionClient,
  RpcSessionPort,
  SessionFileStore,
  ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityProvider } from "@/a11y";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "@/launch";
import { QueueLaneBar } from "@/modules/P6/bar/bar";
import { resolveQueueSubmitPolicy } from "@/modules/P6/composer/composer";
import { createQueueAdapter } from "@/modules/P6/contract";
import { createQueueController } from "@/modules/R0/actions";
import { useOmpRuntime } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import {
  createSelectedThreadHistoryController,
  type SelectedThreadHistoryController,
  type SelectedThreadHistoryState,
} from "@/modules/R1/history";
import { createNativeRemoteThreadListAdapter } from "@/modules/R1/remote";
import { SessionCatalogSidebar } from "@/modules/R1/ui";
import { MessageParts } from "@/modules/U1/parts";
import { ThreadShell } from "@/modules/U1/thread";
import { AttachmentChips, AttachmentManager } from "@/modules/U2/attachments";
import { createAttachmentBlobStore } from "@/modules/U2/attachments/blob-store";
import { ComposerSurface } from "@/modules/U2/composer";
import type { PromptIntent, SubmitPolicy } from "@/modules/U2/contract";
import { createDraftStoreAdapter, DraftController } from "@/modules/U2/drafts";
import { ModeIndicator } from "@/modules/U2/modes";
import { createToolRegistry } from "@/modules/U3/tool-card/registry";
import {
  cancelledHostToolResult,
  cancelledHostUriResult,
  type HostRequestAnswer,
} from "@/modules/U4/contract/host-answers";
import { renderDialogRequest } from "@/modules/U4/dialogs";
import { DialogHostController } from "@/modules/U4/host";
import { ExtensionUiRequestRouterController } from "@/modules/U4/router";
import { PanelShell } from "@/modules/U5/panel/shell";
import { TodoChecklist } from "@/modules/U5/todo/checklist/checklist";
import { projectTodoSnapshot } from "@/modules/U5/todo/model";
import { TodoStoreAdapter } from "@/modules/U5/todo/store/store";
import { OverlayHost, useOverlayHost } from "@/overlay";
import { RENDERERS, registry, TOOL_RENDERERS } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { AppShell } from "@/shell";
import { SessionModelControl, SessionStatusBar } from "./session-controls";

const FOLDER_KEY = "omp.app.root.folder";
const THREAD_KEY = "omp.app.root.thread";
const EMPTY_HISTORY: SelectedThreadHistoryState = {
  threadId: undefined,
  store: undefined,
  capabilities: undefined,
  isLoading: false,
  error: null,
};
const EMPTY_CAPABILITIES: CapabilityMap = Object.freeze({});

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
function folderLabel(folder: FolderPath | undefined): string {
  if (!folder) return "Choose folder…";
  const normalized = folder.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || folder;
}

function FolderSwitcher({
  folder,
  recentFolders,
  error,
  onFolderChange,
  onOtherFolder,
}: {
  readonly folder: FolderPath | null;
  readonly recentFolders: readonly FolderPath[];
  readonly error: string | null;
  readonly onFolderChange: (folder: FolderPath) => void;
  readonly onOtherFolder: (folder: string) => Promise<boolean>;
}) {
  const [otherPath, setOtherPath] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const currentValue = folder ?? "";
  const options = [...new Set([...(folder ? [folder] : []), ...recentFolders])];
  return (
    <div
      className="border-sidebar-border bg-sidebar relative z-10 flex shrink-0 flex-col gap-2 border-b p-3"
      data-app-folder-switcher="true"
    >
      <label className="text-muted-foreground text-xs font-medium" htmlFor="workspace-folder">
        Workspace folder
      </label>
      <select
        aria-label="Workspace folder"
        className="border-border bg-background text-foreground rounded-(--radius) border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        id="workspace-folder"
        title={folder ?? "Choose a workspace folder"}
        value={otherOpen ? "__other__" : currentValue}
        onChange={(event) => {
          if (event.target.value === "__other__") {
            setOtherOpen(true);
            return;
          }
          const parsed = FolderPath.safeParse(event.target.value);
          if (parsed.success) {
            setOtherOpen(false);
            onFolderChange(parsed.data);
          }
        }}
      >
        {!folder && <option value="">Choose folder…</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {folderLabel(option)}
          </option>
        ))}
        <option value="__other__">Other folder…</option>
      </select>
      {otherOpen && (
        <div className="flex min-w-0 gap-2">
          <input
            aria-label="Other folder path"
            className="border-border bg-background text-foreground min-w-0 flex-1 rounded-(--radius) border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="/path/to/project"
            value={otherPath}
            onChange={(event) => setOtherPath(event.target.value)}
          />
          <button
            className="bg-primary text-primary-foreground rounded-(--radius) px-2 py-1 text-xs font-medium disabled:opacity-50"
            disabled={otherPath.trim().length === 0}
            type="button"
            onClick={async () => {
              if (await onOtherFolder(otherPath)) {
                setOtherOpen(false);
                setOtherPath("");
              }
            }}
          >
            Use
          </button>
        </div>
      )}
      {error && (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function EmptyTranscript({ state }: { readonly state: SelectedThreadHistoryState }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-lg font-medium tracking-tight">
        {state.isLoading ? "Opening session…" : "Ready when you are"}
      </p>
      <p className="text-muted-foreground text-sm">
        {state.error?.message ?? "Choose a workspace folder and start a new session."}
      </p>
    </div>
  );
}

function RouterBridge({
  store,
  rpc,
  threadId,
  capabilities,
  queueController,
}: {
  readonly store: OmpRuntimeStore;
  readonly rpc: RpcSessionClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly queueController: ReturnType<typeof createQueueController>;
}) {
  const overlay = useOverlayHost();
  const dialogHostRef = useRef<DialogHostController | null>(null);
  if (dialogHostRef.current === null) {
    dialogHostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerExtensionUi: async (response, options) => {
        await rpc.answerExtensionUi(
          { threadId, response: { ...response, id: UiRequestId.parse(response.id) } },
          options,
        );
      },
      render: renderDialogRequest,
    });
  }
  const dialogHost = dialogHostRef.current;
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
      }),
    [dialogHost, hostAnswers, overlay],
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
        .catch(() => undefined);
    };
    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      dialogHost.dispose();
    };
  }, [dialogHost, router, store, threadId]);
  return null;
}

function DraftComposer({
  controller,
  submit,
  cancel,
  policy,
  queueBar,
  manager,
  capabilities,
}: {
  readonly controller: DraftController;
  readonly submit: (intent: PromptIntent) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly policy: SubmitPolicy;
  readonly queueBar: ReactNode;
  readonly manager: AttachmentManager;
  readonly capabilities: CapabilityMap;
}) {
  const aui = useAui();
  const hydrated = useRef(false);
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  const text = useAuiState((state) => state.composer.text);
  useEffect(() => {
    void controller.load();
    return () => {
      void controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    if (snapshot.status !== "ready" || hydrated.current) return;
    hydrated.current = true;
    if (snapshot.text !== text) aui.composer.setText(snapshot.text);
    void manager.restore(snapshot.attachments).catch(() => undefined);
  }, [aui.composer, manager, snapshot.attachments, snapshot.status, snapshot.text, text]);
  useEffect(() => {
    if (!hydrated.current) return;
    controller.setDraft(text, manager.toDraftRefs());
  }, [controller, manager, text]);
  return (
    <ComposerSurface
      cancel={cancel}
      disabled={snapshot.status === "error"}
      policy={policy}
      submitPrompt={submit}
    >
      <div className="flex items-center gap-2 px-(--space-md) py-(--space-xs)">
        <label className="text-muted-foreground cursor-pointer text-xs">
          Add file
          <input
            className="sr-only"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void manager
                .add({ file })
                .then((pending) => manager.send(pending))
                .catch(() => undefined);
              event.target.value = "";
            }}
          />
        </label>
        <ModeIndicator capabilities={capabilities} />
        {queueBar}
      </div>
      <AttachmentChips manager={manager} />
    </ComposerSurface>
  );
}

interface ActiveThreadProps {
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly history: SelectedThreadHistoryState;
  readonly capabilities: CapabilityMap;
  readonly leftSidebar: ReactNode;
  readonly title: string;
}

function ActiveThreadContent(props: ActiveThreadProps) {
  if (!props.history.store || !props.history.threadId) return null;
  return <ActiveThreadReady {...props} />;
}

function ActiveThreadReady({
  client,
  capabilities,
  history,
  leftSidebar,
  title,
}: ActiveThreadProps) {
  const store = history.store as OmpRuntimeStore;
  const threadId = history.threadId as ThreadId;
  const connection = useAppConnection();
  const rpc = client.port(RpcSessionPort);
  const attachmentManager = useMemo(
    () =>
      new AttachmentManager({
        blobStore: createAttachmentBlobStore(client.port(AttachmentBlobStore)),
      }),
    [client],
  );
  const { controller: runtimeController, runtime } = useOmpRuntime({
    store,
    send: rpc.send,
    capabilities,
  });
  const queueController = useMemo(
    () => createQueueController({ store, send: rpc.send, capabilities }),
    [capabilities, rpc.send, store],
  );
  const queueAdapter = useMemo(() => createQueueAdapter(queueController), [queueController]);
  const todoStore = useMemo(() => new TodoStoreAdapter({ store }), [store]);
  const todoSnapshot = useSyncExternalStore(
    (listener) => todoStore.subscribe(listener),
    () => todoStore.getSnapshot(),
    () => todoStore.getSnapshot(),
  );
  const todoModel = useMemo(() => projectTodoSnapshot(todoSnapshot), [todoSnapshot]);
  const toolRegistry = useMemo(() => createToolRegistry(TOOL_RENDERERS), []);
  const toolRenderers = useMemo(
    () =>
      Object.fromEntries(
        TOOL_RENDERERS.flatMap((descriptor) =>
          descriptor.match.by === "name"
            ? [[descriptor.match.name, toolRegistry.resolve(descriptor.match.name).renderer]]
            : [],
        ),
      ),
    [toolRegistry],
  );
  useEffect(
    () => () => {
      queueAdapter.dispose();
      todoStore.dispose();
    },
    [queueAdapter, todoStore],
  );
  const draftController = useMemo(
    () =>
      new DraftController({
        store: createDraftStoreAdapter(client),
        scope: { kind: "thread", threadId },
        lifecycle: typeof window === "undefined" ? undefined : window,
      }),
    [client, threadId],
  );
  const submit = async (intent: PromptIntent): Promise<void> => {
    await draftController.submit(intent, (nextIntent) =>
      runtimeController.submitPrompt({
        ...nextIntent,
        attachmentRefs: attachmentManager.toDraftRefs(),
      }),
    );
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
  const composer = (
    <DraftComposer
      cancel={cancel}
      capabilities={capabilities}
      controller={draftController}
      manager={attachmentManager}
      policy={resolveQueueSubmitPolicy}
      queueBar={<QueueLaneBar connection={queueConnection} controller={queueAdapter} />}
      submit={submit}
    />
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RouterBridge
        capabilities={capabilities}
        queueController={queueController}
        rpc={rpc}
        store={store}
        threadId={threadId}
      />
      <AppShell
        composer={composer}
        leftSidebar={leftSidebar}
        statusBar={<SessionStatusBar client={client} store={store} threadId={threadId} />}
        threadHeader={
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold tracking-tight">omp</h1>
              <p className="text-muted-foreground truncate text-xs">{title}</p>
            </div>
            <SessionModelControl
              capabilities={capabilities}
              client={client}
              store={store}
              threadId={threadId}
            />
          </div>
        }
        rightSidebar={
          <PanelShell
            body={todoModel.phases.length === 0 ? null : <TodoChecklist model={todoModel} />}
            onOpenChange={() => undefined}
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
        }
        transcript={
          store && threadId ? (
            <ThreadShell
              slots={{
                renderMessage: (message) => (
                  <MessageParts message={message} toolRenderers={toolRenderers} />
                ),
              }}
              store={store}
            />
          ) : (
            <EmptyTranscript state={history} />
          )
        }
      />
    </AssistantRuntimeProvider>
  );
}

function ConnectedApp({
  client,
  capabilities,
  launchFolder,
}: {
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly capabilities: CapabilityMap;
  readonly launchFolder: FolderPath;
}) {
  const connection = useAppConnection();
  const lastInstanceId = useRef<string | undefined>(undefined);
  const [folderText, setFolderText] = useState(() => readSessionValue(FOLDER_KEY, launchFolder));
  const folder = FolderPath.safeParse(folderText).success ? FolderPath.parse(folderText) : null;
  const [folderError, setFolderError] = useState<string | null>(null);
  const [recentFolders, setRecentFolders] = useState<readonly FolderPath[]>([]);
  const [title, setTitle] = useState("New conversation");
  const sessionFiles = useMemo(() => client.port(SessionFileStore), [client]);
  const rpc = useMemo(() => client.port(RpcSessionPort), [client]);
  const catalog = useMemo(() => {
    if (!folder) return null;
    return new SessionCatalogModel({
      scope: { kind: "folder", folder },
      sessionFiles: {
        listSessions: sessionFiles.listSessions,
        readSession: sessionFiles.readSession,
      },
    });
  }, [folder, sessionFiles]);
  const controller = useMemo<SelectedThreadHistoryController | null>(() => {
    if (!folder) return null;
    return createSelectedThreadHistoryController({
      client,
      folder,
      onThreadIdChange: (threadId) =>
        writeSessionValue(THREAD_KEY, threadId ? String(threadId) : null),
    });
  }, [client, folder]);
  const remote = useMemo(
    () =>
      catalog
        ? createNativeRemoteThreadListAdapter({
            catalog,
            open: rpc.open,
            send: rpc.send,
          })
        : null,
    [catalog, rpc.open, rpc.send],
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
    // Reopen the thread this browser had open in this folder (cleared when the folder changes).
    if (!controller) return;
    const saved = ThreadId.safeParse(readSessionValue(THREAD_KEY, ""));
    if (!saved.success) return;
    void controller.openExisting(saved.data).catch(() => writeSessionValue(THREAD_KEY, null));
  }, [controller]);
  useEffect(() => {
    // omp writes a new session's file during its first turn, so list the folder again whenever a
    // turn settles; the sidebar then shows the session it just created and its updated title.
    const store = history.store;
    if (!store || !catalog || !folder) return;
    let settled = store.getSnapshot().prompt.sessionSettled;
    return store.subscribe(() => {
      const next = store.getSnapshot().prompt.sessionSettled;
      if (next && !settled) {
        void catalog
          .list({ filter: { scope: { kind: "folder", folder }, query: "" }, limit: 100 })
          .catch(() => undefined);
      }
      settled = next;
    });
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
  const activeCapabilities = history.capabilities
    ? { ...capabilities, ...history.capabilities }
    : capabilities;
  useEffect(() => {
    if (!catalog || !history.threadId || !folder) {
      setTitle("New conversation");
      return;
    }
    let active = true;
    void (async () => {
      try {
        await catalog.list({
          filter: { scope: { kind: "folder", folder }, query: "" },
          limit: 100,
        });
        const metadata = await catalog.fetch(history.threadId as ThreadId);
        if (active) setTitle(metadata.title ?? "Conversation");
      } catch {
        if (active) setTitle("Conversation");
      }
    })();
    return () => {
      active = false;
    };
  }, [catalog, folder, history.threadId]);
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
  const openThread = async (threadId: ThreadId): Promise<void> => {
    await controller?.openExisting(threadId);
  };
  const leftSidebar = (
    <div className="flex min-h-0 flex-1 flex-col">
      <FolderSwitcher
        error={folderError}
        folder={folder}
        onFolderChange={selectFolder}
        onOtherFolder={validateOtherFolder}
        recentFolders={[launchFolder, ...recentFolders]}
      />
      {catalog && remote && (
        <div className="min-h-0 flex-1 pt-10">
          <SessionCatalogSidebar
            catalog={catalog}
            currentThreadId={history.threadId}
            onNewChat={openThread}
            onOpenThread={openThread}
            remote={remote}
          />
        </div>
      )}
    </div>
  );
  if (history.store && history.threadId) {
    return (
      <ActiveThreadContent
        capabilities={activeCapabilities}
        client={client}
        history={history}
        leftSidebar={leftSidebar}
        title={title}
      />
    );
  }
  return (
    <div className="h-dvh" data-app-root="true">
      <AppShell
        leftSidebar={leftSidebar}
        rightSidebar={<div className="text-muted-foreground p-4 text-sm">No panel selected.</div>}
        transcript={<EmptyTranscript state={history} />}
      />
    </div>
  );
}

function ConnectedRoot() {
  const connection = useAppConnection();
  const client = connection.client;
  const [capabilities, setCapabilities] = useState<CapabilityMap>(EMPTY_CAPABILITIES);
  const [serverInfo, setServerInfo] = useState<AppServerInfo>();
  useEffect(() => {
    if (!client) return;
    let active = true;
    const app = client.port(AppPort);
    void Promise.all([app.capabilities({}), app.serverInfo({})])
      .then(([nextCapabilities, nextServerInfo]) => {
        if (!active) return;
        setCapabilities(nextCapabilities);
        setServerInfo(nextServerInfo);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);
  if (!client || !serverInfo) return null;
  return (
    <RegistryProvider capabilities={capabilities} registry={registry} renderers={RENDERERS}>
      <OverlayHost>
        <ConnectedApp
          capabilities={capabilities}
          client={client}
          launchFolder={serverInfo.launchFolder}
        />
      </OverlayHost>
    </RegistryProvider>
  );
}

export function AppRoot() {
  return (
    <AppConnectionProvider>
      <AccessibilityProvider>
        <AppConnectionGate>
          <ConnectedRoot />
        </AppConnectionGate>
      </AccessibilityProvider>
    </AppConnectionProvider>
  );
}

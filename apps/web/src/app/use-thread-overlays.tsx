import type { OmpWire, RpcSessionClient } from "@omp-app/contracts";
import {
  AppFailure,
  type CapabilityMap,
  EntryId,
  OmpCommandGateway,
  type PortClient,
  type RpcSessionPort,
  type ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useImportFromShare } from "@/modules/D4/fork";
import type {
  SessionCapabilitiesSource,
  SessionInfoMetadataSource,
  SessionInfoRuntimeSource,
} from "@/modules/D5/contract";
import { SessionLifecycleController } from "@/modules/D5/lifecycle/commands";
import type { P3EditTarget } from "@/modules/P3/runs";
import { p3EditTargetFromSelection } from "@/modules/P3/runs";
import { captureP3EditSource } from "@/modules/P3/runs/source";
import { useP3PreviousMessageSelectorController } from "@/modules/P3/selector";
import type { QueueController } from "@/modules/R0/actions";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { SessionCatalogSidebar } from "@/modules/R1/ui";
import { renderDialogRequest } from "@/modules/U4/dialogs";
import { openChatDeleteConfirm } from "@/modules/U4/dialogs/confirm-chat-delete";
import { DialogHostController, useDisposeWhenReplaced } from "@/modules/U4/host";
import type { OverlayHostApi } from "@/overlay";
import { useStableOverlayHost } from "@/overlay";
import { watchSavedCompactions } from "./compaction-watch";
import { composerInput } from "./composer-input";
import { browserClipboard, useCopyFromChat } from "./copy/use-copy-from-chat";
import { exportSlashCommandsFor } from "./export/export-commands";
import { useChatSessionInfo } from "./owned-stores";
import { saveTextFile } from "./save-file";
import { useShareFromChat } from "./share/use-share-from-chat";
import type { ActiveThreadProps } from "./thread-props";

interface ThreadDialogsInput {
  readonly commandStatus: string | null;
  readonly commandError: string | null;
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
  readonly setCommandError: Dispatch<SetStateAction<string | null>>;
  readonly client: ActiveThreadProps["client"];
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly onRefreshAfterCommand: ActiveThreadProps["onRefreshAfterCommand"];
}

export function useThreadDialogs({
  commandStatus,
  commandError,
  setCommandStatus,
  setCommandError,
  client,
  threadId,
  capabilities,
  onRefreshAfterCommand,
}: ThreadDialogsInput) {
  // A header message about a palette command goes away on its own; an error that stayed until the
  // next command left "could not be started" on screen long after the moment had passed.
  useEffect(() => {
    if (commandStatus === null && commandError === null) return;
    const timer = window.setTimeout(() => {
      setCommandStatus(null);
      setCommandError(null);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [commandStatus, commandError, setCommandStatus, setCommandError]);
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
  return { overlay, commandGateway, answerExtensionUiRef, dialogHost };
}

interface ThreadChatActionsInput {
  readonly rpc: PortClient<typeof RpcSessionPort>;
  readonly capabilities: CapabilityMap;
  readonly branchAvailable: boolean;
  readonly dialogHost: DialogHostController;
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly setEditing: Dispatch<SetStateAction<P3EditTarget | null>>;
  readonly commandGateway: PortClient<typeof OmpCommandGateway>;
  readonly onLoadOlder: ActiveThreadProps["onLoadOlder"];
  readonly client: ActiveThreadProps["client"];
  readonly folder: ActiveThreadProps["folder"];
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
  readonly setCommandError: Dispatch<SetStateAction<string | null>>;
  readonly openThread: ActiveThreadProps["openThread"];
}

export function useThreadChatActions({
  rpc,
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
}: ThreadChatActionsInput) {
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
  return { selectorController, exportCommands, shareController };
}

interface ThreadSessionInfoInput {
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly catalog: ActiveThreadProps["catalog"];
  readonly capabilities: CapabilityMap;
  readonly remote: ActiveThreadProps["remote"];
  readonly commandGateway: PortClient<typeof OmpCommandGateway>;
  readonly dialogHost: DialogHostController;
  readonly overlay: OverlayHostApi;
  readonly openThread: ActiveThreadProps["openThread"];
}

export function useThreadSessionInfo({
  store,
  threadId,
  catalog,
  capabilities,
  remote,
  commandGateway,
  dialogHost,
  overlay,
  openThread,
}: ThreadSessionInfoInput) {
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
  return { lifecycle, openSessionBrowser };
}

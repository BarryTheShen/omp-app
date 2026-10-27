import {
  AttachmentBlobStore,
  type CapabilityMap,
  type ChatSessionClient,
  type ChatSessionRequest,
  DraftScope,
  MAX_ATTACHMENT_BYTES,
  type ThreadId,
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
import type { P3Runs } from "@/modules/P3/runs";
import { useP3RunHandlers } from "@/modules/P3/runs";
import { useQueueOpen } from "@/modules/P6/bar/bar";
import { createQueueAdapter } from "@/modules/P6/contract";
import type { QueueController } from "@/modules/R0/actions";
import { createQueueController } from "@/modules/R0/actions";
import type { StoppedQueue } from "@/modules/R0/runtime";
import { useOmpRuntime } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { useThreadScrollController } from "@/modules/U1/scroll";
import { AttachmentManager } from "@/modules/U2/attachments";
import { createAttachmentBlobStore } from "@/modules/U2/attachments/blob-store";
import type { AttachmentAdapter } from "@/modules/U2/contract";
import { createDraftStoreAdapter } from "@/modules/U2/drafts";
import type { OverlayHostApi } from "@/overlay";
import type { AgentHubOpenResult } from "./agents/agent-hub-shortcut";
import { useAgentHubShortcut } from "./agents/agent-hub-shortcut";
import { useComposerClipboardShortcuts } from "./composer-clipboard";
import { reportDraftFailure } from "./draft-owner";
import { useRetryShortcut } from "./p3-retry-shortcut";
import { imageUploadTo, restoreStoppedQueueIntoSavedDraft } from "./queue-stop-saved-draft";
import { openSessionModelDialog } from "./session-controls";
import { useSessionModelShortcuts } from "./session-model-shortcuts";
import type { ActiveThreadProps } from "./thread-props";

interface ThreadRuntimeInput {
  readonly client: ActiveThreadProps["client"];
  readonly capabilities: CapabilityMap;
  readonly folder: ActiveThreadProps["folder"];
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly chat: ChatSessionClient;
  readonly guardedSend: ChatSessionRequest;
  readonly messageSend: ChatSessionRequest;
  readonly switchChat: ActiveThreadProps["switchChat"];
  readonly p3Runs: P3Runs;
  readonly overlay: OverlayHostApi;
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
  readonly setCommandError: Dispatch<SetStateAction<string | null>>;
  readonly openAgentHub: () => Promise<AgentHubOpenResult>;
  readonly answerDialogRef: { current: QueueController["answerDialog"] | null };
}

export function useThreadRuntime({
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
}: ThreadRuntimeInput) {
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
    await chat.restart({ threadId });
  }, [chat, threadId]);
  useRetryShortcut({ threadId, status: p3Runs.status, retry: p3Handlers.retry });
  useAgentHubShortcut(openAgentHub);
  useComposerClipboardShortcuts({ notify: setCommandStatus, fail: setCommandError });
  useSessionModelShortcuts({
    client,
    store,
    threadId,
    capabilities,
    folder,
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
    notify: setCommandStatus,
    fail: setCommandError,
  });
  // Stop hands back what omp withdrew. The box takes it while it holds the stopped chat's own draft; otherwise the
  // stopped chat keeps it in its saved draft by its thread id. The answer can come after the person has left that chat,
  // and this callback is the one of the chat the Stop was made in, so the box decides when the answer comes.
  const restoreStoppedRef = useRef<((stopped: StoppedQueue) => boolean) | null>(null);
  const uploadRestoredImage = useMemo(
    () => imageUploadTo(createAttachmentBlobStore(client.port(AttachmentBlobStore))),
    [client],
  );
  const handleQueueRestored = useCallback(
    (stopped: StoppedQueue) => {
      if (restoreStoppedRef.current?.(stopped) === true) return;
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
    [client, uploadRestoredImage],
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
    answerDialogRef.current = (id, answer, options) =>
      queueController.answerDialog(id, answer, options);
    return () => {
      answerDialogRef.current = null;
    };
  }, [queueController, answerDialogRef]);
  const queueAdapter = useMemo(() => createQueueAdapter(queueController), [queueController]);
  const queueOpen = useQueueOpen(queueAdapter);
  return {
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
  };
}

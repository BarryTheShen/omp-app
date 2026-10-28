import type { Omp, ThreadId } from "@omp-app/contracts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import type { QueueAdapterController } from "@/modules/P6/contract/contract";
import type { StoppedQueue } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { AttachmentManager } from "@/modules/U2/attachments";
import type { DraftRestoreRequest } from "@/modules/U2/contract";
import {
  type ChatMessagesSource,
  createDraftStoreAdapter,
  deletedChatIds,
  localDraftBuffer,
  localDraftStorage,
  removeDeletedChatCopies,
  useChatDraft,
} from "@/modules/U2/drafts";
import { userPromptsIn } from "@/modules/U2/history";
import { reportDraftFailure } from "./draft-owner";
import { useQueueDequeueShortcut } from "./queue-dequeue-shortcut";
import {
  composeRestoredDraft,
  restoredCount,
  restoredQueueText,
  STOP_RESTORED_NOTICE,
} from "./queue-stop-restore";
import type { ImageUpload } from "./queue-stop-saved-draft";
import { storeQueueImages, storeRestoredImages } from "./queue-stop-saved-draft";
import type { ActiveThreadProps } from "./thread-props";

function isSentMessageRole(role: string | undefined): boolean {
  return role === "user" || role === "bashExecution" || role === "pythonExecution";
}
const NO_MESSAGE_ORDER = { messageOrder: [] as readonly string[] };
/** The messages of a chat that is not open yet: none, so a New chat starting keeps its draft in the folder's. */
const NO_CHAT_MESSAGES: ChatMessagesSource = {
  subscribe: () => () => undefined,
  getSnapshot: () => NO_MESSAGE_ORDER,
};

interface ThreadDraftsInput {
  readonly client: ActiveThreadProps["client"];
  readonly history: ActiveThreadProps["history"];
  readonly newChatStarting: boolean;
  readonly store: OmpRuntimeStore;
  readonly folder: ActiveThreadProps["folder"];
  readonly threadId: ThreadId;
  readonly attachmentManager: AttachmentManager;
  readonly uploadRestoredImage: ImageUpload;
  readonly restoreStoppedRef: { current: ((stopped: StoppedQueue) => boolean) | null };
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
  readonly setCommandError: Dispatch<SetStateAction<string | null>>;
  readonly queueAdapter: QueueAdapterController;
}

export function useThreadDrafts({
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
}: ThreadDraftsInput) {
  const draftStore = useMemo(() => createDraftStoreAdapter(client), [client]);
  // Unsent text is also kept in this tab, so it survives the app's server stopping before the autosave saves it.
  const draftBuffer = useMemo(
    () => localDraftBuffer(reportDraftFailure("Keeping unsent draft text in this tab failed")),
    [],
  );
  // A chat this browser deleted leaves no unsent copy behind: on load, the copies of the chats it recorded are removed.
  useEffect(() => {
    const storage = localDraftStorage();
    if (storage === undefined) return;
    const onError = reportDraftFailure("Removing a deleted chat's local copy failed");
    const deleted = deletedChatIds(storage, onError);
    void removeDeletedChatCopies(storage, async (threadId) => !deleted.has(threadId), onError);
  }, []);
  const chatMessages = useMemo(
    () =>
      newChatStarting
        ? NO_CHAT_MESSAGES
        : {
            subscribe: (listener: () => void) => store.subscribe(listener),
            getSnapshot: () => {
              const snapshot = store.getSnapshot();
              return {
                messageOrder: snapshot.messageOrder,
                hasUserMessage: snapshot.messageOrder.some((key) =>
                  isSentMessageRole(snapshot.messages[key]?.message.role),
                ),
              };
            },
            userPrompts: () => userPromptsIn(store.getSnapshot()),
          },
    [newChatStarting, store],
  );
  const startsUnsent = history.openedNew || newChatStarting;
  // The composer's draft: this chat's own draft once it has messages, the folder's new-chat draft before that.
  const chatDraft = useChatDraft({
    draftStore,
    folder,
    threadId,
    // A New chat that is starting takes the composer before its chat opens: its text and files are the folder's draft.
    startsUnsent,
    messages: chatMessages,
    loaded: !history.isLoading,
    buffer: draftBuffer,
  });
  // A message the chat did not have a moment ago is the send in progress, admitted: its draft clears then, not when the
  // answer comes, so a reload that lands first cannot bring the sent text back.
  const noteSent = chatDraft.noteSent;
  useEffect(() => {
    let shown = store.getSnapshot().messageOrder.length;
    return store.subscribe(() => {
      const count = store.getSnapshot().messageOrder.length;
      if (count > shown) noteSent();
      shown = count;
    });
  }, [noteSent, store]);
  const draftController = chatDraft.controller;
  const setEditorText = useCallback(
    (text: string) => draftController.setDraft(text, attachmentManager.toDraftRefs()),
    [attachmentManager, draftController],
  );

  // Stop with queued messages, into this box: the withdrawn images are stored and the draft takes them ahead of its
  // attachments, and the text goes in ahead of what was typed. An answer that withdrew nothing changes nothing.
  const restoreIntoBox = useCallback(
    async (restored: Omp.AbortAndRestoreQueueResult): Promise<void> => {
      if (restoredCount(restored) === 0) return;
      const { refs, lost } = await storeRestoredImages(restored, uploadRestoredImage);
      draftController.setDraft(
        composeRestoredDraft(restoredQueueText(restored), draftController.getSnapshot().text),
        [...refs, ...attachmentManager.toDraftRefs()],
      );
      setCommandStatus(STOP_RESTORED_NOTICE);
      if (lost > 0) {
        setCommandError(
          lost === 1
            ? "A queued image could not be brought back into the message box."
            : "Some queued images could not be brought back into the message box.",
        );
      }
    },
    [attachmentManager, draftController, uploadRestoredImage, setCommandStatus, setCommandError],
  );
  // The box takes a Stop's answer only while it holds the stopped chat's own draft. A New chat's box holds the folder's
  // draft and another chat's box that chat's: false, and the stopped chat keeps it in its saved draft.
  const restoreStopped = useCallback(
    (stopped: StoppedQueue): boolean => {
      const { scope } = draftController.getSnapshot();
      if (scope.kind !== "thread" || scope.threadId !== stopped.threadId) return false;
      void restoreIntoBox(stopped.restored);
      return true;
    },
    [draftController, restoreIntoBox],
  );
  useLayoutEffect(() => {
    restoreStoppedRef.current = restoreStopped;
    return () => {
      restoreStoppedRef.current = null;
    };
  }, [restoreStopped, restoreStoppedRef]);

  const queueDraft = useCallback(
    (): DraftRestoreRequest => ({
      text: draftController.getSnapshot().text,
      attachmentRefs: attachmentManager.toDraftRefs(),
    }),
    [attachmentManager, draftController],
  );
  const restoreQueued = useCallback(
    async (request: DraftRestoreRequest, images: readonly Omp.ImageContent[] = []) => {
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
    [attachmentManager, draftController, uploadRestoredImage, setCommandError],
  );
  useQueueDequeueShortcut({
    queue: queueAdapter,
    draft: queueDraft,
    restore: restoreQueued,
    notify: setCommandStatus,
    fail: setCommandError,
  });
  return { chatDraft, draftController, setEditorText };
}

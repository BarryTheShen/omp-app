import {
  type AppError,
  AppFailure,
  type FolderPath,
  HostMetadataPort,
  type ModelChoice,
  type ThreadId,
} from "@omp-app/contracts";
import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import type { OpenFailure } from "@/app/open-failure";
import type { AppConnectionSnapshot } from "@/launch";
import { isSupersededOpen, type SelectedThreadHistoryController } from "@/modules/R1/history";
import type { NewChatStatus } from "@/modules/R1/ui";
import { otherFolderOf } from "./other-folder";
import { perfTraceStart } from "./perf-trace";
import {
  FOLDER_KEY,
  THREAD_KEY,
  UNSENT_CHAT_KEY,
  writeSessionValue,
  writeTabValue,
} from "./session-storage";

interface ChatOpenInput {
  readonly client: NonNullable<AppConnectionSnapshot["client"]>;
  readonly folder: FolderPath | null;
  readonly controller: SelectedThreadHistoryController | null;
  readonly reportOpenFailure: (threadId: ThreadId, error: AppError) => void;
  readonly unsentThread: { current: ThreadId | null };
  readonly setFolderText: Dispatch<SetStateAction<string>>;
  readonly setFolderError: Dispatch<SetStateAction<string | null>>;
  readonly setNewChat: Dispatch<SetStateAction<NewChatStatus>>;
  readonly setNewChatFrom: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setNewChatThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setOpenFailure: Dispatch<SetStateAction<OpenFailure | null>>;
}

export function useChatOpen({
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
}: ChatOpenInput) {
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
    writeTabValue(UNSENT_CHAT_KEY, null);
  };
  const validateOtherFolder = async (value: string): Promise<boolean> => {
    const typed = otherFolderOf(value);
    if (!typed.ok) {
      setFolderError(typed.message);
      return false;
    }
    try {
      await client.port(HostMetadataPort).read({ folder: typed.folder });
      selectFolder(typed.folder);
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
        // A pick a newer pick superseded never shows: the newer pick is the one on screen (issue 2212).
        if (isSupersededOpen(error)) return;
        // A selected chat whose model is unavailable reports the picker at the open surface, not as a duplicate error.
        if (error instanceof AppFailure && error.appError.code === "model_unavailable") {
          reportOpenFailure(threadId, error.appError);
        }
        throw error;
      }
      if (threadId === unsentThread.current) {
        writeSessionValue(THREAD_KEY, null);
        writeTabValue(UNSENT_CHAT_KEY, String(threadId));
      } else {
        unsentThread.current = null;
        writeSessionValue(THREAD_KEY, String(threadId));
        writeTabValue(UNSENT_CHAT_KEY, null);
      }
      setOpenFailure(null);
    },
    [controller, reportOpenFailure, setOpenFailure, unsentThread],
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
    async (threadId: ThreadId): Promise<boolean> => {
      perfTraceStart();
      setNewChatThreadId(null);
      try {
        await openThread(threadId);
      } catch (error) {
        if (controller !== null && controller.getSnapshot().error !== null) return false;
        throw error;
      }
      return true;
    },
    [controller, openThread, setNewChatThreadId],
  );
  // A switch to a chat a branch or a rewind made (a regenerate, an edit, a rewind). The chat on screen can still be the
  // source's store: omp moves the running session to the branch in place, so the chat is always opened again (PR 1645).
  const switchChat = useCallback(
    (threadId: ThreadId): Promise<void> => {
      setNewChatThreadId(null);
      return openHistoryChatThrough(threadId, (history) => history.openExisting(threadId));
    },
    [openHistoryChatThrough, setNewChatThreadId],
  );
  return {
    selectFolder,
    validateOtherFolder,
    openHistoryChat,
    pickCount,
    openThread,
    openStartedChat,
    openSidebarChat,
    switchChat,
  };
}

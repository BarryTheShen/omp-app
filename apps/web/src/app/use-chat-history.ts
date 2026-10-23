import {
  type AppError,
  AppFailure,
  type FolderPath,
  type PortClient,
  type RpcSessionPort,
  type SessionFileStore,
  ThreadId,
} from "@omp-app/contracts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { OpenFailure } from "@/app/open-failure";
import type { AppConnectionSnapshot } from "@/launch";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import {
  createSelectedThreadHistoryController,
  type SelectedThreadHistoryController,
  type SelectedThreadHistoryState,
} from "@/modules/R1/history";
import { createNativeRemoteThreadListAdapter, deleteChatFile } from "@/modules/R1/remote";
import type { NewChatStatus } from "@/modules/R1/ui";
import type { ReadingPlace } from "@/modules/U1/scroll";
import { readStoredReadingPlace } from "@/modules/U1/scroll";
import { hasLocalDraft, localDraftStorage, recordDeletedChat } from "@/modules/U2/drafts";
import type { OverlayHostApi } from "@/overlay";
import { reportDraftFailure } from "./draft-owner";
import { perfMark } from "./perf-trace";
import { openSavedChatModelPicker } from "./saved-chat-model-picker";
import {
  persistUnsentChatReload,
  readSessionValue,
  readTabValue,
  THREAD_KEY,
  UNSENT_CHAT_KEY,
  writeSessionValue,
  writeTabValue,
} from "./session-storage";
import type { CatalogCache, CatalogRefresh } from "./use-app-chat-state";

const EMPTY_HISTORY: SelectedThreadHistoryState = {
  threadId: undefined,
  store: undefined,
  capabilities: undefined,
  isLoading: false,
  isSwitching: false,
  error: null,
  openedNew: false,
};

interface ChatHistoryInput {
  readonly client: NonNullable<AppConnectionSnapshot["client"]>;
  readonly folder: FolderPath | null;
  readonly rpc: PortClient<typeof RpcSessionPort>;
  readonly sessionFiles: PortClient<typeof SessionFileStore>;
  readonly catalogCache: CatalogCache;
  readonly catalog: SessionCatalogModel | null;
  readonly catalogRefresh: CatalogRefresh;
  readonly overlay: OverlayHostApi;
  readonly unsentThread: { current: ThreadId | null };
  readonly openingUnsentThread: { current: boolean };
  readonly newChat: NewChatStatus;
  readonly newChatFrom: ThreadId | null;
  readonly setNewlyStartedThread: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setOpenFailure: Dispatch<SetStateAction<OpenFailure | null>>;
  readonly setResumePlace: Dispatch<SetStateAction<ReadingPlace | null>>;
  readonly setRecentFolders: Dispatch<SetStateAction<readonly FolderPath[]>>;
}

export function useChatHistory({
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
}: ChatHistoryInput) {
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
      onThreadIdChange: (threadId) => {
        const pendingUnsent = readTabValue(UNSENT_CHAT_KEY, "");
        if (
          pendingUnsent !== "" &&
          threadId !== unsentThread.current &&
          !openingUnsentThread.current
        )
          return;
        if (
          threadId !== undefined &&
          (threadId === unsentThread.current || openingUnsentThread.current)
        ) {
          unsentThread.current = threadId;
          if (openingUnsentThread.current) setNewlyStartedThread(threadId);
          persistUnsentChatReload(threadId);
          return;
        }
        writeSessionValue(THREAD_KEY, threadId ? String(threadId) : null);
        writeTabValue(UNSENT_CHAT_KEY, null);
      },
      onPerfMark: perfMark,
      // A chat left while its turn runs: its file is written after the turn starts, so no change event announces the
      // turn. The list is read now, and the row shows the turn as running.
      onLeftRunning: readList,
      // A turn ended after its chat was left: the list gets the row the chat wrote, not when the person comes back.
      onTurnSettled: readList,
    });
  }, [
    catalogCache,
    catalogRefresh,
    client,
    folder,
    openingUnsentThread,
    unsentThread,
    setNewlyStartedThread,
  ]);
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
    [client, controller, folder, overlay, setOpenFailure],
  );
  const remote = useMemo(
    () =>
      catalog
        ? createNativeRemoteThreadListAdapter({
            catalog,
            open: rpc.open,
            close: rpc.close,
            rename: rpc.rename,
            deleteThread: async (threadId) => {
              await deleteChatFile({ threadId, catalog, sessionFiles });
              const storage = localDraftStorage();
              if (storage !== undefined) {
                recordDeletedChat(
                  storage,
                  threadId,
                  reportDraftFailure("Removing a deleted chat's local copy failed"),
                );
              }
            },
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
  }, [sessionFiles, setRecentFolders]);
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
    if (!controller) return;
    const openNewAfterReload = (): void => {
      openingUnsentThread.current = true;
      void controller
        .openNew()
        .catch(() => undefined)
        .finally(() => {
          openingUnsentThread.current = false;
        });
    };
    // Reopen the thread this browser had open in this folder. An unsent chat is represented by its tab marker: after
    // reload it starts a fresh chat, whose composer restores the same folder-scoped draft.
    const saved = ThreadId.safeParse(readSessionValue(THREAD_KEY, ""));
    const hasUnsentChat = readTabValue(UNSENT_CHAT_KEY, "") !== "";
    if (!saved.success) {
      if (folder !== null && (hasUnsentChat || hasLocalDraft({ kind: "folder", folder })))
        openNewAfterReload();
      return;
    }
    writeTabValue(UNSENT_CHAT_KEY, null);
    // A reload returns the reader to the message they were reading. The place is read before the chat opens.
    setResumePlace(readStoredReadingPlace(saved.data));
    void controller
      .reopenSaved(saved.data)
      .catch((error: unknown) => {
        // A saved chat whose model is unavailable stays on the empty/open-failure surface so the person can choose a model.
        if (error instanceof AppFailure && error.appError.code === "model_unavailable") {
          reportOpenFailure(saved.data, error.appError);
          return;
        }
        writeSessionValue(THREAD_KEY, null);
        if (folder !== null && (hasUnsentChat || hasLocalDraft({ kind: "folder", folder })))
          openNewAfterReload();
      })
      .finally(() => setResumePlace(null));
  }, [controller, folder, reportOpenFailure, setResumePlace, openingUnsentThread]);
  return { controller, reportOpenFailure, remote, history, displayedHistory };
}

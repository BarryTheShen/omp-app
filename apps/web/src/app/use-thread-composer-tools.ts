import type { ThreadId } from "@omp-app/contracts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppConnectionSnapshot } from "@/launch";
import { FAST_REFUSAL_NOTICE_SOURCE } from "@/modules/D7/modes";
import { transcriptNoticeSource } from "@/modules/N1/feedback";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { DraftController } from "@/modules/U2/drafts";
import { createStorePromptSource } from "@/modules/U2/history";
import { useComposerEditingShortcuts } from "./composer-editing";
import { type ExternalEditRequest, useExternalEditorShortcut } from "./external-editor-dialog";
import { useHistorySearchShortcut } from "./history-search-dialog";
import { useNotificationProjector } from "./notification-projector";

interface ThreadComposerToolsInput {
  readonly store: OmpRuntimeStore;
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
  readonly draftController: DraftController;
  readonly setEditorText: (text: string) => void;
  readonly connection: AppConnectionSnapshot;
  readonly threadId: ThreadId;
}

export function useThreadComposerTools({
  store,
  setCommandStatus,
  draftController,
  setEditorText,
  connection,
  threadId,
}: ThreadComposerToolsInput) {
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
  return {
    historySearchOpen,
    setHistorySearchOpen,
    readPrompts,
    editRequest,
    setEditRequest,
    notificationProjector,
    chatHasMessages,
    transcriptNotices,
    retireFastRefusalNotice,
  };
}

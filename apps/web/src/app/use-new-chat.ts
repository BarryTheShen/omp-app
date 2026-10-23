import { AppFailure, type ThreadId } from "@omp-app/contracts";
import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import type { SelectedThreadHistoryController } from "@/modules/R1/history";
import type { NewChatStatus } from "@/modules/R1/ui";
import { unsentChatReloadMarker } from "@/modules/U2/drafts";
import { type NewChatOutcome, type NewChatTicket, openNewChatTicket } from "./new-chat-outcome";
import { perfTraceStart } from "./perf-trace";
import {
  persistUnsentChatReload,
  readTabValue,
  UNSENT_CHAT_KEY,
  writeTabValue,
} from "./session-storage";
import type { ActiveThreadProps } from "./thread-props";

interface NewChatInput {
  readonly controller: SelectedThreadHistoryController | null;
  readonly unsentThread: { current: ThreadId | null };
  readonly setNewChat: Dispatch<SetStateAction<NewChatStatus>>;
  readonly setNewChatFrom: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setNewChatThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setNewlyStartedThread: Dispatch<SetStateAction<ThreadId | null>>;
  readonly openStartedChat: (threadId: ThreadId) => Promise<void>;
}

export function useNewChat({
  controller,
  unsentThread,
  setNewChat,
  setNewChatFrom,
  setNewChatThreadId,
  setNewlyStartedThread,
  openStartedChat,
}: NewChatInput) {
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
        unsentThread.current = null;
        setNewlyStartedThread(null);
        persistUnsentChatReload();
        perfTraceStart();
        const shownThreadId = controller?.getSnapshot().threadId;
        if (shownThreadId !== undefined) setNewChatFrom(shownThreadId);
        for (const release of newChatHolds.current.splice(0)) release();
        newChatHolds.current.push(controller?.holdSwitch() ?? (() => undefined));
        newChatTicketRef.current?.settle("not-opened");
        newChatTicketRef.current = openNewChatTicket();
        return;
      }
      if (readTabValue(UNSENT_CHAT_KEY, "") === unsentChatReloadMarker())
        writeTabValue(UNSENT_CHAT_KEY, null);
      newChatTicketRef.current?.settle("not-opened");
      newChatTicketRef.current = null;
      newChatHolds.current.pop()?.();
    },
    [controller, unsentThread, setNewChatFrom, setNewlyStartedThread, setNewChat],
  );
  const openNewChatFromSidebar = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      setNewChatThreadId(threadId);
      unsentThread.current = threadId;
      setNewlyStartedThread(threadId);
      persistUnsentChatReload(threadId);
      newChatHolds.current.at(-1)?.();
      newChatTicketRef.current?.settle("opened");
      newChatTicketRef.current = null;
      return openStartedChat(threadId);
    },
    [openStartedChat, setNewChatThreadId, unsentThread, setNewlyStartedThread],
  );
  return { newChatOutcomeNow, reportNewChat, openNewChatFromSidebar };
}

interface StartChatInput {
  readonly remote: ActiveThreadProps["remote"];
  readonly unsentThread: { current: ThreadId | null };
  readonly setNewlyStartedThread: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setNewChatThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  readonly openStartedChat: (threadId: ThreadId) => Promise<void>;
}

export function useStartChat({
  remote,
  unsentThread,
  setNewlyStartedThread,
  setNewChatThreadId,
  openStartedChat,
}: StartChatInput) {
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
    unsentThread.current = started;
    setNewlyStartedThread(started);
    setNewChatThreadId(started);
    persistUnsentChatReload(started);
    await openStartedChat(started);
    return started;
  }, [openStartedChat, remote, unsentThread, setNewlyStartedThread, setNewChatThreadId]);
  return { startChat };
}

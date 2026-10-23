import type { CapabilityMap, FolderPath, ThreadId } from "@omp-app/contracts";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from "react";
import type { AppConnectionSnapshot } from "@/launch";
import { createP3Runs } from "@/modules/P3/runs";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import {
  watchSessionFileChanges,
  watchSessionRunningChanges,
} from "@/modules/R1/catalog/session-changes";
import type {
  SelectedThreadHistoryController,
  SelectedThreadHistoryState,
} from "@/modules/R1/history";
import { isCurrentUnsentChat } from "@/modules/U2/drafts";
import {
  readSessionValue,
  readTabValue,
  THREAD_KEY,
  UNSENT_CHAT_KEY,
  writeSessionValue,
  writeTabValue,
} from "./session-storage";
import { useSessionTitle } from "./session-title";
import { finishedAnswerAt } from "./turn-end";
import type { CatalogCache, CatalogRefresh } from "./use-app-chat-state";

export interface TurnWatchRef {
  current: { armed: boolean; before: number | undefined; started: boolean };
}

interface ChatTurnsInput {
  readonly history: SelectedThreadHistoryState;
  readonly unsentThread: { current: ThreadId | null };
  readonly newlyStartedThread: ThreadId | null;
  readonly setNewlyStartedThread: Dispatch<SetStateAction<ThreadId | null>>;
  readonly setNewChatThreadId: Dispatch<SetStateAction<ThreadId | null>>;
}

export function useChatTurns({
  history,
  unsentThread,
  newlyStartedThread,
  setNewlyStartedThread,
  setNewChatThreadId,
}: ChatTurnsInput) {
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
  const claimReloadTarget = useCallback((): (() => void) | undefined => {
    const threadId = history.threadId;
    if (
      threadId === undefined ||
      !isCurrentUnsentChat(threadId, unsentThread.current, newlyStartedThread)
    )
      return undefined;
    const previous = {
      savedThread: readSessionValue(THREAD_KEY, ""),
      unsentMarker: readTabValue(UNSENT_CHAT_KEY, ""),
      unsentThread: unsentThread.current,
      newlyStartedThread,
    };
    unsentThread.current = null;
    writeSessionValue(THREAD_KEY, String(threadId));
    writeTabValue(UNSENT_CHAT_KEY, null);
    setNewlyStartedThread((current) => (current === threadId ? null : current));
    return () => {
      if (
        readSessionValue(THREAD_KEY, "") !== String(threadId) ||
        readTabValue(UNSENT_CHAT_KEY, "") !== ""
      )
        return;
      unsentThread.current = previous.unsentThread;
      writeSessionValue(THREAD_KEY, previous.savedThread === "" ? null : previous.savedThread);
      writeTabValue(UNSENT_CHAT_KEY, previous.unsentMarker === "" ? null : previous.unsentMarker);
      setNewlyStartedThread(previous.newlyStartedThread);
    };
  }, [history.threadId, newlyStartedThread, unsentThread, setNewlyStartedThread]);
  const onPromptSent = useCallback(() => {
    setNewChatThreadId(null);
    turnWatch.current = {
      armed: true,
      before: finishedAnswerAt(history.store?.getSnapshot()),
      started: false,
    };
  }, [history.store, setNewChatThreadId]);
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
  return { claimReloadTarget, onPromptSent, p3Runs, turnWatch };
}

interface ChatWatchersInput {
  readonly client: NonNullable<AppConnectionSnapshot["client"]>;
  readonly capabilities: CapabilityMap;
  readonly connection: AppConnectionSnapshot;
  readonly folder: FolderPath | null;
  readonly lastInstanceId: { current: string | undefined };
  readonly catalog: SessionCatalogModel | null;
  readonly catalogCache: CatalogCache;
  readonly catalogRefresh: CatalogRefresh;
  readonly history: SelectedThreadHistoryState;
  readonly displayedHistory: SelectedThreadHistoryState;
  readonly controller: SelectedThreadHistoryController | null;
  readonly turnWatch: TurnWatchRef;
}

export function useChatWatchers({
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
}: ChatWatchersInput) {
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
  }, [catalog, catalogRefresh, folder, history.store, turnWatch]);
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
  }, [client.instanceId, connection.state, controller, history.threadId, lastInstanceId]);
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
  return { activeCapabilities, title };
}

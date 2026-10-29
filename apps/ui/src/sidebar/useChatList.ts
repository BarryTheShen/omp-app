import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  AppFailure,
  ChatSessionPort,
  type FolderPath,
  type SessionFile,
  SessionFileStore,
  SessionPinStore,
  type ThreadId,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { forgetWindow } from "../chat/windowCache";

/** How long a burst of file and turn changes is gathered before the list is read again. */
const SETTLE_MS = 250;
const LIMIT = 50;

/** The launch folder's chats, kept current: which run a turn now, and which are pinned (omp's pins). */
export interface ChatList {
  readonly sessions: readonly SessionFile[];
  readonly running: ReadonlySet<ThreadId>;
  readonly pinned: ReadonlySet<ThreadId>;
  readonly setPinned: (id: ThreadId, pinned: boolean) => Promise<void>;
  /** Renames a chat, open or not; the list then shows the title omp saved (it trims and cleans what was typed). */
  readonly rename: (id: ThreadId, name: string) => Promise<void>;
  /**
   * Deletes a chat and its files. The server refuses a chat whose turn runs or that another tab holds, with its own
   * sentence; this tab's own panes do not count, so a chat may be deleted while one of them shows it.
   */
  readonly remove: (session: SessionFile) => Promise<void>;
}

/** Follows one subscription until the returned function runs; one that fails to start is left alone. */
function follow<Payload>(
  pending: Promise<AppClientSubscription<Payload>>,
  listener: (payload: Payload) => void,
): () => void {
  let active = true;
  let detach: (() => void) | undefined;
  let subscription: AppClientSubscription<Payload> | undefined;
  void pending
    .then((started) => {
      if (!active) {
        void started.unsubscribe().catch(() => undefined);
        return;
      }
      subscription = started;
      detach = started.onEvent(listener);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    detach?.();
    void subscription?.unsubscribe().catch(() => undefined);
  };
}

export function useChatList(client: AppClient, folder: FolderPath): ChatList {
  const [sessions, setSessions] = useState<readonly SessionFile[]>([]);
  const [running, setRunning] = useState<ReadonlySet<ThreadId>>(new Set());
  const [pins, setPins] = useState<{
    readonly ids: ReadonlySet<ThreadId>;
    readonly revision: string | null;
  }>({ ids: new Set(), revision: null });
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  /** Reads the list again now; a no-op once the folder's list is gone. */
  const reread = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const listed = await client.port(SessionFileStore).listSessions({ folder, limit: LIMIT });
      if (!active) return;
      setSessions(listed.sessions);
      setRunning(
        new Set([
          ...listed.sessions
            .filter((session) => session.turn === "running")
            .map((session) => session.id),
          ...(listed.running ?? []).map((chat) => chat.id),
        ]),
      );
    };
    const soon = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => void read().catch(() => undefined), SETTLE_MS);
    };
    void read().catch(() => undefined);
    reread.current = read;
    const stops = [
      follow(client.subscribe(SessionFileStore, "changed"), (change) => {
        if (change.folder === folder) soon();
      }),
      follow(client.subscribe(SessionFileStore, "runningChanged"), (change) => {
        if (change.folder !== folder) return;
        setRunning((current) => {
          const next = new Set(current);
          if (change.busy) next.add(change.id);
          else next.delete(change.id);
          return next;
        });
        // A turn's start or end can come with a file omp has just written.
        soon();
      }),
    ];
    return () => {
      active = false;
      reread.current = async () => undefined;
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [client, folder]);

  const readPins = useCallback(async (): Promise<void> => {
    const listed = await client.port(SessionPinStore).list({});
    setPins({ ids: new Set(listed.pins.map((pin) => pin.sessionId)), revision: listed.revision });
  }, [client]);

  useEffect(() => {
    void readPins().catch(() => undefined);
    return follow(client.subscribe(SessionPinStore, "changed"), () => {
      void readPins().catch(() => undefined);
    });
  }, [client, readPins]);

  const setPinned = useCallback(
    async (id: ThreadId, pinned: boolean): Promise<void> => {
      const set = () =>
        client.port(SessionPinStore).set({
          sessionId: id,
          pinned,
          expectedRevision: pinsRef.current.revision,
        });
      let result: Awaited<ReturnType<typeof set>>;
      try {
        result = await set();
      } catch (error) {
        // Pinned elsewhere meanwhile (omp's terminal, another window): read the pins again and try once more.
        if (!(error instanceof AppFailure && error.appError.code === "conflict")) throw error;
        await readPins();
        result = await set();
      }
      setPins((current) => {
        const ids = new Set(current.ids);
        if (result.pinned) ids.add(id);
        else ids.delete(id);
        return { ids, revision: result.revision };
      });
    },
    [client, readPins],
  );

  const rename = useCallback(
    async (id: ThreadId, name: string): Promise<void> => {
      await client.port(ChatSessionPort).rename({ threadId: id, name });
      await reread.current();
    },
    [client],
  );

  const remove = useCallback(
    async (session: SessionFile): Promise<void> => {
      // The chat's own folder is the one whose listing returns its file, so the server checks it there.
      await client
        .port(SessionFileStore)
        .deleteSession({ folder: session.cwd, sessionFile: session.sessionFile });
      forgetWindow(session.id);
      await reread.current();
    },
    [client],
  );

  return { sessions, running, pinned: pins.ids, setPinned, rename, remove };
}

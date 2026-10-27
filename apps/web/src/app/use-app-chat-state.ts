import {
  type ChatSessionClient,
  ChatSessionPort,
  FolderPath,
  type PortClient,
  RpcSessionPort,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenFailure } from "@/app/open-failure";
import { type AppConnectionSnapshot, useAppConnection } from "@/launch";
import { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import { createSessionCatalogRefreshScheduler } from "@/modules/R1/catalog/session-changes";
import type { NewChatStatus } from "@/modules/R1/ui";
import type { ReadingPlace } from "@/modules/U1/scroll";
import { useStableOverlayHost } from "@/overlay";
import { FOLDER_KEY, readSessionValue } from "./session-storage";

export interface CatalogRefresh {
  readonly request: (catalog: SessionCatalogModel, limit?: number) => void;
  readonly dispose: () => void;
}

export interface CatalogCache {
  readonly sessionFiles: PortClient<typeof SessionFileStore>;
  readonly models: Map<FolderPath, SessionCatalogModel>;
}

interface AppChatStateInput {
  readonly client: NonNullable<AppConnectionSnapshot["client"]>;
  readonly launchFolder: FolderPath;
}

export function useAppChatState({ client, launchFolder }: AppChatStateInput) {
  const connection = useAppConnection();
  const overlay = useStableOverlayHost();
  const lastInstanceId = useRef<string | undefined>(undefined);
  const [folderText, setFolderText] = useState(() => readSessionValue(FOLDER_KEY, launchFolder));
  // The place the reader was in when the page last closed: a reload that reopens the chat returns there.
  const [resumePlace, setResumePlace] = useState<ReadingPlace | null>(null);
  const folder = FolderPath.safeParse(folderText).success ? FolderPath.parse(folderText) : null;

  const [folderError, setFolderError] = useState<string | null>(null);
  const [openFailure, setOpenFailure] = useState<OpenFailure | null>(null);
  // The sidebar starts a New chat before the history controller opens it: its state shows here meanwhile.
  const [newChat, setNewChat] = useState<NewChatStatus>({ state: "idle" });
  /** The chat on screen when a New chat started: it stays visible while the new chat opens. */
  const [newChatFrom, setNewChatFrom] = useState<ThreadId | null>(null);
  const [newlyStartedThread, setNewlyStartedThread] = useState<ThreadId | null>(null);
  const unsentThread = useRef<ThreadId | null>(null);
  const openingUnsentThread = useRef(false);
  const [newChatThreadId, setNewChatThreadId] = useState<ThreadId | null>(null);
  const [recentFolders, setRecentFolders] = useState<readonly FolderPath[]>([]);
  const sessionFiles = useMemo(() => client.port(SessionFileStore), [client]);
  const rpc = useMemo(() => client.port(RpcSessionPort), [client]);
  const chat = useMemo(() => client.port(ChatSessionPort) as ChatSessionClient, [client]);
  // One catalog per folder for the life of the connection: going back to a folder shows its last
  // list at once, and a new connection starts clean.
  const catalogCache = useMemo(
    () => ({ sessionFiles, models: new Map<FolderPath, SessionCatalogModel>() }),
    [sessionFiles],
  );
  const catalog = useMemo(() => {
    if (!folder) return null;
    const cached = catalogCache.models.get(folder);
    if (cached) return cached;
    const created = new SessionCatalogModel({
      scope: { kind: "folder", folder },
      sessionFiles: {
        listSessions: catalogCache.sessionFiles.listSessions,
        readSessionRow: catalogCache.sessionFiles.readSessionRow,
      },
    });
    catalogCache.models.set(folder, created);
    return created;
  }, [catalogCache, folder]);
  const catalogRefresh = useMemo(() => createSessionCatalogRefreshScheduler(), []);
  useEffect(() => () => catalogRefresh.dispose(), [catalogRefresh]);
  return {
    connection,
    overlay,
    lastInstanceId,
    setFolderText,
    resumePlace,
    setResumePlace,
    folder,
    folderError,
    setFolderError,
    openFailure,
    setOpenFailure,
    newChat,
    setNewChat,
    newChatFrom,
    setNewChatFrom,
    newlyStartedThread,
    setNewlyStartedThread,
    unsentThread,
    openingUnsentThread,
    newChatThreadId,
    setNewChatThreadId,
    recentFolders,
    setRecentFolders,
    sessionFiles,
    rpc,
    chat,
    catalogCache,
    catalog,
    catalogRefresh,
  };
}

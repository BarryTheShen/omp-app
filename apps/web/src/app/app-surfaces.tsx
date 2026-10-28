import type {
  AppError,
  CapabilityMap,
  ChatSessionClient,
  FolderPath,
  ThreadId,
} from "@omp-app/contracts";
import { useCallback } from "react";
import { type AppConnectionSnapshot, ConnectionBanner, WatchNotice } from "@/launch";
import { LayoutArea, type Surface, type SurfaceMap } from "@/layout";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import type {
  SelectedThreadHistoryController,
  SelectedThreadHistoryState,
} from "@/modules/R1/history";
import { type NewChatStatus, SessionCatalogSidebar } from "@/modules/R1/ui";
import { openChatDeleteConfirm } from "@/modules/U4/dialogs/confirm-chat-delete";
import type { OverlayHostApi } from "@/overlay";
import { ShortcutPreferenceNotice, useShortcutPreferenceError } from "@/shortcuts";
import { ThemeButton } from "@/theme";
import { FolderSwitcher } from "./folder-switcher";
import { SettingsButton } from "./thread-chrome";
import type { ActiveThreadProps } from "./thread-props";
import type { CatalogRefresh } from "./use-app-chat-state";

interface AppSurfacesInput {
  readonly folder: FolderPath | null;
  readonly folderError: string | null;
  readonly selectFolder: (nextFolder: FolderPath) => void;
  readonly validateOtherFolder: (value: string) => Promise<boolean>;
  readonly launchFolder: FolderPath;
  readonly recentFolders: readonly FolderPath[];
  readonly catalog: SessionCatalogModel | null;
  readonly remote: ActiveThreadProps["remote"];
  readonly history: SelectedThreadHistoryState;
  readonly overlay: OverlayHostApi;
  readonly openNewChatFromSidebar: (threadId: ThreadId) => Promise<void>;
  readonly openSidebarChat: (threadId: ThreadId) => Promise<boolean>;
  readonly catalogRefresh: CatalogRefresh;
  readonly chat: ChatSessionClient;
  readonly controller: SelectedThreadHistoryController | null;
  readonly reportNewChat: (status: NewChatStatus) => void;
  /** The New chat that reported opening: a New chat clicked after it waits for its first send. */
  readonly openingNewChatTicketNow: ActiveThreadProps["newChatTicketNow"];
  /** A New chat click, before it waits for the New chat before it (issue 2758). */
  readonly requestNewChat: () => () => void;
  readonly reportOpenFailure: (threadId: ThreadId, error: AppError) => void;
  readonly capabilities: CapabilityMap;
  readonly openSettings: (threadId: ThreadId | null, restoreFocus?: HTMLElement) => void;
  readonly connection: AppConnectionSnapshot;
  readonly watchNotice: string | undefined;
  readonly onDismissWatchNotice: () => void;
}

export function useAppSurfaces({
  folder,
  folderError,
  selectFolder,
  validateOtherFolder,
  launchFolder,
  recentFolders,
  catalog,
  remote,
  history,
  overlay,
  openNewChatFromSidebar,
  openSidebarChat,
  catalogRefresh,
  chat,
  controller,
  reportNewChat,
  openingNewChatTicketNow,
  requestNewChat,
  reportOpenFailure,
  capabilities,
  openSettings,
  connection,
  watchNotice,
  onDismissWatchNotice,
}: AppSurfacesInput) {
  const waitForNewChatSend = useCallback(() => {
    const ticket = openingNewChatTicketNow();
    return ticket === null ? Promise.resolve(true) : ticket.waitForSettled();
  }, [openingNewChatTicketNow]);
  // What each sidebar surface id renders. Where it goes: `@/layout` (LAYOUT).
  const sidebarSurfaces: SurfaceMap = {
    folder: {
      title: "Workspace folder",
      render: () => (
        <FolderSwitcher
          error={folderError}
          folder={folder}
          onFolderChange={selectFolder}
          onOtherFolder={validateOtherFolder}
          recentFolders={[launchFolder, ...recentFolders]}
        />
      ),
    },
    sessions: {
      title: "Sessions",
      grow: true,
      render: () =>
        catalog && remote ? (
          <SessionCatalogSidebar
            catalog={catalog}
            currentThreadId={history.threadId}
            onNewChat={openNewChatFromSidebar}
            waitForNewChatSend={waitForNewChatSend}
            onOpenThread={openSidebarChat}
            confirmDelete={(_session, title, restoreFocus) =>
              openChatDeleteConfirm(overlay, title, undefined, restoreFocus)
            }
            confirmDeleteRunning={(title) =>
              openChatDeleteConfirm(
                overlay,
                title,
                "This chat is still running. Deleting it stops the run.",
              )
            }
            onDeletedOpenThread={() => controller?.close()}
            stopRunning={async (threadId) => {
              await chat.request({ threadId, method: "abort", params: {} });
            }}
            currentTurnRunning={() =>
              controller?.getSnapshot().store?.getSnapshot().prompt.streaming === true
            }
            requestRefresh={catalogRefresh.request}
            remote={remote}
            onNewChatStatus={reportNewChat}
            onNewChatRequested={requestNewChat}
            onOpenFailed={reportOpenFailure}
          />
        ) : null,
    },
    theme: { title: "Theme", render: () => <ThemeButton /> },
  };
  const leftSidebar = (
    <LayoutArea area="sidebar" capabilities={capabilities} surfaces={sidebarSurfaces} />
  );
  const shortcutPreferenceError = useShortcutPreferenceError();
  const emptyHeaderSurfaces: SurfaceMap = {
    title: {
      title: "Conversation",
      grow: true,
      render: () => (
        <div className="relative min-w-0 flex-1">
          <h1 className="min-w-0 truncate text-sm font-medium">New conversation</h1>
          {shortcutPreferenceError !== undefined && (
            <div className="absolute start-0 top-full z-10 flex w-max max-w-[min(26rem,calc(100vw-4.5rem))] flex-col pt-1">
              <ShortcutPreferenceNotice />
            </div>
          )}
        </div>
      ),
    },
    settings: {
      title: "Settings",
      render: () => <SettingsButton onOpenSettings={openSettings} threadId={null} />,
    },
  };

  // The connection banner: an open chat shows it in its footer, the empty shell at the bottom of its transcript.
  const connectionSurface: Surface = {
    title: "Connection",
    open: connection.state === "reconnecting",
    render: () => <ConnectionBanner unreachable={connection.unreachable} />,
  };
  // The watch notice: while the server cannot watch some files, changes made outside the app do not show yet.
  const watchSurface: Surface = {
    title: "Watched files",
    open: watchNotice !== undefined,
    render: () =>
      watchNotice === undefined ? null : (
        <WatchNotice detail={watchNotice} onDismiss={onDismissWatchNotice} />
      ),
  };
  const emptyTranscriptSurfaces: SurfaceMap = {
    connection: connectionSurface,
    watchNotice: watchSurface,
  };
  return {
    leftSidebar,
    emptyHeaderSurfaces,
    connectionSurface,
    watchSurface,
    emptyTranscriptSurfaces,
  };
}

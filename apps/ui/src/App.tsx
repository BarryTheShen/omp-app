import type { AppClient, ConnectionStateEvent } from "@omp-app/client";
import { AppPort, type FolderPath } from "@omp-app/contracts";
import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import { ConnectionBanner, REFUSED_WORDS } from "./ConnectionBanner";
import type { ChatController, ChatTarget } from "./chat/controller";
import { prefetchWindow } from "./chat/prefetch";
import { connect, readToken } from "./connection";
import { useWaitingNotifications } from "./desktop/notify";
import { FolderMenu } from "./folders/FolderMenu";
import { keepLinkFolder } from "./folders/folder";
import { useFolder } from "./folders/useFolder";
import { GoalDialog } from "./goal/GoalDialog";
import { KEYS } from "./keys/table";
import { Palette } from "./palette/Palette";
import { Shortcuts } from "./palette/Shortcuts";
import type { SettingsPlace } from "./settings/SettingsPage";
import { Sidebar } from "./sidebar/Sidebar";
import { useChatList } from "./sidebar/useChatList";
import { Workspace, type WorkspaceHandle, type WorkspaceView } from "./workspace/Workspace";

/** The settings sheet and omp's settings with it load when it first opens. */
const SettingsPage = lazy(() =>
  import("./settings/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "no-link" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "refused"; readonly refusal: NonNullable<ConnectionStateEvent["refusal"]> }
  | { readonly kind: "ready"; readonly client: AppClient; readonly folder: FolderPath };

/** Tailwind's `sm` breakpoint: below it, one pane. */
const PHONE = "(max-width: 639px)";

function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = matchMedia(PHONE);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => matchMedia(PHONE).matches,
  );
}

const NOTHING_OPEN: WorkspaceView = { focused: null, open: new Set(), waiting: new Map() };

/** Connects with the page's launch link, then shows the app. */
export function App(): ReactNode {
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });

  useEffect(() => {
    keepLinkFolder();
    const token = readToken();
    if (token === null) {
      setConnection({ kind: "no-link" });
      return;
    }
    const client = connect(token);
    let active = true;
    // A refused link says why in the banner's words, as soon as the server refuses it; before the app is ready, that is
    // all there is to show.
    const stopWatching = client.onConnectionState(({ refusal }) => {
      if (active && refusal !== undefined)
        setConnection((now) => (now.kind === "ready" ? now : { kind: "refused", refusal }));
    });
    void (async () => {
      try {
        const info = await client.port(AppPort).serverInfo({});
        if (active) setConnection({ kind: "ready", client, folder: info.launchFolder });
      } catch (error) {
        if (active)
          setConnection((now) =>
            now.kind === "refused"
              ? now
              : {
                  kind: "failed",
                  message: error instanceof Error ? error.message : String(error),
                },
          );
      }
    })();
    return () => {
      active = false;
      stopWatching();
      client.dispose();
    };
  }, []);

  // A link pasted into this tab changes only the address's `#token=…`, which loads nothing: reload to read the token.
  useEffect(() => {
    const onHashChange = (): void => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      if (token !== null && token.length > 0) window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (connection.kind === "no-link") {
    return <Note>Open the app with the link omp-app printed.</Note>;
  }
  if (connection.kind === "failed") {
    return <Note>Could not reach the app: {connection.message}</Note>;
  }
  if (connection.kind === "refused") {
    return <Note>{REFUSED_WORDS[connection.refusal]}</Note>;
  }
  if (connection.kind === "connecting") {
    return <Note>Connecting…</Note>;
  }
  return <Shell client={connection.client} launchFolder={connection.folder} />;
}

/**
 * The chosen folder's chats beside the workspace of chat panes (kitty's tabs and splits); on a phone, the list or one
 * chat. A click opens a chat in the focused pane, Alt+click beside it.
 */
function Shell({
  client,
  launchFolder,
}: {
  readonly client: AppClient;
  readonly launchFolder: FolderPath;
}): ReactNode {
  const choice = useFolder(client, launchFolder);
  const { folder } = choice;
  const list = useChatList(client, folder);
  const [view, setView] = useState<WorkspaceView>(NOTHING_OPEN);
  useWaitingNotifications(view.waiting);
  /** On a phone: the list of chats, or the chat. */
  const [showChat, setShowChat] = useState(false);
  const workspace = useRef<WorkspaceHandle>(null);
  const phone = usePhone();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  /** The chat the goal dialog sets a goal for, while it is open. */
  const [goalFor, setGoalFor] = useState<ChatController | null>(null);
  const [settings, setSettings] = useState(false);
  const [settingsPlace, setSettingsPlace] = useState<SettingsPlace>("app");
  /** Loaded once opened, so its closing keeps its words in place. */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  /** The chat focused when the settings opened: provider sign-in runs in it. */
  const [settingsChat, setSettingsChat] = useState<ChatController | null>(null);
  const openSettings = useCallback((place: SettingsPlace) => {
    setSettingsChat(workspace.current?.focused()?.controller ?? null);
    setSettingsPlace(place);
    setSettingsLoaded(true);
    setSettings(true);
  }, []);
  const showSettings = useCallback(() => openSettings("app"), [openSettings]);
  const showServers = useCallback(() => openSettings("server"), [openSettings]);
  const openChat = useCallback((target: ChatTarget, where: "here" | "split"): void => {
    workspace.current?.open(target, where);
    setShowChat(true);
  }, []);
  const showShortcuts = useCallback(() => setShortcuts(true), []);
  const anywhere = { enableOnFormTags: true, preventDefault: true } as const;
  useHotkeys(KEYS.palette.hotkey, () => setPalette((open) => !open), anywhere);
  useHotkeys(KEYS.shortcuts.hotkey, () => setShortcuts((open) => !open), anywhere);
  useHotkeys(
    KEYS.settings.hotkey,
    () => {
      if (settings) {
        setSettings(false);
        return;
      }
      showSettings();
    },
    anywhere,
    [settings, showSettings],
  );
  return (
    <div
      className="grid h-full grid-cols-[244px_minmax(0,1fr)] max-[1360px]:grid-cols-[224px_minmax(0,1fr)] max-sm:grid-cols-1"
      data-app-root="true"
    >
      <ConnectionBanner client={client} />
      <Sidebar
        folderMenu={<FolderMenu client={client} choice={choice} />}
        folder={folder}
        list={list}
        view={view}
        hidden={phone && showChat}
        onOpen={openChat}
        onPrefetch={(session) => prefetchWindow(client, session.id, session.sessionFile)}
        onDeleted={(id) => workspace.current?.forget(id)}
        onSettings={showSettings}
        workspace={workspace}
      />
      <main
        data-tour="workspace"
        className={cn(
          "my-1.5 mr-1.5 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-l2 bg-panel max-sm:m-0 max-sm:rounded-none max-sm:border-0",
          phone && !showChat && "hidden",
        )}
      >
        {phone && (
          <div className="flex px-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-t2"
              onClick={() => setShowChat(false)}
            >
              <ChevronLeft />
              Chats
            </Button>
          </div>
        )}
        <Workspace ref={workspace} client={client} folder={folder} phone={phone} onView={setView} />
      </main>
      <Palette
        open={palette}
        onOpenChange={setPalette}
        list={list}
        workspace={workspace}
        folder={folder}
        onOpenChat={openChat}
        onShortcuts={showShortcuts}
        onSetGoal={setGoalFor}
        onSettings={showSettings}
        onServers={showServers}
      />
      <Shortcuts open={shortcuts} onOpenChange={setShortcuts} />
      <GoalDialog controller={goalFor} onClose={() => setGoalFor(null)} />
      {settingsLoaded && (
        <Suspense fallback={null}>
          <SettingsPage
            client={client}
            folder={folder}
            controller={settingsChat}
            phone={phone}
            place={settingsPlace}
            open={settings}
            onOpenChange={setSettings}
          />
        </Suspense>
      )}
    </div>
  );
}

function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="grid h-full place-items-center px-6 text-center text-t3">{children}</p>;
}

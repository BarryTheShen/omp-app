import type { AppClient, ConnectionStateEvent } from "@omp-app/client";
import { AppPort, type FolderPath } from "@omp-app/contracts";
import { cn } from "cn";
import { ChevronLeft, SquarePen } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import { ConnectionBanner, REFUSED_WORDS } from "./ConnectionBanner";
import type { ChatController, ChatTarget } from "./chat/controller";
import { prefetchWindow } from "./chat/prefetch";
import { connect, readToken } from "./connection";
import { desktopBridge, openDesktopWindow, refusalText } from "./desktop/bridge";
import {
  useNotifySettings,
  useSettledNotifications,
  useWaitingNotifications,
} from "./desktop/notify";
import { FolderMenu } from "./folders/FolderMenu";
import { keepLinkFolder } from "./folders/folder";
import { useFolder } from "./folders/useFolder";
import { GoalDialog } from "./goal/GoalDialog";
import { inbox, setInboxOpen, useInbox } from "./inbox/inbox";
import { KEYS } from "./keys/table";
import { adoptThisPage } from "./pairing/adopt";
import { guessThisDevice } from "./pairing/device-name";
import { PairingScreen } from "./pairing/PairingScreen";
import { takePairingCode } from "./pairing/pairing-api";
import { RequestPrompt } from "./pairing/RequestPrompt";
import { Palette } from "./palette/Palette";
import { Shortcuts } from "./palette/Shortcuts";
import { PanelRail } from "./panels/PanelRail";
import { hidePanel, showPanel, togglePanel, usePanelState } from "./panels/panel-state";
import { SidePaneContext } from "./panels/SidePane";
import { SidePanel } from "./panels/SidePanel";
import { traceScrolling } from "./perf/scrollTrace";
import { traceViewport } from "./perf/viewportTrace";
import { isPhone, usePhone } from "./phone";
import type { SettingsPlace } from "./settings/SettingsPage";
import { Sidebar } from "./sidebar/Sidebar";
import { TitleMenu } from "./sidebar/TitleMenu";
import { useChatList } from "./sidebar/useChatList";
import { WhatsNewList } from "./tour/WhatsNewList";
import { Workspace, type WorkspaceHandle, type WorkspaceView } from "./workspace/Workspace";

/** The settings sheet and omp's settings with it load when it first opens. */
const SettingsPage = lazy(() =>
  import("./settings/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "no-link" }
  | { readonly kind: "pairing"; readonly linkRefused: boolean }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "refused"; readonly refusal: NonNullable<ConnectionStateEvent["refusal"]> }
  | { readonly kind: "ready"; readonly client: AppClient; readonly folder: FolderPath };

const NOTHING_OPEN: WorkspaceView = {
  focused: null,
  open: new Set(),
  waiting: new Map(),
  side: null,
};

/** Connects with the page's launch link, or as a paired device, then shows the app; a device not paired pairs first. */
export function App(): ReactNode {
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });
  // A QR code's one-time code, out of the address at once: a paired device that scans one keeps a clean address.
  const scannedCode = useRef<string | null>(null);

  useEffect(() => {
    keepLinkFolder();
    scannedCode.current ??= takePairingCode();
    const token = readToken();
    const client = connect(token);
    let active = true;
    // A refusal shows at once, before the app is ready: a device not paired pairs; a refused link says why.
    const stopWatching = client.onConnectionState(({ refusal }) => {
      if (!active || refusal === undefined) return;
      setConnection((now) => {
        if (now.kind === "ready") return now;
        if (refusal === "unpaired") return { kind: "pairing", linkRefused: false };
        // A server from before pairing refuses a page with no link as an invalid one.
        if (refusal === "invalid" && token === null) return { kind: "no-link" };
        return { kind: "refused", refusal };
      });
    });
    void (async () => {
      try {
        const info = await client.port(AppPort).serverInfo({});
        if (!active) return;
        setConnection({ kind: "ready", client, folder: info.launchFolder });
        // A page signed in with the launch link from another device becomes a paired device once.
        if (token !== null) void adoptThisPage(client, token, guessThisDevice());
      } catch (error) {
        // The call fails when the server refuses the page: the screen the refusal chose (pairing, no link, its words)
        // stays. A refusal that comes after the failure replaces it (above).
        if (active)
          setConnection((now) =>
            now.kind === "refused" || now.kind === "pairing" || now.kind === "no-link"
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

  if (connection.kind === "pairing") {
    return <PairingScreen linkRefused={connection.linkRefused} scannedCode={scannedCode.current} />;
  }
  if (connection.kind === "no-link") {
    return <Note>Open the app with the link omp-app printed.</Note>;
  }
  if (connection.kind === "failed") {
    return <Note>Could not reach the app: {connection.message}</Note>;
  }
  if (connection.kind === "refused") {
    if (connection.refusal === "expired" || connection.refusal === "invalid") {
      return (
        <div className="grid h-full place-items-center px-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <p className="text-t3">{REFUSED_WORDS[connection.refusal]}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConnection({ kind: "pairing", linkRefused: true })}
            >
              Pair this device instead
            </Button>
          </div>
        </div>
      );
    }
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
  // A turn that ends while the window is in the background, as omp's terminal notifies it (V19b).
  useSettledNotifications(useInbox(), useNotifySettings(client, folder));
  // How smoothly this page scrolls, measured on a sample of scrolls and kept in the server's debug log.
  useEffect(
    () =>
      traceScrolling((trace) => {
        client
          .port(AppPort)
          .reportClientTrace(trace)
          .catch(() => undefined);
      }),
    [client],
  );
  // How a phone's page fits around its keyboard, measured at each change and kept in the server's debug log.
  useEffect(
    () =>
      traceViewport((trace) => {
        client
          .port(AppPort)
          .reportClientTrace(trace)
          .catch(() => undefined);
      }),
    [client],
  );
  /** On a phone: the list of chats, or the chat. A phone opens on the chat: the workspace starts it on a new one. */
  const [showChat, setShowChat] = useState(isPhone);
  const workspace = useRef<WorkspaceHandle>(null);
  const phone = usePhone();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [whatsNew, setWhatsNew] = useState(false);
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
  /** On a phone: the workspace brought a chat forward by itself (a new tab, a tour's sandbox), so it shows. */
  const showChatView = useCallback(() => setShowChat(true), []);
  // The chat you are in is seen: what it settled with leaves the inbox when the focus moves to it, and when the page
  // comes to the front with it focused.
  useEffect(() => {
    const look = (): void => {
      if (document.visibilityState === "visible" && document.hasFocus()) inbox.seen(view.focused);
    };
    look();
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [view.focused]);
  /** Opens the inbox; on a phone the list of chats shows first, where the bell is. */
  const showInbox = useCallback(() => {
    setShowChat(false);
    setInboxOpen(true);
  }, []);
  const showShortcuts = useCallback(() => setShortcuts(true), []);
  const showWhatsNew = useCallback(() => setWhatsNew(true), []);
  const anywhere = { enableOnFormTags: true, preventDefault: true } as const;
  useHotkeys(KEYS.palette.hotkey, () => setPalette((open) => !open), anywhere);
  useHotkeys(KEYS.shortcuts.hotkey, () => setShortcuts((open) => !open), anywhere);
  // The desktop window opens another window; a browser keeps its own use of the key. A refusal passes as a toast, as
  // the failure of any action just taken does.
  const newWindow = useCallback(() => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    openDesktopWindow(bridge).catch((failure: unknown) =>
      workspace.current?.focused()?.controller.store.toast(refusalText(failure), "error"),
    );
  }, []);
  useHotkeys(KEYS.newWindow.hotkey, newWindow, { ...anywhere, enabled: desktopBridge() !== null });
  useHotkeys(KEYS.sidePanel.hotkey, togglePanel, anywhere);
  const sidePanel = usePanelState();
  /** The focused pane's chat, for the side panel; read again whenever the workspace's view changes. */
  const [focusedChat, setFocusedChat] = useState<ChatController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view says when the focused pane changed
  useEffect(() => {
    setFocusedChat(workspace.current?.focused()?.controller ?? null);
  }, [view]);
  // On a desktop the side panel is a pane of the shown tab. What the rail, the palette, the message box and the key ask
  // of the panel state goes to the workspace; a pane closed with its ×, or a tab with or without one, comes back to it.
  // Each acts only when the two differ, so neither undoes the other; neither acts before the workspace has said what its
  // tabs hold (`NOTHING_OPEN` until then), so the layout a reload brings back decides.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the workspace's side pane is compared, not followed
  useEffect(() => {
    if (phone || view === NOTHING_OPEN) return;
    const wanted = sidePanel.open ? sidePanel.panel : null;
    if (wanted !== view.side) workspace.current?.side(wanted);
  }, [phone, sidePanel.open, sidePanel.panel]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel state is compared, not followed
  useEffect(() => {
    if (phone || view === NOTHING_OPEN) return;
    const wanted = sidePanel.open ? sidePanel.panel : null;
    if (view.side === wanted) return;
    if (view.side === null) hidePanel();
    else showPanel(view.side);
  }, [phone, view]);
  const sidePane = useMemo(
    () => ({ client, folder, chat: focusedChat, openGoal: setGoalFor }),
    [client, folder, focusedChat],
  );
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
      className={cn(
        "grid h-full max-sm:grid-cols-1",
        // The last column is the side panel's rail, at the window's right edge; the panel opens as a pane.
        "grid-cols-[244px_minmax(0,1fr)_40px] max-[1360px]:grid-cols-[224px_minmax(0,1fr)_40px]",
      )}
      data-app-root="true"
    >
      <ConnectionBanner client={client} />
      <RequestPrompt client={client} />
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
        onWhatsNew={showWhatsNew}
        workspace={workspace}
        phone={phone}
      />
      <main
        data-tour="workspace"
        className={cn(
          "my-1.5 mr-1.5 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-l2 bg-panel max-sm:m-0 max-sm:rounded-none max-sm:border-0",
          phone && !showChat && "hidden",
        )}
      >
        {phone && (
          // The phone's top bar: back to the list (marked while a chat waits on you), the chat's name, a new chat.
          <div data-tour="phone-top-bar" className="flex h-11 shrink-0 items-center gap-1 px-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-11 shrink-0 text-t2"
              aria-label={view.waiting.size > 0 ? "Chats, one waiting on you" : "Chats"}
              onClick={() => setShowChat(false)}
            >
              <ChevronLeft />
              Chats
              {view.waiting.size > 0 && (
                <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
              )}
            </Button>
            <TitleMenu
              list={list}
              focused={view.focused}
              onDeleted={(id) => workspace.current?.forget(id)}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 text-t2"
              aria-label="New chat"
              onClick={() => openChat({ kind: "new", folder }, "here")}
            >
              <SquarePen />
            </Button>
          </div>
        )}
        <SidePaneContext value={sidePane}>
          <Workspace
            ref={workspace}
            client={client}
            folder={folder}
            phone={phone}
            onView={setView}
            onShown={showChatView}
          />
        </SidePaneContext>
      </main>
      {phone && (
        <SidePanel client={client} folder={folder} chat={focusedChat} openGoal={setGoalFor} />
      )}
      {!phone && <PanelRail />}
      <Palette
        open={palette}
        onOpenChange={setPalette}
        client={client}
        list={list}
        workspace={workspace}
        folder={folder}
        onOpenChat={openChat}
        onShortcuts={showShortcuts}
        onSetGoal={setGoalFor}
        onSettings={showSettings}
        onServers={showServers}
        onNewWindow={newWindow}
        onInbox={showInbox}
        onWhatsNew={showWhatsNew}
      />
      <Shortcuts open={shortcuts} onOpenChange={setShortcuts} />
      <WhatsNewList open={whatsNew} onOpenChange={setWhatsNew} workspace={workspace} />
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

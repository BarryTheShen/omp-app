import type { AppClient } from "@omp-app/client";
import { ChatSessionPort, type FolderPath, type ThreadId } from "@omp-app/contracts";
import {
  type DockviewApi,
  type DockviewGroupPanel,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  getPanelData,
  type IDockviewGroupPanel,
  type IDockviewPanel,
  type IWatermarkPanelProps,
  type Position,
  type PositionResolver,
  type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { SquarePen, X } from "lucide-react";
import "../styles/dockview.css";
import {
  type ReactNode,
  type Ref,
  use,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type Options, useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import type { ComposerHandle } from "../chat/Composer";
import type { ChatController, ChatTarget } from "../chat/controller";
import { forgetNewChatDraft } from "../chat/drafts";
import { DashboardPane } from "../dashboard/DashboardPane";
import {
  DASHBOARD_PANE,
  type DashboardPaneParams,
  isDashboardPane,
} from "../dashboard/dashboardPane";
import { inAppWindow, KEYS, keycap } from "../keys/table";
import { FilePane } from "../panels/files/FilePane";
import { isFilePane } from "../panels/files/filePaneParams";
import {
  panelOf,
  ShownTabContext,
  SIDE_PANE,
  SidePane,
  type SidePaneParams,
} from "../panels/SidePane";
import { usePhone } from "../phone";
import { loadKeepsChat } from "../reloadKeepsChat";
import { matchesHotkey } from "../tour/keys";
import {
  ChatPanel,
  type ChatPanelParams,
  PaneFocus,
  type PaneHost,
  PaneHostContext,
} from "./ChatPanel";
import { chatCache } from "./chatCache";
import { carriesChat, droppedChat } from "./chatDrag";
import { DropGuides } from "./DropGuides";
import { keepDividerDragsFromSelecting } from "./dividers";
import { regionResolver } from "./dropRegions";
import { equalized, swappedWithNext } from "./layout";
import { OpenGate } from "./openGate";
import { chatOfPane, closePaneAsked, PaneTab } from "./PaneTab";
import { PaneModeContext } from "./paneMode";
import { TabStrip } from "./TabStrip";
import {
  activateTab,
  blankTab,
  closeTab,
  goToTab,
  insertTab,
  layoutStorage,
  loadTabs,
  moveTab,
  moveTabTo,
  nameAfterChat,
  renameTab,
  reopenTab,
  saveLayout,
  stepTab,
  TABS_KEY,
  type WorkspaceTab,
  type WorkspaceTabs,
} from "./tabs";

const THEME: DockviewTheme = { name: "omp", className: "dockview-theme-omp" };
/** A chat's pane, the side panel, a file opened from the Files panel (#2782), and the dashboard. */
const COMPONENTS = {
  chat: ChatPanel,
  side: SidePane,
  file: FilePane,
  [DASHBOARD_PANE]: DashboardPane,
};
/** How much one resize key widens, narrows, heightens or shortens the focused pane. */
const RESIZE_STEP_PX = 48;
/** Pane mode ends after this long without a key. */
const PANE_MODE_MS = 3_000;
/** Pane mode's keys, as its strip shows them. */
const PANE_MODE_KEYS: readonly { readonly keys: readonly string[]; readonly does: string }[] = [
  { keys: ["← → ↑ ↓"], does: "go" },
  { keys: ["Shift + arrow"], does: "resize" },
  { keys: ["="], does: "share the space" },
  { keys: ["[", "]"], does: "previous, next" },
  { keys: ["Esc"], does: "done" },
];

type Direction = "left" | "right" | "up" | "down";

/** An arrow key's direction, by react-hotkeys-hook's name (`left`, `arrowleft`) or a key event's (`ArrowLeft`). */
function directionOf(key: string | undefined): Direction | undefined {
  const name = key?.toLowerCase().replace("arrow", "");
  return name === "left" || name === "right" || name === "up" || name === "down" ? name : undefined;
}

/** The workspace's commands the palette offers (kitty's keys run them too). */
export type WorkspaceCommand =
  | "splitRight"
  | "splitDown"
  | "newChat"
  | "zoom"
  | "closePane"
  | "swapPane"
  | "equalize"
  | "paneMode"
  | "newTab"
  | "nextTab"
  | "previousTab"
  | "closeTab"
  | "reopenTab"
  | "renameTab"
  | "moveTabRight"
  | "moveTabLeft";

/** The focused pane's chat and its message box, for the palette. */
export interface FocusedChat {
  readonly controller: ChatController;
  readonly composer: ComposerHandle | undefined;
}

/**
 * Where a chat opens (#2831), as a browser opens a link: `front`, a click; `behind`, Ctrl+click or a middle click, which
 * leaves the shown workspace in front; `beside`, Alt+click, in a window beside the focused one.
 */
export type OpenHow = "front" | "behind" | "beside";

/** What the sidebar and the palette ask of the workspace. */
export interface WorkspaceHandle {
  /**
   * Opens a chat. Where a window shows it already, that window comes to the front. Otherwise a blank focused window
   * takes it, and otherwise it gets a workspace of its own, as a browser opens a page in a new tab (`OpenHow`).
   */
  readonly open: (target: ChatTarget, how: OpenHow) => void;
  /** A tour's sandbox: a new workspace with a new chat in its window, so nothing the tour has you try touches yours. */
  readonly sandbox: () => void;
  readonly command: (id: WorkspaceCommand) => void;
  readonly focused: () => FocusedChat | null;
  /** A chat was deleted: every window that showed it goes blank, and the page stops keeping it open. */
  readonly forget: (threadId: ThreadId) => void;
  /** Shows the side pane on a panel in the shown workspace, at the right of its windows, or takes it away (`null`). */
  readonly side: (panel: string | null) => void;
  /**
   * Opens the dashboard: where a workspace shows it, that workspace and its pane come to the front; otherwise it gets a
   * workspace of its own, in front, as a new chat does.
   */
  readonly dashboard: () => void;
}

/** What the workspace shows, for the sidebar: the focused pane's chat, the chats open in panes, and those waiting. */
export interface WorkspaceView {
  readonly focused: ThreadId | null;
  readonly open: ReadonlySet<ThreadId>;
  /** Open chats with an approval or a question waiting for you, each with its pane's title. */
  readonly waiting: ReadonlyMap<ThreadId, string>;
  /** The panel the shown tab's side pane shows; null when that tab has no side pane. */
  readonly side: string | null;
}

/** A chat pane's parameters; none for the side pane's, a file pane's or the dashboard's, which show no chat. */
const paramsOf = (params: unknown): ChatPanelParams | undefined =>
  isFilePane(params) || isDashboardPane(params)
    ? undefined
    : (params as ChatPanelParams | undefined);

/** A pane that shows a chat: not the side panel, not a file, not the dashboard. */
const isChatPane = (panel: IDockviewPanel): boolean =>
  panel.id !== SIDE_PANE && !isFilePane(panel.params) && !isDashboardPane(panel.params);

/** A blank window (#2791): a window that shows nothing yet, only its New chat. */
const isBlank = (group: IDockviewGroupPanel): boolean => group.panels.length === 0;

/** Whether the pointer is over a blank window: the window under it shows the blank face (`BlankWindow`). */
const blankUnder = (event: DragEvent | PointerEvent): boolean =>
  document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest(".dv-content-container")
    ?.querySelector("[data-blank-window]") != null;

/** A layout as kept: on a phone the one pane shown is zoomed, which is not kept. */
function keptLayout(layout: SerializedDockview, phone: boolean): SerializedDockview {
  if (!phone) return layout;
  // dockview writes the zoomed pane's place as `maximizedNode`, which its type leaves out.
  const { maximizedNode: _zoomed, ...grid } = layout.grid as SerializedDockview["grid"] & {
    readonly maximizedNode?: unknown;
  };
  return { ...layout, grid };
}

/**
 * The workspace, laid out like kitty: tabs on top, each with its own split panes, one chat per pane; unfocused panes dim.
 * Every tab's layout is kept in this browser and comes back after a reload. On a phone, one pane at a time.
 */
export function Workspace({
  client,
  folder,
  phone,
  onView,
  onShown,
  stripLeading,
  linkedChat = null,
  ref,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly phone: boolean;
  readonly onView: (view: WorkspaceView) => void;
  /** A tab of its own with a new chat came to the front (a new tab, a tour's sandbox): a phone shows the chat then. */
  readonly onShown?: () => void;
  /** Before the workspace tabs: Show the chat list while it is hidden (#2805). */
  readonly stripLeading?: ReactNode;
  /**
   * A chat the address named (`#chat=<id>`: the lite view's "Open in the full app", #2843): it opens in front once the
   * shown workspace is ready, as a click in the list opens it.
   */
  readonly linkedChat?: ChatTarget | null;
  readonly ref: Ref<WorkspaceHandle>;
}): ReactNode {
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  const [tabs, setTabs] = useState<WorkspaceTabs>(() =>
    loadTabs(layoutStorage().getItem(TABS_KEY)),
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const apis = useRef(new Map<string, DockviewApi>());
  /** Each tab's drop resolver (#2790), made once: dockview reads it at every drag-over. */
  const resolvers = useRef(new Map<string, PositionResolver>());
  const resolverFor = (tabId: string): PositionResolver => {
    let resolver = resolvers.current.get(tabId);
    if (resolver === undefined) {
      resolver = regionResolver(
        () => {
          const api = apis.current.get(tabId);
          const box = document
            .querySelector(`[data-tab="${CSS.escape(tabId)}"]`)
            ?.getBoundingClientRect();
          return api === undefined || box === undefined
            ? null
            : {
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                panes: api.groups.length,
              };
        },
        carriesChat,
        blankUnder,
      );
      resolvers.current.set(tabId, resolver);
    }
    return resolver;
  };
  /**
   * Counts the tabs' dockviews as they become ready: the shown tab's, read from `apis` while drawing, is known only then,
   * and a side pane restored with the tab's layout draws once it knows its tab is the one shown (#2773).
   */
  const [readyApis, setReadyApis] = useState(0);
  const focus = useMemo(() => new PaneFocus(), []);
  const controllers = useMemo(() => new Map<string, ChatController>(), []);
  const composers = useMemo(() => new Map<string, ComposerHandle>(), []);
  /** Whether the phone layout zoomed the focused pane, so leaving the phone layout can undo it. */
  const phoneZoomed = useRef(false);
  /** Workspaces just opened for a chat (#2831) or a tour's sandbox: the chat their blank window takes once ready. */
  const pendingChats = useRef(new Map<string, ChatTarget>());
  /** Workspaces just opened for the dashboard: their blank window takes it once ready. */
  const pendingDashboards = useRef(new Set<string>());
  /** The workspaces opened behind from the shown one, so the next goes after the last of them, as a browser's tabs. */
  const behindChain = useRef<{ readonly from: string; readonly last: string } | null>(null);
  /**
   * Each workspace opened in front, with the one it was opened from (#2831): closing it goes back there, as a browser's
   * tab opened from another, until you go to another workspace yourself (Firefox's `browser.tabs.selectOwnerOnClose`).
   */
  const owners = useRef(new Map<string, string>());
  /** You go to another workspace yourself: closing one no longer goes back to where it was opened from. */
  const switchTabs = useCallback((change: (state: WorkspaceTabs) => WorkspaceTabs) => {
    owners.current.clear();
    setTabs(change);
  }, []);
  /** A new workspace in front, right after the shown one, which closing it goes back to. */
  const openInFront = useCallback((tab: WorkspaceTab) => {
    owners.current.set(tab.id, tabsRef.current.active);
    setTabs((state) => insertTab(state, tab, state.active, true));
  }, []);
  /** Whether a phone has had its new chat for this page load (a phone opens on a new chat). */
  const phoneStarted = useRef(false);
  /** When a pane opens its chat: every pane at once on a desktop, only the pane in front on a phone (#2768). */
  const [openGate] = useState(() => new OpenGate(!phone));
  /** Each tab's chat pane focused last, by its dockview: the side pane taking the focus leaves it the chat in use. */
  const lastChat = useRef(new WeakMap<DockviewApi, string>());
  /** A tab's chat pane in use: the focused pane, or while the side pane has the focus, the chat pane focused last. */
  const chatPaneIn = useCallback((api: DockviewApi | undefined): IDockviewPanel | undefined => {
    if (api === undefined) return undefined;
    const active = api.activePanel;
    if (active !== undefined && isChatPane(active)) return active;
    const last = lastChat.current.get(api);
    return (last === undefined ? undefined : api.getPanel(last)) ?? api.panels.find(isChatPane);
  }, []);

  useEffect(() => layoutStorage().setItem(TABS_KEY, JSON.stringify(tabs)), [tabs]);

  /** Tells the sidebar what is open, focused and waiting, and names each workspace after its first chat. */
  const report = useCallback(() => {
    const open = new Set<ThreadId>();
    const waiting = new Map<ThreadId, string>();
    const named: [string, string, string][] = [];
    for (const tab of tabsRef.current.tabs) {
      const api = apis.current.get(tab.id);
      if (api === undefined) continue;
      for (const panel of api.panels) {
        const target = paramsOf(panel.params)?.target;
        if (target?.kind !== "existing") continue;
        open.add(target.threadId);
        if ((controllers.get(panel.id)?.store.getSnapshot().requests.length ?? 0) > 0)
          waiting.set(target.threadId, panel.title ?? "");
      }
      // A workspace without a name takes its first chat's title, once that chat has one (#2791), and follows that chat's
      // window as omp names the chat (#2829): the window that named it, else (none yet) the chat in use.
      const namer =
        (tab.firstPane ?? null) === null ? chatPaneIn(api) : api.getPanel(tab.firstPane as string);
      const title = namer?.title;
      if (
        namer !== undefined &&
        title !== undefined &&
        title !== "" &&
        title !== "New chat" &&
        (title !== tab.firstTitle || namer.id !== tab.firstPane)
      )
        named.push([tab.id, title, namer.id]);
    }
    const shown = apis.current.get(tabsRef.current.active);
    const focused = paramsOf(chatPaneIn(shown)?.params)?.target;
    const side = (shown?.getPanel(SIDE_PANE)?.params as SidePaneParams | undefined)?.panel ?? null;
    onView({
      focused: focused?.kind === "existing" ? focused.threadId : null,
      open,
      waiting,
      side,
    });
    if (named.length > 0)
      setTabs((state) =>
        named.reduce((next, [id, title, pane]) => nameAfterChat(next, id, title, pane), state),
      );
  }, [onView, controllers, chatPaneIn]);

  const focusPane = useCallback(
    (api: DockviewApi) => {
      const group = api.activeGroup;
      if (group !== undefined && isBlank(group)) {
        // A blank window's caret is on its New chat, so Enter starts one.
        group.element.querySelector<HTMLElement>("[data-new-chat]")?.focus({ preventScroll: true });
        return;
      }
      const id = chatPaneIn(api)?.id;
      if (id !== undefined) focus.request(id);
    },
    [focus, chatPaneIn],
  );

  /** On a phone the focused pane fills the screen: dockview's zoom, which a phone's layout does not keep. */
  const zoomForPhone = useCallback((api: DockviewApi) => {
    const panel = api.activePanel;
    if (phoneRef.current && panel !== undefined && !panel.api.isMaximized())
      api.maximizeGroup(panel);
  }, []);

  /** The pane in front of a tab opens its chat: on a phone the only one that does (`openGate`). */
  const allowFront = useCallback(
    (api: DockviewApi) => {
      const front = api.activePanel;
      if (front !== undefined && isChatPane(front)) openGate.allow(front.id);
    },
    [openGate],
  );

  /**
   * Headers only between several windows (never on a phone): a single window needs no title bar, as in kitty. A blank
   * window has none either: its own face holds its New chat and its ×.
   */
  const syncHeaders = useCallback((api: DockviewApi) => {
    for (const group of api.groups)
      group.header.hidden = phoneRef.current || api.groups.length < 2 || isBlank(group);
  }, []);

  /**
   * A new chat in a window: a blank window given (its New chat), else the focused window when it is blank, else a new
   * window beside the focused chat (`direction`), else wherever dockview puts it. It gets the caret once its message
   * box is there, unless its workspace is behind (`take`). A new chat runs in the focused chat's folder (as kitty's new
   * window keeps the current one's), else the folder it names; a chat from the list belongs to the list's folder.
   */
  const addChat = useCallback(
    (
      api: DockviewApi,
      target: ChatTarget,
      direction?: "right" | "below",
      into?: IDockviewGroupPanel,
      take = true,
    ) => {
      const reference = chatPaneIn(api);
      const chatFolder =
        paramsOf(reference?.params)?.folder ?? (target.kind === "new" ? target.folder : folder);
      const focused = api.activeGroup;
      const blank =
        into ??
        (direction === undefined && focused !== undefined && isBlank(focused)
          ? focused
          : undefined);
      const id = crypto.randomUUID();
      api.addPanel<ChatPanelParams>({
        id,
        component: "chat",
        title: "New chat",
        params: {
          chat: crypto.randomUUID(),
          target: target.kind === "new" ? { kind: "new", folder: chatFolder } : target,
          folder: target.kind === "new" ? chatFolder : (target.folder ?? folder),
        },
        ...(blank !== undefined
          ? { position: { referenceGroup: blank, direction: "within" } }
          : direction !== undefined && reference !== undefined
            ? { position: { referencePanel: reference, direction } }
            : {}),
      });
      if (take) focus.request(id);
    },
    [folder, focus, chatPaneIn],
  );

  /** The split keys (#2791): a blank window beside the focused one, which comes to the front. */
  const splitBlank = useCallback((api: DockviewApi, direction: "right" | "below") => {
    const focused = api.activeGroup;
    const group = api.addGroup(
      focused === undefined ? { direction } : { referenceGroup: focused, direction },
    );
    group.api.setActive();
  }, []);

  /**
   * A chat dropped from the list opens where it lands (#2771): a blank window it fills (#2791); on a window's edge it
   * splits that window there, in its middle it takes that window's place, along the whole window's edges it runs that
   * side. A chat a window shows already moves there, from another workspace too, so one window still shows each chat;
   * dropped on its own window, it only takes the caret.
   */
  const dropChat = useCallback(
    (
      api: DockviewApi,
      target: ChatTarget,
      group: DockviewGroupPanel | undefined,
      position: Position,
    ) => {
      const side = position === "center" ? "right" : position;
      let shown: { readonly api: DockviewApi; readonly panel: IDockviewPanel } | undefined;
      if (target.kind === "existing")
        for (const other of apis.current.values()) {
          const panel = other.panels.find((candidate) => {
            const showing = paramsOf(candidate.params)?.target;
            return showing?.kind === "existing" && showing.threadId === target.threadId;
          });
          if (panel !== undefined) shown = { api: other, panel };
        }
      if (group !== undefined && isBlank(group)) {
        if (shown?.api === api) {
          shown.panel.api.moveTo({ group, position: "center" });
          focus.request(shown.panel.id);
          return;
        }
        if (shown !== undefined) shown.api.removePanel(shown.panel);
        addChat(api, target, undefined, group);
        return;
      }
      // The middle guide: the chat takes that pane's place. The side panel and a file are not a chat's pane: beside
      // them, as before.
      const replaced = position === "center" ? group?.activePanel : undefined;
      if (replaced !== undefined && isChatPane(replaced)) {
        if (shown?.panel === replaced) {
          focus.request(replaced.id);
          return;
        }
        if (shown !== undefined) shown.api.removePanel(shown.panel);
        replaced.api.updateParameters({
          chat: crypto.randomUUID(),
          target,
          folder,
        } satisfies ChatPanelParams);
        replaced.api.setTitle("New chat");
        focus.request(replaced.id);
        return;
      }
      if (shown?.api === api) {
        // Its own pane, or the only pane of this tab: removing it would close the tab under the drop.
        if (shown.panel.group === group || api.totalPanels === 1) {
          focus.request(shown.panel.id);
          return;
        }
        if (group !== undefined) {
          shown.panel.api.moveTo({ group, position: side });
          focus.request(shown.panel.id);
          return;
        }
      }
      if (shown !== undefined) shown.api.removePanel(shown.panel);
      const direction = side === "top" ? "above" : side === "bottom" ? "below" : side;
      const id = crypto.randomUUID();
      api.addPanel<ChatPanelParams>({
        id,
        component: "chat",
        title: "New chat",
        params: { chat: crypto.randomUUID(), target, folder },
        position: group === undefined ? { direction } : { referenceGroup: group, direction },
      });
      focus.request(id);
    },
    [addChat, folder, focus],
  );

  /**
   * A drop in the band along the window's edges (#2790), which takes its drops itself (`DropGuides`): the chat from the
   * list, or the pane dragged by its title, runs the whole length of that side of the window.
   */
  const dropOnEdge = useCallback(
    (tabId: string, position: Position, event: DragEvent) => {
      const api = apis.current.get(tabId);
      if (api === undefined || position === "center") return;
      const chat = droppedChat(event);
      if (chat !== null) {
        dropChat(api, chat, undefined, position);
        return;
      }
      const dragged = getPanelData();
      if (dragged === undefined || dragged.viewId !== api.id) return;
      const panel =
        dragged.panelId === null
          ? api.getGroup(dragged.groupId)?.activePanel
          : api.getPanel(dragged.panelId);
      if (panel === undefined) return;
      const group = api.addGroup({
        direction: position === "top" ? "above" : position === "bottom" ? "below" : position,
      });
      panel.api.moveTo({ group, position: "center" });
      focus.request(panel.id);
    },
    [dropChat, focus],
  );

  const ready = useCallback(
    (tabId: string, event: DockviewReadyEvent) => {
      const { api } = event;
      apis.current.set(tabId, api);
      setReadyApis((count) => count + 1);
      const layout = tabsRef.current.tabs.find((tab) => tab.id === tabId)?.layout;
      if (layout !== null && layout !== undefined) {
        try {
          api.fromJSON(layout);
        } catch {
          // A layout this version cannot read: the tab starts again empty.
          api.clear();
        }
      }
      // A workspace starts as one blank window (#2791), its New chat in reach.
      if (api.groups.length === 0) api.addGroup();
      // A chat opened in a workspace of its own (#2831), and a tour's sandbox, fill its blank window; behind, it opens
      // without taking the caret.
      const pending = pendingChats.current.get(tabId);
      pendingChats.current.delete(tabId);
      if (pending !== undefined && api.totalPanels === 0) {
        const shown = tabId === tabsRef.current.active;
        addChat(api, pending, undefined, api.groups.find(isBlank), shown);
        if (shown) onShownRef.current?.();
      }
      // The dashboard opened in a workspace of its own fills its blank window, and is kept in the layout at once: the
      // layout's own changes are heard only from below, and a dashboard alone changes nothing more to save it.
      if (pendingDashboards.current.delete(tabId) && api.totalPanels === 0) {
        const blank = api.groups.find(isBlank);
        api.addPanel<DashboardPaneParams>({
          id: DASHBOARD_PANE,
          component: DASHBOARD_PANE,
          title: "Dashboard",
          params: { kind: "dashboard" },
          ...(blank === undefined
            ? {}
            : { position: { referenceGroup: blank, direction: "within" } }),
        });
        setTabs((state) => saveLayout(state, tabId, keptLayout(api.toJSON(), phoneRef.current)));
      }
      // A phone opens on a new chat in the shown tab, ready to type, with the list a tap away: going through the list
      // to start one is slow on a phone. A new chat already in front stays, with the text kept for it. A reload the app
      // asked for (its banner's Reload), or any load within an hour of the page last being up, comes back to the chat it
      // showed instead (#2819).
      if (phoneRef.current && !phoneStarted.current && tabId === tabsRef.current.active) {
        phoneStarted.current = true;
        const panel = chatPaneIn(api);
        if (panel === undefined)
          addChat(api, { kind: "new", folder }, undefined, api.groups.find(isBlank));
        else if (!loadKeepsChat && paramsOf(panel.params)?.target.kind !== "new") {
          panel.api.updateParameters({
            chat: crypto.randomUUID(),
            target: { kind: "new", folder },
            folder,
          } satisfies ChatPanelParams);
          panel.api.setTitle("New chat");
        }
      }
      // The shown tab's pane in front opens its chat; on a phone the others wait to come to the front.
      if (tabId === tabsRef.current.active) allowFront(api);
      api.onDidLayoutChange(() => {
        if (apis.current.get(tabId) !== api) return;
        syncHeaders(api);
        setTabs((state) => saveLayout(state, tabId, keptLayout(api.toJSON(), phoneRef.current)));
        report();
      });
      api.onDidActivePanelChange(() => {
        if (apis.current.get(tabId) !== api) return;
        const active = api.activePanel;
        if (active !== undefined && isChatPane(active)) lastChat.current.set(api, active.id);
        zoomForPhone(api);
        if (tabId === tabsRef.current.active) allowFront(api);
        report();
      });
      // A workspace is never left without a window: its last chat closed leaves a blank one (`noPanelsOverlay`), and one
      // whose windows all went otherwise (its chat dropped into another workspace) gets a blank one back, once a layout
      // being rebuilt has its windows again.
      api.onDidRemoveGroup(() => {
        queueMicrotask(() => {
          if (apis.current.get(tabId) === api && api.groups.length === 0) api.addGroup();
        });
      });
      // A chat dragged from the list: dockview lights where it would land, and the drop opens it there.
      api.onUnhandledDragOver((event) => {
        if (carriesChat(event.nativeEvent)) event.accept();
      });
      api.onDidDrop((event) => {
        const target = droppedChat(event.nativeEvent);
        if (target !== null) dropChat(api, target, event.group, event.position);
      });
      syncHeaders(api);
      report();
    },
    [addChat, allowFront, chatPaneIn, dropChat, folder, report, syncHeaders, zoomForPhone],
  );

  const withActive = useCallback((action: (api: DockviewApi) => void): void => {
    const api = apis.current.get(tabsRef.current.active);
    if (api !== undefined) action(api);
  }, []);

  /** Goes to the pane in `direction` from the focused one. */
  const goToPane = useCallback(
    (direction: Direction) =>
      withActive((api) => {
        const group = api.activeGroup;
        if (group === undefined) return;
        const next = api.adjacentGroupInDirection(group, direction);
        if (next === undefined) return;
        next.api.setActive();
        focusPane(api);
      }),
    [withActive, focusPane],
  );

  /** Goes to the next pane, or the previous one. */
  const cyclePane = useCallback(
    (forward: boolean) =>
      withActive((api) => {
        if (forward) api.activateNext();
        else api.activatePrevious();
        focusPane(api);
      }),
    [withActive, focusPane],
  );

  /** Makes the focused pane wider (right), narrower (left), taller (up) or shorter (down) by a step, as kitty's resize. */
  const resizePane = useCallback(
    (direction: Direction) =>
      withActive((api) => {
        const group = api.activeGroup;
        if (group === undefined) return;
        const step = direction === "right" || direction === "up" ? RESIZE_STEP_PX : -RESIZE_STEP_PX;
        if (direction === "left" || direction === "right")
          group.api.setSize({ width: group.api.width + step });
        else group.api.setSize({ height: group.api.height + step });
      }),
    [withActive],
  );

  /** Pane mode: plain keys act on the panes, for keyboards and browsers where the Super keys do not reach the app. */
  const [paneMode, setPaneMode] = useState(false);

  /**
   * Closes a tab the person asked to close: each chat pane in it goes as if closed itself, so its new chat's kept text
   * goes too. The panes come from the tab's dockview when it is mounted, else from its saved layout. Reopen brings the
   * tab back with its windows as they are now, or as `layout` has them (as they were before its last window closed).
   */
  const closeTabAsked = useCallback((id: string, layout?: SerializedDockview) => {
    const api = apis.current.get(id);
    const panes =
      api !== undefined
        ? api.panels.map((panel) => panel.params)
        : Object.values(
            tabsRef.current.tabs.find((tab) => tab.id === id)?.layout?.panels ?? {},
          ).map((panel) => panel.params);
    for (const params of panes) {
      const chat = chatOfPane(params);
      if (chat !== undefined) void forgetNewChatDraft(chat);
    }
    apis.current.delete(id);
    const back = owners.current.get(id);
    owners.current.delete(id);
    const kept =
      layout ?? (api === undefined ? undefined : keptLayout(api.toJSON(), phoneRef.current));
    setTabs((state) =>
      closeTab(kept === undefined ? state : saveLayout(state, id, kept), id, back),
    );
  }, []);

  /**
   * Closes a window the person asked to close: its × or Ctrl+Shift+W. The workspace's only window closing closes the
   * workspace too, as a browser tab goes with its page, unless it is the only workspace (#2831); Reopen brings it back
   * with that window. A phone's window only.
   */
  const closeWindowAsked = useCallback(
    (api: DockviewApi, panel: IDockviewPanel) => {
      const besideSide = (group: IDockviewGroupPanel): boolean =>
        group.panels.some((each) => each.id === SIDE_PANE);
      const onlyWindow =
        !phoneRef.current &&
        tabsRef.current.tabs.length > 1 &&
        panel.id !== SIDE_PANE &&
        api.panels.every((each) => each === panel || each.id === SIDE_PANE) &&
        api.groups.every((group) => group === panel.group || besideSide(group));
      const before = onlyWindow ? keptLayout(api.toJSON(), false) : undefined;
      closePaneAsked(panel);
      if (before === undefined) return;
      const tabId = [...apis.current].find(([, each]) => each === api)?.[0];
      if (tabId !== undefined) closeTabAsked(tabId, before);
    },
    [closeTabAsked],
  );

  /**
   * A chat in a workspace of its own, right after the shown one (#2831): in front, or behind it, where several opened
   * from the same workspace line up in the order opened, as a browser's tabs opened from one page. Its blank window
   * takes the chat once its dockview is ready (`ready`).
   */
  const openInWorkspace = useCallback(
    (target: ChatTarget, behind: boolean) => {
      const tab = blankTab();
      pendingChats.current.set(tab.id, target);
      if (!behind) {
        behindChain.current = null;
        openInFront(tab);
        return;
      }
      const from = tabsRef.current.active;
      const chain = behindChain.current;
      const after = chain !== null && chain.from === from ? chain.last : from;
      behindChain.current = { from, last: tab.id };
      setTabs((state) => insertTab(state, tab, after, false));
    },
    [openInFront],
  );

  /**
   * Opens a chat as a browser opens a page (#2791, #2831). Where a window shows it already, that window comes to the
   * front (opened behind, it stays where it is). Otherwise a blank focused window takes it, unless it opens behind,
   * which leaves the shown workspace as it is. Otherwise `beside` puts it in a window beside the focused one (a phone
   * shows that one in front), and anything else gets a workspace of its own (`openInWorkspace`). On a phone, one chat
   * at a time: it shows in place of the one shown.
   */
  const openChat = useCallback(
    (target: ChatTarget, how: OpenHow) => {
      if (target.kind === "existing") {
        for (const [tabId, api] of apis.current) {
          const panel = api.panels.find((candidate) => {
            const shown = paramsOf(candidate.params)?.target;
            return shown?.kind === "existing" && shown.threadId === target.threadId;
          });
          if (panel === undefined) continue;
          if (how === "behind") return;
          if (tabId !== tabsRef.current.active) switchTabs((state) => activateTab(state, tabId));
          panel.api.setActive();
          zoomForPhone(api);
          focusPane(api);
          return;
        }
      }
      withActive((api) => {
        const focused = api.activeGroup;
        const panel = chatPaneIn(api);
        if (focused !== undefined && isBlank(focused) && how !== "behind")
          addChat(api, target, undefined, focused);
        else if (how === "beside" || (phoneRef.current && panel === undefined))
          addChat(api, target, "right");
        else if (phoneRef.current && panel !== undefined) {
          // A new chat runs in the folder it names; a chat from the list belongs to the list's folder, a running chat
          // from another folder to its own.
          panel.api.updateParameters({
            chat: crypto.randomUUID(),
            target,
            folder: target.kind === "new" ? target.folder : (target.folder ?? folder),
          } satisfies ChatPanelParams);
          panel.api.setTitle("New chat");
          focus.request(panel.id, true);
        } else {
          openInWorkspace(target, how === "behind");
          return;
        }
        report();
      });
    },
    [
      addChat,
      chatPaneIn,
      focus,
      focusPane,
      folder,
      openInWorkspace,
      report,
      switchTabs,
      withActive,
      zoomForPhone,
    ],
  );

  // The chat the address named opens once the shown workspace's windows are back: before, it could not tell whether a
  // window shows it already, nor take a blank one.
  const linked = useRef(linkedChat);
  useEffect(() => {
    const target = linked.current;
    if (target === null || readyApis === 0 || !apis.current.has(tabsRef.current.active)) return;
    linked.current = null;
    openChat(target, "front");
  }, [readyApis, openChat]);

  /** The workspace's commands: kitty's keys run them, and the palette offers them. */
  const commands = useMemo<Record<WorkspaceCommand, () => void>>(
    () => ({
      splitRight: () => withActive((api) => splitBlank(api, "right")),
      splitDown: () => withActive((api) => splitBlank(api, "below")),
      // In the focused chat's folder, as a new window is (`addChat`).
      newChat: () =>
        openChat(
          {
            kind: "new",
            folder:
              paramsOf(chatPaneIn(apis.current.get(tabsRef.current.active))?.params)?.folder ??
              folder,
          },
          "front",
        ),
      // Zoom the focused window, a blank one too, or back.
      zoom: () =>
        withActive((api) => {
          const group = api.activeGroup;
          if (group === undefined) return;
          if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
          else group.api.maximize();
          focusPane(api);
        }),
      closePane: () =>
        withActive((api) => {
          const group = api.activeGroup;
          if (api.activePanel !== undefined) closeWindowAsked(api, api.activePanel);
          // A blank window closes too, unless it is the workspace's only one.
          else if (group !== undefined && api.groups.length > 1) api.removeGroup(group);
        }),
      // Swap with the next pane, and equalize, rebuild the layout with the same panes (their chats stay open).
      swapPane: () =>
        withActive((api) => {
          const group = api.activeGroup;
          const swapped = group === undefined ? null : swappedWithNext(api.toJSON(), group.id);
          if (swapped === null) return;
          api.fromJSON(swapped, { reuseExistingPanels: true });
          focusPane(api);
        }),
      equalize: () =>
        withActive((api) => {
          api.fromJSON(equalized(api.toJSON()), { reuseExistingPanels: true });
          focusPane(api);
        }),
      paneMode: () => setPaneMode(true),
      // A new workspace starts as one blank window (#2791).
      newTab: () => openInFront(blankTab()),
      nextTab: () => switchTabs((state) => stepTab(state, 1)),
      previousTab: () => switchTabs((state) => stepTab(state, -1)),
      closeTab: () => closeTabAsked(tabsRef.current.active),
      reopenTab: () => switchTabs((state) => reopenTab(state)),
      renameTab: () => setRenaming(tabsRef.current.active),
      moveTabRight: () => setTabs((state) => moveTab(state, 1)),
      moveTabLeft: () => setTabs((state) => moveTab(state, -1)),
    }),
    [
      chatPaneIn,
      closeTabAsked,
      closeWindowAsked,
      focusPane,
      folder,
      openChat,
      openInFront,
      splitBlank,
      switchTabs,
      withActive,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({
      open: openChat,
      sandbox: () => {
        const tab = blankTab();
        pendingChats.current.set(tab.id, { kind: "new", folder });
        openInFront(tab);
      },
      command: (id) => commands[id](),
      forget: (threadId) => {
        // Before the windows move on, so the one that showed it closes it instead of keeping it open.
        chatCache.forget(threadId);
        for (const api of apis.current.values()) {
          for (const panel of [...api.panels]) {
            const shown = paramsOf(panel.params);
            if (shown?.target.kind !== "existing" || shown.target.threadId !== threadId) continue;
            if (!phoneRef.current) {
              // Its window stays, blank (#2791).
              api.removePanel(panel, { removeEmptyGroup: false });
              continue;
            }
            panel.api.updateParameters({
              chat: crypto.randomUUID(),
              target: { kind: "new", folder: shown.folder },
              folder: shown.folder,
            } satisfies ChatPanelParams);
            panel.api.setTitle("New chat");
          }
        }
        report();
      },
      focused: () => {
        const id = chatPaneIn(apis.current.get(tabsRef.current.active))?.id;
        const controller = id === undefined ? undefined : controllers.get(id);
        return controller === undefined || id === undefined
          ? null
          : { controller, composer: composers.get(id) };
      },
      side: (panel) =>
        withActive((api) => {
          const pane = api.getPanel(SIDE_PANE);
          if (panel === null) {
            pane?.api.close();
            return;
          }
          const title = panelOf(panel)?.title ?? "";
          if (pane !== undefined) {
            pane.api.updateParameters({ panel } satisfies SidePaneParams);
            pane.api.setTitle(title);
          } else
            api.addPanel<SidePaneParams>({
              id: SIDE_PANE,
              component: "side",
              title,
              params: { panel },
              position: { direction: "right" },
              initialWidth: 320,
              // The chat keeps the caret: the side pane opens beside it.
              inactive: true,
            });
          report();
        }),
      dashboard: () => {
        for (const [tabId, api] of apis.current) {
          const pane = api.getPanel(DASHBOARD_PANE);
          if (pane === undefined) continue;
          if (tabId !== tabsRef.current.active) switchTabs((state) => activateTab(state, tabId));
          pane.api.setActive();
          return;
        }
        const tab: WorkspaceTab = { ...blankTab(), title: "Dashboard" };
        pendingDashboards.current.add(tab.id);
        openInFront(tab);
      },
    }),
    [
      chatPaneIn,
      commands,
      composers,
      controllers,
      folder,
      openChat,
      openInFront,
      report,
      switchTabs,
      withActive,
    ],
  );

  // A divider's drag resizes the panes without selecting their text (`dividers.ts`).
  useEffect(() => keepDividerDragsFromSelecting(document), []);

  // The folder shown keeps a new chat ready on the server, so "New chat" here opens at once (#2760); an older server
  // refuses the call, and the page goes on.
  useEffect(() => {
    client
      .port(ChatSessionPort)
      .prepareNew({ folderPath: folder })
      .catch(() => undefined);
  }, [client, folder]);

  // A tab coming to the front gets the caret in its focused pane; on a phone, its focused pane fills the screen.
  useEffect(() => {
    const api = apis.current.get(tabs.active);
    for (const each of apis.current.values()) syncHeaders(each);
    if (api === undefined) return;
    if (phone) zoomForPhone(api);
    else if (api.hasMaximizedGroup() && phoneZoomed.current) api.exitMaximizedGroup();
    phoneZoomed.current = phone;
    allowFront(api);
    focusPane(api);
    report();
  }, [tabs.active, phone, allowFront, focusPane, report, syncHeaders, zoomForPhone]);

  // Leaving the phone layout (a tablet turned, a window made wider) opens every pane that waited.
  useEffect(() => openGate.setEveryPane(!phone), [openGate, phone]);

  // kitty's keys for windows and tabs (`keys/table.ts`). They work from the message box too.
  const keys: Options = { enableOnFormTags: true, preventDefault: true, enabled: !phone };
  useHotkeys(KEYS.splitRight.hotkey, commands.splitRight, keys);
  useHotkeys(KEYS.splitDown.hotkey, commands.splitDown, keys);
  useHotkeys(KEYS.zoom.hotkey, commands.zoom, keys);
  useHotkeys(KEYS.closePane.hotkey, commands.closePane, keys);
  useHotkeys(KEYS.swapPane.hotkey, commands.swapPane, keys);
  useHotkeys(KEYS.equalize.hotkey, commands.equalize, keys);
  useHotkeys(KEYS.newTab.hotkey, commands.newTab, keys);
  useHotkeys(KEYS.newChat.hotkey, commands.newChat, keys);
  useHotkeys(KEYS.nextTab.hotkey, commands.nextTab, keys);
  useHotkeys(KEYS.previousTab.hotkey, commands.previousTab, keys);
  useHotkeys(KEYS.closeTab.hotkey, commands.closeTab, keys);
  useHotkeys(KEYS.reopenTab.hotkey, commands.reopenTab, keys);
  useHotkeys(KEYS.renameTab.hotkey, commands.renameTab, keys);
  useHotkeys(KEYS.moveTabRight.hotkey, commands.moveTabRight, keys);
  useHotkeys(KEYS.moveTabLeft.hotkey, commands.moveTabLeft, keys);
  useHotkeys(KEYS.paneMode.hotkey, commands.paneMode, keys);
  // Ctrl+1…8 and Ctrl+9 only in an app window: a browser tab keeps them for its own tabs (#2831).
  const [appWindow] = useState(inAppWindow);
  useHotkeys(
    KEYS.goToTab.hotkey,
    (event) => {
      const digit = Number(event.code.replace("Digit", ""));
      if (digit >= 1 && digit <= 8) switchTabs((state) => goToTab(state, digit - 1));
      else if (digit === 9) switchTabs((state) => goToTab(state, "last"));
    },
    { ...keys, enabled: !phone && appWindow },
  );
  useHotkeys(
    KEYS.focusPane.hotkey,
    (_event, handler) => {
      const direction = directionOf(handler.keys?.[0]);
      if (direction !== undefined) goToPane(direction);
    },
    keys,
  );
  useHotkeys(
    KEYS.cyclePane.hotkey,
    (_event, handler) => cyclePane(handler.keys?.[0] === "bracketright"),
    keys,
  );
  useHotkeys(
    KEYS.resizePane.hotkey,
    (_event, handler) => {
      const direction = directionOf(handler.keys?.[0]);
      if (direction !== undefined) resizePane(direction);
    },
    keys,
  );

  // Pane mode: arrows go, Shift+arrows resize, = shares the space, [ and ] cycle. Esc, Enter, its own key again, any
  // other key or `PANE_MODE_MS` without a key end it. Read before anything else (capture), so the message box with the
  // caret never gets these keys; a key that ends it otherwise goes on to do what it does.
  useEffect(() => {
    if (!paneMode) return;
    const end = (): void => setPaneMode(false);
    let idle = window.setTimeout(end, PANE_MODE_MS);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Shift") return;
      const take = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.ctrlKey || event.altKey || event.metaKey) {
        if (matchesHotkey(event, KEYS.paneMode.hotkey)) take();
        end();
        return;
      }
      const direction = directionOf(event.key);
      if (direction !== undefined) {
        take();
        if (event.shiftKey) resizePane(direction);
        else goToPane(direction);
      } else if (event.key === "=") {
        take();
        commands.equalize();
      } else if (event.key === "[" || event.key === "]") {
        take();
        cyclePane(event.key === "]");
      } else {
        if (event.key === "Escape" || event.key === "Enter") take();
        end();
        return;
      }
      window.clearTimeout(idle);
      idle = window.setTimeout(end, PANE_MODE_MS);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.clearTimeout(idle);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [paneMode, goToPane, cyclePane, resizePane, commands]);

  const host = useMemo<PaneHost>(
    () => ({
      client,
      focus,
      controllers,
      composers,
      onPaneChanged: report,
      newChat: (api, group) => addChat(api, { kind: "new", folder }, undefined, group),
      closePane: closeWindowAsked,
      inView: (paneId) =>
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        apis.current.get(tabsRef.current.active)?.activePanel?.id === paneId,
      openGate,
      openChat,
    }),
    [
      client,
      focus,
      controllers,
      composers,
      report,
      addChat,
      folder,
      openGate,
      closeWindowAsked,
      openChat,
    ],
  );
  const labels = new Map(
    tabs.tabs.flatMap((tab) => {
      const label = tab.title ?? tab.firstTitle ?? undefined;
      return label === undefined ? [] : [[tab.id, label] as const];
    }),
  );

  return (
    <PaneHostContext value={host}>
      <PaneModeContext value={paneMode}>
        <ShownTabContext value={apis.current.get(tabs.active) ?? null}>
          <div className="flex min-h-0 flex-1 flex-col">
            {/* The workspaces, always on top on a desktop (#2791); a phone shows one chat at a time. */}
            {!phone && (
              <TabStrip
                tabs={tabs.tabs}
                active={tabs.active}
                labels={labels}
                renaming={renaming}
                onActivate={(id) => switchTabs((state) => activateTab(state, id))}
                onClose={closeTabAsked}
                onRename={(id, title) => setTabs((state) => renameTab(state, id, title))}
                onRenaming={setRenaming}
                onAdd={commands.newTab}
                onMove={(id, to) => setTabs((state) => moveTabTo(state, id, to))}
                leading={stripLeading}
              />
            )}
            <div className="relative min-h-0 flex-1">
              {tabs.tabs.map((tab) => (
                <div
                  key={tab.id}
                  // A workspace not shown keeps its size, only out of sight, of the pointer, of the keys and of a screen
                  // reader (#2832): hidden with `display: none`, its windows and lists were measured at 0 and back at
                  // every switch, and a chat's list then drew its rows for a scroll place it no longer had (a blank
                  // chat after a few quick Ctrl+Tabs while it streamed).
                  className={
                    tab.id === tabs.active ? "absolute inset-0" : "invisible absolute inset-0"
                  }
                  data-hidden={tab.id === tabs.active ? undefined : ""}
                  aria-hidden={tab.id === tabs.active ? undefined : true}
                  inert={tab.id !== tabs.active}
                  data-tab={tab.id}
                  // Several panes side by side or stacked: the tour that has you drag a chat into a split waits for it.
                  data-split={(apis.current.get(tab.id)?.totalPanels ?? 0) > 1 ? "" : undefined}
                >
                  <DockviewReact
                    components={COMPONENTS}
                    theme={THEME}
                    onReady={(event) => ready(tab.id, event)}
                    defaultRenderer="always"
                    disableFloatingGroups
                    singleTabMode="fullwidth"
                    defaultTabComponent={PaneTab}
                    watermarkComponent={BlankWindow}
                    noPanelsOverlay="emptyGroup"
                    dropPositionResolver={resolverFor(tab.id)}
                    dndEdges={EDGE_SHADE}
                  />
                  <DropGuides
                    api={apis.current.get(tab.id)}
                    onEdgeDrop={(position, event) => dropOnEdge(tab.id, position, event)}
                  />
                </div>
              ))}
              {paneMode && (
                // Above dockview's dividers and drop overlay, below the panes' titles, clear of the message boxes.
                <div
                  role="status"
                  data-tour="pane-mode"
                  className="pointer-events-none absolute inset-x-0 top-12 z-[1000] flex justify-center px-3"
                >
                  <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-l2 bg-popover px-3 py-2 text-xs text-t1 shadow-md">
                    <span className="font-medium">Window mode</span>
                    {PANE_MODE_KEYS.map(({ keys, does }) => (
                      <span key={does} className="flex items-center gap-1 text-t2">
                        {keys.map((key) => (
                          <kbd
                            key={key}
                            className="rounded-sm border border-l2 px-1 font-mono text-[11px] text-t1"
                          >
                            {key}
                          </kbd>
                        ))}
                        {does}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </ShownTabContext>
      </PaneModeContext>
    </PaneHostContext>
  );
}

/**
 * How much of the window dockview shades when a lone pane's whole layout takes a drop on one side: the column or row it
 * will be; the band along the window's edges shades the same share itself (`DropGuides`).
 */
const EDGE_SHADE = {
  size: { type: "percentage", value: 30 },
  activationSize: { type: "pixels", value: 10 },
} as const;

/** The keys that reach everything else, in a blank window. */
const START_KEYS = [KEYS.newChat, KEYS.palette, KEYS.shortcuts, KEYS.settings] as const;

/** How many windows a workspace has, kept current as they come and go. */
function useWindowCount(api: DockviewApi): number {
  return useSyncExternalStore(
    (notify) => {
      const added = api.onDidAddGroup(notify);
      const removed = api.onDidRemoveGroup(notify);
      return () => {
        added.dispose();
        removed.dispose();
      };
    },
    () => api.groups.length,
  );
}

/**
 * A blank window (#2791): what a workspace starts as, and what a split or a closed chat leaves. It holds only New chat,
 * which starts a chat in it; a chat opened from the list while it is focused, or dragged onto it, fills it (#2831). Its
 * × closes it, unless it is the workspace's only window. New chat takes the caret when the window comes to the front,
 * so Enter starts a chat. A phone drags nothing and has no keys to show.
 */
function BlankWindow({ containerApi, group }: IWatermarkPanelProps): ReactNode {
  const host = use(PaneHostContext);
  const windows = useWindowCount(containerApi);
  const phone = usePhone();
  const newChat = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (group === undefined) return;
    const take = (): void => {
      if (group.api.isActive) newChat.current?.focus({ preventScroll: true });
    };
    take();
    const subscription = group.api.onDidActiveChange(take);
    return () => subscription.dispose();
  }, [group]);
  return (
    <div
      data-blank-window=""
      className="relative flex h-full flex-col items-center justify-center gap-3 bg-panel px-6 text-center"
    >
      {group !== undefined && windows > 1 && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the window"
          className="absolute top-1.5 right-1.5 text-t3 hover:text-t1 tablet:size-11"
          onClick={() => containerApi.removeGroup(group)}
        >
          <X />
        </Button>
      )}
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-9 opacity-90" />
      <p className="text-base font-medium text-t1">Start a new chat, or open one from the list.</p>
      <Button
        ref={newChat}
        data-new-chat=""
        size="sm"
        className="tablet:h-11"
        onClick={() => host?.newChat(containerApi, group)}
      >
        <SquarePen />
        New chat
      </Button>
      {!phone && (
        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-t3">
          {START_KEYS.map((binding) => (
            <li key={binding.label}>
              <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px] text-t2">
                {keycap(binding)}
              </kbd>{" "}
              {binding.label.toLowerCase()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

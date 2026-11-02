import type { AppClient } from "@omp-app/client";
import { ChatSessionPort, type FolderPath, type ThreadId } from "@omp-app/contracts";
import {
  type DockviewApi,
  type DockviewGroupPanel,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  getPanelData,
  type IDockviewPanel,
  type IWatermarkPanelProps,
  type Position,
  type PositionResolver,
  type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { SquarePen } from "lucide-react";
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
} from "react";
import { type Options, useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import type { ComposerHandle } from "../chat/Composer";
import type { ChatController, ChatTarget } from "../chat/controller";
import { forgetNewChatDraft } from "../chat/drafts";
import { KEYS, keycap } from "../keys/table";
import { FilePane } from "../panels/files/FilePane";
import { isFilePane } from "../panels/files/filePaneParams";
import {
  panelOf,
  ShownTabContext,
  SIDE_PANE,
  SidePane,
  type SidePaneParams,
} from "../panels/SidePane";
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
import { guideResolver } from "./guideCells";
import { equalized, swappedWithNext } from "./layout";
import { OpenGate } from "./openGate";
import { chatOfPane, closePaneAsked, PaneTab } from "./PaneTab";
import { PaneModeContext } from "./paneMode";
import { TabStrip } from "./TabStrip";
import {
  activateTab,
  addTab,
  closeTab,
  layoutStorage,
  loadTabs,
  moveTab,
  renameTab,
  saveLayout,
  stepTab,
  TABS_KEY,
  type WorkspaceTabs,
} from "./tabs";

const THEME: DockviewTheme = { name: "omp", className: "dockview-theme-omp" };
/** A chat's pane, the side panel, and a file opened from the Files panel (#2782). */
const COMPONENTS = { chat: ChatPanel, side: SidePane, file: FilePane };
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
  | "zoom"
  | "closePane"
  | "swapPane"
  | "equalize"
  | "paneMode"
  | "newTab"
  | "nextTab"
  | "previousTab"
  | "closeTab"
  | "renameTab"
  | "moveTabRight"
  | "moveTabLeft";

/** The focused pane's chat and its message box, for the palette. */
export interface FocusedChat {
  readonly controller: ChatController;
  readonly composer: ComposerHandle | undefined;
}

/** What the sidebar and the palette ask of the workspace. */
export interface WorkspaceHandle {
  /**
   * Opens a chat. Where it is already open, that pane gets the focus; otherwise it opens in the focused pane, or with
   * `split` in a new pane to the right of it.
   */
  readonly open: (target: ChatTarget, where: "here" | "split") => void;
  readonly command: (id: WorkspaceCommand) => void;
  readonly focused: () => FocusedChat | null;
  /** A chat was deleted: every pane that showed it gets a new chat, and the page stops keeping it open. */
  readonly forget: (threadId: ThreadId) => void;
  /** Shows the side pane on a panel in the shown tab, at the right of its panes, or takes it away (`null`). */
  readonly side: (panel: string | null) => void;
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

/** A chat pane's parameters; none for the side pane's or a file pane's, which show no chat. */
const paramsOf = (params: unknown): ChatPanelParams | undefined =>
  isFilePane(params) ? undefined : (params as ChatPanelParams | undefined);

/** A pane that shows a chat: not the side panel, not a file. */
const isChatPane = (panel: IDockviewPanel): boolean =>
  panel.id !== SIDE_PANE && !isFilePane(panel.params);

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
  ref,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly phone: boolean;
  readonly onView: (view: WorkspaceView) => void;
  /** A tab of its own with a new chat came to the front (a new tab, a tour's sandbox): a phone shows the chat then. */
  readonly onShown?: () => void;
  readonly ref: Ref<WorkspaceHandle>;
}): ReactNode {
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  const [tabs, setTabs] = useState<WorkspaceTabs>(() =>
    loadTabs(layoutStorage().getItem(TABS_KEY)),
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The focused pane's title in each tab, for tabs without a name of their own. */
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const apis = useRef(new Map<string, DockviewApi>());
  /** Each tab's drop resolver for the docking guides (#2771), made once: dockview reads it at every drag-over. */
  const resolvers = useRef(new Map<string, PositionResolver>());
  const resolverFor = (tabId: string): PositionResolver => {
    let resolver = resolvers.current.get(tabId);
    if (resolver === undefined) {
      resolver = guideResolver(() => {
        const api = apis.current.get(tabId);
        const box = document
          .querySelector(`[data-tab="${CSS.escape(tabId)}"]`)
          ?.getBoundingClientRect();
        return api === undefined || box === undefined
          ? null
          : { width: box.width, height: box.height, panes: api.groups.length };
      }, carriesChat);
      resolvers.current.set(tabId, resolver);
    }
    return resolver;
  };
  /**
   * Counts the tabs' dockviews as they become ready: the shown tab's, read from `apis` while drawing, is known only then,
   * and a side pane restored with the tab's layout draws once it knows its tab is the one shown (#2773).
   */
  const [, setReadyApis] = useState(0);
  const focus = useMemo(() => new PaneFocus(), []);
  const controllers = useMemo(() => new Map<string, ChatController>(), []);
  const composers = useMemo(() => new Map<string, ComposerHandle>(), []);
  /** Whether the phone layout zoomed the focused pane, so leaving the phone layout can undo it. */
  const phoneZoomed = useRef(false);
  /** Tabs made with Ctrl+Shift+T, which open with a new chat. */
  const freshTabs = useRef(new Set<string>());
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

  /** Tells the sidebar what is open, focused and waiting, and keeps each tab's focused title. */
  const report = useCallback(() => {
    const open = new Set<ThreadId>();
    const waiting = new Map<ThreadId, string>();
    const next = new Map<string, string>();
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
      const title = chatPaneIn(api)?.title;
      if (title !== undefined) next.set(tab.id, title);
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
    setTitles(next);
  }, [onView, controllers, chatPaneIn]);

  const focusPane = useCallback(
    (api: DockviewApi) => {
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

  /** Headers only between several panes (never on a phone): a single pane needs no title bar, as in kitty. */
  const syncHeaders = useCallback((api: DockviewApi) => {
    for (const group of api.groups) group.header.hidden = phoneRef.current || api.groups.length < 2;
  }, []);

  /**
   * A new pane with a chat, beside the focused one or on its own; it gets the caret once its message box is there. A new
   * chat runs in the focused pane's folder (as kitty's new window keeps the current one's), else the shown folder; a
   * chat from the list belongs to the list's folder.
   */
  const addChat = useCallback(
    (api: DockviewApi, target: ChatTarget, direction?: "right" | "below") => {
      const reference = chatPaneIn(api);
      const chatFolder = paramsOf(reference?.params)?.folder ?? folder;
      const id = crypto.randomUUID();
      api.addPanel<ChatPanelParams>({
        id,
        component: "chat",
        title: "New chat",
        params: {
          chat: crypto.randomUUID(),
          target: target.kind === "new" ? { kind: "new", folder: chatFolder } : target,
          folder: target.kind === "new" ? chatFolder : folder,
        },
        ...(direction !== undefined && reference !== undefined
          ? { position: { referencePanel: reference, direction } }
          : {}),
      });
      focus.request(id);
    },
    [folder, focus, chatPaneIn],
  );

  /**
   * A chat dropped from the list opens where it lands (#2771): on a pane's arrow guide it splits that pane there, on the
   * pane's middle guide it takes that pane's place, on one of the window's edge guides it runs along that side. A chat a
   * pane shows already moves there, from another tab too, so one pane still shows each chat; dropped on its own pane,
   * it only takes the caret.
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
    [folder, focus],
  );

  /**
   * A drop on one of the window's edge guides (#2771), which take their drops themselves (`DropGuides`): the chat from
   * the list, or the pane dragged by its title, runs the whole length of that side of the window.
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
      // A tab made with Ctrl+Shift+T opens with a new chat, as kitty's opens with a shell; the first tab waits for a pick.
      if (freshTabs.current.delete(tabId) && api.totalPanels === 0) {
        addChat(api, { kind: "new", folder });
        onShownRef.current?.();
      }
      // A phone opens on a new chat in the shown tab, ready to type, with the list a tap away: going through the list
      // to start one is slow on a phone. A new chat already in front stays, with the text kept for it.
      if (phoneRef.current && !phoneStarted.current && tabId === tabsRef.current.active) {
        phoneStarted.current = true;
        const panel = chatPaneIn(api);
        if (panel === undefined) addChat(api, { kind: "new", folder });
        else if (paramsOf(panel.params)?.target.kind !== "new") {
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
      api.onDidRemovePanel(() => {
        if (apis.current.get(tabId) !== api || api.totalPanels > 0) return;
        // As in kitty, a tab whose last pane closes goes; the only tab is left empty.
        if (tabsRef.current.tabs.length > 1) {
          apis.current.delete(tabId);
          setTabs((state) => closeTab(state, tabId));
        }
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
   * goes too. The panes come from the tab's dockview when it is mounted, else from its saved layout.
   */
  const closeTabAsked = useCallback((id: string) => {
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
    setTabs((state) => closeTab(state, id));
  }, []);

  /** The workspace's commands: kitty's keys run them, and the palette offers them. */
  const commands = useMemo<Record<WorkspaceCommand, () => void>>(
    () => ({
      splitRight: () => withActive((api) => addChat(api, { kind: "new", folder }, "right")),
      splitDown: () => withActive((api) => addChat(api, { kind: "new", folder }, "below")),
      zoom: () =>
        withActive((api) => {
          const panel = api.activePanel;
          if (panel === undefined) return;
          if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
          else api.maximizeGroup(panel);
          focusPane(api);
        }),
      closePane: () =>
        withActive((api) => {
          if (api.activePanel !== undefined) closePaneAsked(api.activePanel);
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
      newTab: () =>
        setTabs((state) => {
          const next = addTab(state);
          freshTabs.current.add(next.active);
          return next;
        }),
      nextTab: () => setTabs((state) => stepTab(state, 1)),
      previousTab: () => setTabs((state) => stepTab(state, -1)),
      closeTab: () => closeTabAsked(tabsRef.current.active),
      renameTab: () => setRenaming(tabsRef.current.active),
      moveTabRight: () => setTabs((state) => moveTab(state, 1)),
      moveTabLeft: () => setTabs((state) => moveTab(state, -1)),
    }),
    [addChat, closeTabAsked, focusPane, folder, withActive],
  );

  useImperativeHandle(
    ref,
    () => ({
      open: (target, where) => {
        if (target.kind === "existing") {
          for (const [tabId, api] of apis.current) {
            const panel = api.panels.find((candidate) => {
              const shown = paramsOf(candidate.params)?.target;
              return shown?.kind === "existing" && shown.threadId === target.threadId;
            });
            if (panel === undefined) continue;
            setTabs((state) => activateTab(state, tabId));
            panel.api.setActive();
            zoomForPhone(api);
            focusPane(api);
            return;
          }
        }
        withActive((api) => {
          const panel = chatPaneIn(api);
          if (where === "split" || panel === undefined) addChat(api, target, "right");
          else {
            // A new chat runs in the folder it names; a chat from the list belongs to the list's folder.
            panel.api.updateParameters({
              chat: crypto.randomUUID(),
              target,
              folder: target.kind === "new" ? target.folder : folder,
            } satisfies ChatPanelParams);
            panel.api.setTitle("New chat");
            focus.request(panel.id, true);
          }
          report();
        });
      },
      command: (id) => commands[id](),
      forget: (threadId) => {
        // Before the panes move on, so the one that showed it closes it instead of keeping it open.
        chatCache.forget(threadId);
        for (const api of apis.current.values()) {
          for (const panel of api.panels) {
            const shown = paramsOf(panel.params);
            if (shown?.target.kind !== "existing" || shown.target.threadId !== threadId) continue;
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
    }),
    [
      addChat,
      chatPaneIn,
      commands,
      composers,
      controllers,
      focus,
      focusPane,
      folder,
      report,
      withActive,
      zoomForPhone,
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
  useHotkeys(KEYS.nextTab.hotkey, commands.nextTab, keys);
  useHotkeys(KEYS.previousTab.hotkey, commands.previousTab, keys);
  useHotkeys(KEYS.closeTab.hotkey, commands.closeTab, keys);
  useHotkeys(KEYS.renameTab.hotkey, commands.renameTab, keys);
  useHotkeys(KEYS.moveTabRight.hotkey, commands.moveTabRight, keys);
  useHotkeys(KEYS.moveTabLeft.hotkey, commands.moveTabLeft, keys);
  useHotkeys(KEYS.paneMode.hotkey, commands.paneMode, keys);
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
        if (event.ctrlKey && event.shiftKey && event.code === "Space") take();
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
      newChat: (api) => addChat(api, { kind: "new", folder }),
      inView: (paneId) =>
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        apis.current.get(tabsRef.current.active)?.activePanel?.id === paneId,
      openGate,
    }),
    [client, focus, controllers, composers, report, addChat, folder, openGate],
  );
  const labels = new Map(
    tabs.tabs.flatMap((tab) => {
      const label = tab.title ?? titles.get(tab.id);
      return label === undefined ? [] : [[tab.id, label] as const];
    }),
  );

  return (
    <PaneHostContext value={host}>
      <PaneModeContext value={paneMode}>
        <ShownTabContext value={apis.current.get(tabs.active) ?? null}>
          <div className="flex min-h-0 flex-1 flex-col">
            {tabs.tabs.length > 1 && !phone && (
              <TabStrip
                tabs={tabs.tabs}
                active={tabs.active}
                labels={labels}
                renaming={renaming}
                onActivate={(id) => setTabs((state) => activateTab(state, id))}
                onClose={closeTabAsked}
                onRename={(id, title) => setTabs((state) => renameTab(state, id, title))}
                onRenaming={setRenaming}
              />
            )}
            <div className="relative min-h-0 flex-1">
              {tabs.tabs.map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  hidden={tab.id !== tabs.active}
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
                    watermarkComponent={EmptyTab}
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
                    <span className="font-medium">Pane mode</span>
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
 * How much of the window dockview shades when its whole layout takes a drop on one side (the arrows of a lone pane): the
 * column or row it will be; the window's own edge guides shade the same share themselves (`DropGuides`).
 */
const EDGE_SHADE = {
  size: { type: "percentage", value: 30 },
  activationSize: { type: "pixels", value: 10 },
} as const;

/** The keys that reach everything else, on an empty tab. */
const START_KEYS = [KEYS.palette, KEYS.shortcuts, KEYS.settings] as const;

/**
 * A tab with no pane: the first one, before a chat is picked, and the last one once its panes are closed. Its New chat
 * opens in this tab.
 */
function EmptyTab({ containerApi }: IWatermarkPanelProps): ReactNode {
  const host = use(PaneHostContext);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-panel px-6 text-center">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-9 opacity-90" />
      <p className="text-base font-medium text-t1">Pick a chat, or start a new one.</p>
      <Button size="sm" onClick={() => host?.newChat(containerApi)}>
        <SquarePen />
        New chat
      </Button>
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
    </div>
  );
}

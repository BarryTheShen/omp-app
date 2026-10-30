import type { AppClient } from "@omp-app/client";
import type { FolderPath, ThreadId } from "@omp-app/contracts";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IWatermarkPanelProps,
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
import { KEYS, keycap } from "../keys/table";
import {
  ChatPanel,
  type ChatPanelParams,
  PaneFocus,
  type PaneHost,
  PaneHostContext,
} from "./ChatPanel";
import { equalized, swappedWithNext } from "./layout";
import { TabStrip } from "./TabStrip";
import {
  activateTab,
  addTab,
  closeTab,
  loadTabs,
  moveTab,
  renameTab,
  saveLayout,
  stepTab,
  TABS_KEY,
  type WorkspaceTabs,
} from "./tabs";

const THEME: DockviewTheme = { name: "omp", className: "dockview-theme-omp" };
const COMPONENTS = { chat: ChatPanel };
/** How much one resize key widens, narrows, heightens or shortens the focused pane. */
const RESIZE_STEP_PX = 48;

/** The workspace's commands the palette offers (kitty's keys run them too). */
export type WorkspaceCommand =
  | "splitRight"
  | "splitDown"
  | "zoom"
  | "closePane"
  | "swapPane"
  | "equalize"
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
  /** A chat was deleted: every pane that showed it gets a new chat. */
  readonly forget: (threadId: ThreadId) => void;
}

/** What the workspace shows, for the sidebar: the focused pane's chat, the chats open in panes, and those waiting. */
export interface WorkspaceView {
  readonly focused: ThreadId | null;
  readonly open: ReadonlySet<ThreadId>;
  /** Open chats with an approval or a question waiting for you, each with its pane's title. */
  readonly waiting: ReadonlyMap<ThreadId, string>;
}

const paramsOf = (params: unknown): ChatPanelParams | undefined =>
  params as ChatPanelParams | undefined;

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
  ref,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly phone: boolean;
  readonly onView: (view: WorkspaceView) => void;
  readonly ref: Ref<WorkspaceHandle>;
}): ReactNode {
  const [tabs, setTabs] = useState<WorkspaceTabs>(() => loadTabs(localStorage.getItem(TABS_KEY)));
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The focused pane's title in each tab, for tabs without a name of their own. */
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const apis = useRef(new Map<string, DockviewApi>());
  const focus = useMemo(() => new PaneFocus(), []);
  const controllers = useMemo(() => new Map<string, ChatController>(), []);
  const composers = useMemo(() => new Map<string, ComposerHandle>(), []);
  /** Whether the phone layout zoomed the focused pane, so leaving the phone layout can undo it. */
  const phoneZoomed = useRef(false);
  /** Tabs made with Ctrl+Shift+T, which open with a new chat. */
  const freshTabs = useRef(new Set<string>());

  useEffect(() => localStorage.setItem(TABS_KEY, JSON.stringify(tabs)), [tabs]);

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
      const title = api.activePanel?.title;
      if (title !== undefined) next.set(tab.id, title);
    }
    const focused = paramsOf(apis.current.get(tabsRef.current.active)?.activePanel?.params)?.target;
    onView({ focused: focused?.kind === "existing" ? focused.threadId : null, open, waiting });
    setTitles(next);
  }, [onView, controllers]);

  const focusPane = useCallback(
    (api: DockviewApi) => {
      const id = api.activePanel?.id;
      if (id !== undefined) focus.request(id);
    },
    [focus],
  );

  /** On a phone the focused pane fills the screen: dockview's zoom, which a phone's layout does not keep. */
  const zoomForPhone = useCallback((api: DockviewApi) => {
    const panel = api.activePanel;
    if (phoneRef.current && panel !== undefined && !panel.api.isMaximized())
      api.maximizeGroup(panel);
  }, []);

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
      const reference = api.activePanel;
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
    [folder, focus],
  );

  const ready = useCallback(
    (tabId: string, event: DockviewReadyEvent) => {
      const { api } = event;
      apis.current.set(tabId, api);
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
      if (freshTabs.current.delete(tabId) && api.totalPanels === 0)
        addChat(api, { kind: "new", folder });
      api.onDidLayoutChange(() => {
        if (apis.current.get(tabId) !== api) return;
        syncHeaders(api);
        setTabs((state) => saveLayout(state, tabId, keptLayout(api.toJSON(), phoneRef.current)));
        report();
      });
      api.onDidActivePanelChange(() => {
        if (apis.current.get(tabId) !== api) return;
        zoomForPhone(api);
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
      syncHeaders(api);
      report();
    },
    [addChat, folder, report, syncHeaders, zoomForPhone],
  );

  const withActive = useCallback((action: (api: DockviewApi) => void): void => {
    const api = apis.current.get(tabsRef.current.active);
    if (api !== undefined) action(api);
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
      closePane: () => withActive((api) => api.activePanel?.api.close()),
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
      newTab: () =>
        setTabs((state) => {
          const next = addTab(state);
          freshTabs.current.add(next.active);
          return next;
        }),
      nextTab: () => setTabs((state) => stepTab(state, 1)),
      previousTab: () => setTabs((state) => stepTab(state, -1)),
      closeTab: () => {
        const id = tabsRef.current.active;
        apis.current.delete(id);
        setTabs((state) => closeTab(state, id));
      },
      renameTab: () => setRenaming(tabsRef.current.active),
      moveTabRight: () => setTabs((state) => moveTab(state, 1)),
      moveTabLeft: () => setTabs((state) => moveTab(state, -1)),
    }),
    [addChat, focusPane, folder, withActive],
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
          const panel = api.activePanel;
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
        const id = apis.current.get(tabsRef.current.active)?.activePanel?.id;
        const controller = id === undefined ? undefined : controllers.get(id);
        return controller === undefined || id === undefined
          ? null
          : { controller, composer: composers.get(id) };
      },
    }),
    [
      addChat,
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

  // A tab coming to the front gets the caret in its focused pane; on a phone, its focused pane fills the screen.
  useEffect(() => {
    const api = apis.current.get(tabs.active);
    for (const each of apis.current.values()) syncHeaders(each);
    if (api === undefined) return;
    if (phone) zoomForPhone(api);
    else if (api.hasMaximizedGroup() && phoneZoomed.current) api.exitMaximizedGroup();
    phoneZoomed.current = phone;
    focusPane(api);
    report();
  }, [tabs.active, phone, focusPane, report, syncHeaders, zoomForPhone]);

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
  useHotkeys(
    KEYS.focusPane.hotkey,
    (_event, handler) =>
      withActive((api) => {
        const group = api.activeGroup;
        const direction = handler.keys?.[0];
        if (group === undefined || direction === undefined) return;
        const next = api.adjacentGroupInDirection(
          group,
          direction.replace("arrow", "") as "left" | "right" | "up" | "down",
        );
        if (next === undefined) return;
        next.api.setActive();
        focusPane(api);
      }),
    keys,
  );
  useHotkeys(
    KEYS.cyclePane.hotkey,
    (_event, handler) =>
      withActive((api) => {
        if (handler.keys?.[0] === "bracketright") api.activateNext();
        else api.activatePrevious();
        focusPane(api);
      }),
    keys,
  );
  useHotkeys(
    KEYS.resizePane.hotkey,
    (_event, handler) =>
      withActive((api) => {
        const group = api.activeGroup;
        const key = handler.keys?.[0];
        if (group === undefined || key === undefined) return;
        // Wider, narrower, taller, shorter by a step, as kitty's resize.
        const step = RESIZE_STEP_PX;
        if (key === "arrowleft" || key === "arrowright")
          group.api.setSize({ width: group.api.width + (key === "arrowright" ? step : -step) });
        else group.api.setSize({ height: group.api.height + (key === "arrowup" ? step : -step) });
      }),
    keys,
  );

  const host = useMemo<PaneHost>(
    () => ({
      client,
      focus,
      controllers,
      composers,
      onPaneChanged: report,
      newChat: (api) => addChat(api, { kind: "new", folder }),
    }),
    [client, focus, controllers, composers, report, addChat, folder],
  );
  const labels = new Map(
    tabs.tabs.flatMap((tab) => {
      const label = tab.title ?? titles.get(tab.id);
      return label === undefined ? [] : [[tab.id, label] as const];
    }),
  );

  return (
    <PaneHostContext value={host}>
      <div className="flex min-h-0 flex-1 flex-col">
        {tabs.tabs.length > 1 && !phone && (
          <TabStrip
            tabs={tabs.tabs}
            active={tabs.active}
            labels={labels}
            renaming={renaming}
            onActivate={(id) => setTabs((state) => activateTab(state, id))}
            onClose={(id) => {
              apis.current.delete(id);
              setTabs((state) => closeTab(state, id));
            }}
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
            >
              <DockviewReact
                components={COMPONENTS}
                theme={THEME}
                onReady={(event) => ready(tab.id, event)}
                defaultRenderer="always"
                disableFloatingGroups
                singleTabMode="fullwidth"
                watermarkComponent={EmptyTab}
              />
            </div>
          ))}
        </div>
      </div>
    </PaneHostContext>
  );
}

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

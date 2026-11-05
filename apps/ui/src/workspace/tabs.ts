import type { SerializedDockview } from "dockview-react";
import { desktopBridge } from "../desktop/bridge";

/** One workspace (#2791), a tab on top as kitty's: its own layout of windows, saved as dockview writes it. */
export interface WorkspaceTab {
  readonly id: string;
  /** A name given with Rename; null shows its first chat's title. */
  readonly title: string | null;
  /** The title of its first chat to have one: its name until one is given. Absent in tabs kept before #2791. */
  readonly firstTitle?: string | null;
  /**
   * The window whose chat names it (#2829): the workspace follows that chat's title as omp names the chat. Absent in
   * tabs kept before #2829: the window that names one next becomes its.
   */
  readonly firstPane?: string | null;
  /** The windows and their chats; null until the workspace's first layout is saved. */
  readonly layout: SerializedDockview | null;
}

export interface WorkspaceTabs {
  readonly tabs: readonly WorkspaceTab[];
  readonly active: string;
}

/** Where the tabs are kept in this browser. */
export const TABS_KEY = "omp-app.ui.workspace";

/** The first desktop window's label, whose tabs the next start restores. */
const FIRST_WINDOW = "main";

/**
 * Where this page keeps its tabs. A browser tab and the first desktop window keep them in localStorage, which the next
 * start restores. Any other desktop window, which the desktop app opens at an address with `?window=<label>`, keeps its
 * own in sessionStorage under the same key: a reload keeps them, closing the window drops them, and it starts with one
 * empty tab, so no window overwrites another's layout. A browser tab ignores the query.
 */
export function layoutStorage(
  inDesktopWindow: boolean = desktopBridge() !== null,
  search: string = window.location.search,
): Storage {
  const label = new URLSearchParams(search).get("window");
  const another = label !== null && label !== "" && label !== FIRST_WINDOW;
  return inDesktopWindow && another ? sessionStorage : localStorage;
}

const newTab = (): WorkspaceTab => ({ id: crypto.randomUUID(), title: null, layout: null });

export function initialTabs(): WorkspaceTabs {
  const tab = newTab();
  return { tabs: [tab], active: tab.id };
}

/** The tabs as kept, or one empty tab when nothing usable is kept. */
export function loadTabs(raw: string | null): WorkspaceTabs {
  if (raw === null) return initialTabs();
  try {
    const kept = JSON.parse(raw) as Partial<WorkspaceTabs>;
    const tabs = Array.isArray(kept.tabs)
      ? kept.tabs.filter(
          (tab): tab is WorkspaceTab =>
            typeof tab === "object" &&
            tab !== null &&
            typeof tab.id === "string" &&
            (tab.title === null || typeof tab.title === "string") &&
            (tab.firstTitle === undefined ||
              tab.firstTitle === null ||
              typeof tab.firstTitle === "string") &&
            (tab.firstPane === undefined ||
              tab.firstPane === null ||
              typeof tab.firstPane === "string") &&
            (tab.layout === null || (typeof tab.layout === "object" && tab.layout !== undefined)),
        )
      : [];
    const first = tabs[0];
    if (first === undefined) return initialTabs();
    const active = tabs.some((tab) => tab.id === kept.active) ? (kept.active as string) : first.id;
    return { tabs, active };
  } catch {
    return initialTabs();
  }
}

const indexOf = (state: WorkspaceTabs, id: string): number =>
  state.tabs.findIndex((tab) => tab.id === id);

/** A new tab right after the active one, made active (kitty's new tab). */
export function addTab(state: WorkspaceTabs): WorkspaceTabs {
  const tab = newTab();
  const tabs = [...state.tabs];
  tabs.splice(indexOf(state, state.active) + 1, 0, tab);
  return { tabs, active: tab.id };
}

/** Closes a tab; its right neighbour becomes active (else its left one). The last tab is replaced by an empty one. */
export function closeTab(state: WorkspaceTabs, id: string): WorkspaceTabs {
  const index = indexOf(state, id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return initialTabs();
  if (state.active !== id) return { tabs, active: state.active };
  const next = tabs[Math.min(index, tabs.length - 1)] as WorkspaceTab;
  return { tabs, active: next.id };
}

/** The next or the previous tab, wrapping around. */
export function stepTab(state: WorkspaceTabs, step: 1 | -1): WorkspaceTabs {
  const count = state.tabs.length;
  const index = (indexOf(state, state.active) + step + count) % count;
  return { ...state, active: (state.tabs[index] as WorkspaceTab).id };
}

/** Moves the active tab one place left or right; at an end it stays. */
export function moveTab(state: WorkspaceTabs, step: 1 | -1): WorkspaceTabs {
  const from = indexOf(state, state.active);
  const to = from + step;
  if (from < 0 || to < 0 || to >= state.tabs.length) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab as WorkspaceTab);
  return { ...state, tabs };
}

/** Puts a tab at another place in the strip, dragged there: moved right, it lands after the tab it was dropped on. */
export function moveTabTo(state: WorkspaceTabs, id: string, to: number): WorkspaceTabs {
  const from = indexOf(state, id);
  if (from < 0 || to < 0 || to >= state.tabs.length || to === from) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab as WorkspaceTab);
  return { ...state, tabs };
}

/**
 * A workspace without a name takes the title of its first chat to have one (#2791), from that chat's window (`pane`),
 * and follows that window's chat as omp names it later (#2829): a new chat's first title is its first message. Another
 * window's chat never names it.
 */
export function nameAfterChat(
  state: WorkspaceTabs,
  id: string,
  title: string,
  pane: string,
): WorkspaceTabs {
  const tab = state.tabs.find((each) => each.id === id);
  if (tab === undefined) return state;
  const mine = (tab.firstPane ?? null) === null || tab.firstPane === pane;
  const named = (tab.firstTitle ?? null) !== null;
  if (named && (!mine || (tab.firstTitle === title && tab.firstPane === pane))) return state;
  return {
    ...state,
    tabs: state.tabs.map((each) =>
      each.id === id ? { ...each, firstTitle: title, firstPane: pane } : each,
    ),
  };
}

export function activateTab(state: WorkspaceTabs, id: string): WorkspaceTabs {
  return indexOf(state, id) < 0 ? state : { ...state, active: id };
}

/** Names a tab; an empty name goes back to its first chat's title. */
export function renameTab(state: WorkspaceTabs, id: string, title: string): WorkspaceTabs {
  const name = title.trim();
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, title: name === "" ? null : name } : tab,
    ),
  };
}

export function saveLayout(
  state: WorkspaceTabs,
  id: string,
  layout: SerializedDockview,
): WorkspaceTabs {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, layout } : tab)),
  };
}

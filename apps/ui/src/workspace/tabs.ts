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

/** A workspace closed, with the place it had in the strip: Reopen puts it back there (#2831). */
export interface ClosedTab {
  readonly tab: WorkspaceTab;
  readonly index: number;
}

export interface WorkspaceTabs {
  readonly tabs: readonly WorkspaceTab[];
  readonly active: string;
  /** The workspaces closed last, oldest first, at most `MAX_CLOSED`; absent in tabs kept before #2831. */
  readonly closed?: readonly ClosedTab[];
}

/** How many closed workspaces Reopen can bring back, as a browser keeps recently closed tabs. */
export const MAX_CLOSED = 10;

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

/** A new workspace: one blank window, no name yet. */
export const blankTab = (): WorkspaceTab => ({
  id: crypto.randomUUID(),
  title: null,
  layout: null,
});

const isTab = (tab: unknown): tab is WorkspaceTab => {
  if (typeof tab !== "object" || tab === null) return false;
  const each = tab as Partial<WorkspaceTab>;
  return (
    typeof each.id === "string" &&
    (each.title === null || typeof each.title === "string") &&
    (each.firstTitle === undefined ||
      each.firstTitle === null ||
      typeof each.firstTitle === "string") &&
    (each.firstPane === undefined ||
      each.firstPane === null ||
      typeof each.firstPane === "string") &&
    (each.layout === null || (typeof each.layout === "object" && each.layout !== undefined))
  );
};

/** Whether a workspace holds nothing: no window shows a chat, a file or the side panel. */
export const isBlankTab = (tab: WorkspaceTab): boolean =>
  tab.layout === null || Object.keys(tab.layout.panels ?? {}).length === 0;

export function initialTabs(): WorkspaceTabs {
  const tab = blankTab();
  return { tabs: [tab], active: tab.id };
}

/** The tabs as kept, or one empty tab when nothing usable is kept. */
export function loadTabs(raw: string | null): WorkspaceTabs {
  if (raw === null) return initialTabs();
  try {
    const kept = JSON.parse(raw) as Partial<WorkspaceTabs>;
    const tabs = Array.isArray(kept.tabs) ? kept.tabs.filter(isTab) : [];
    const first = tabs[0];
    if (first === undefined) return initialTabs();
    const active = tabs.some((tab) => tab.id === kept.active) ? (kept.active as string) : first.id;
    const closed = Array.isArray(kept.closed)
      ? kept.closed
          .filter(
            (entry): entry is ClosedTab =>
              typeof entry === "object" &&
              entry !== null &&
              isTab(entry.tab) &&
              Number.isInteger(entry.index) &&
              entry.index >= 0 &&
              !tabs.some((tab) => tab.id === entry.tab.id),
          )
          .slice(-MAX_CLOSED)
      : [];
    return closed.length > 0 ? { tabs, active, closed } : { tabs, active };
  } catch {
    return initialTabs();
  }
}

const indexOf = (state: WorkspaceTabs, id: string): number =>
  state.tabs.findIndex((tab) => tab.id === id);

/**
 * Puts a tab right after `after` (the active one when it is gone), made active or left behind it: a new workspace
 * (kitty's new tab; VS Code's default place for a new tab), or a chat opened in a workspace of its own (#2831).
 */
export function insertTab(
  state: WorkspaceTabs,
  tab: WorkspaceTab,
  after: string,
  activate: boolean,
): WorkspaceTabs {
  const at = indexOf(state, after) >= 0 ? indexOf(state, after) : indexOf(state, state.active);
  const tabs = [...state.tabs];
  tabs.splice(at + 1, 0, tab);
  return { ...state, tabs, active: activate ? tab.id : state.active };
}

/**
 * Closes a tab. The active one hands over to `owner`, the tab it was opened from, when given and still there, as a
 * browser goes back to the tab a tab just opened came from (#2831); else to its right neighbour, else its left one.
 * The last tab is replaced by an empty one. A tab that held something is kept, with its place, for Reopen (#2831); a
 * blank one is not.
 */
export function closeTab(state: WorkspaceTabs, id: string, owner?: string): WorkspaceTabs {
  const index = indexOf(state, id);
  if (index < 0) return state;
  const closing = state.tabs[index] as WorkspaceTab;
  const closed = isBlankTab(closing)
    ? (state.closed ?? [])
    : [...(state.closed ?? []), { tab: closing, index }].slice(-MAX_CLOSED);
  const kept = closed.length > 0 ? { closed } : {};
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return { ...initialTabs(), ...kept };
  if (state.active !== id) return { tabs, active: state.active, ...kept };
  const next =
    tabs.find((tab) => tab.id === owner) ??
    (tabs[Math.min(index, tabs.length - 1)] as WorkspaceTab);
  return { tabs, active: next.id, ...kept };
}

/**
 * Brings back the workspace closed last, at its place, made active, as a browser's Ctrl+Shift+T. When only the blank
 * workspace that closing the last one left is there, the reopened one takes its place. Nothing to reopen: as it was.
 */
export function reopenTab(state: WorkspaceTabs): WorkspaceTabs {
  const last = state.closed?.at(-1);
  if (last === undefined) return state;
  const closed = (state.closed ?? []).slice(0, -1);
  const kept = closed.length > 0 ? { closed } : {};
  const only = state.tabs.length === 1 ? state.tabs[0] : undefined;
  if (only !== undefined && isBlankTab(only))
    return { tabs: [last.tab], active: last.tab.id, ...kept };
  const tabs = [...state.tabs];
  tabs.splice(Math.min(last.index, tabs.length), 0, last.tab);
  return { tabs, active: last.tab.id, ...kept };
}

/** The tab at `index` (from 0), as a browser's Ctrl+1…8; `last` for Ctrl+9. Past the end: as it was. */
export function goToTab(state: WorkspaceTabs, index: number | "last"): WorkspaceTabs {
  const tab = index === "last" ? state.tabs.at(-1) : state.tabs[index];
  return tab === undefined ? state : { ...state, active: tab.id };
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

import { useSyncExternalStore } from "react";

/** Where this browser keeps the side panel's state. */
const STORAGE_KEY = "omp-app.ui.panel";

export interface PanelState {
  /** Whether the side column shows. */
  readonly open: boolean;
  /** The panel it shows: a registry id. */
  readonly panel: string;
}

const CLOSED: PanelState = { open: false, panel: "usage" };

function stored(): PanelState {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      typeof kept === "object" &&
      kept !== null &&
      "open" in kept &&
      typeof kept.open === "boolean" &&
      "panel" in kept &&
      typeof kept.panel === "string"
    )
      return { open: kept.open, panel: kept.panel };
  } catch {
    // Storage may be off, or hold something else: the panel starts closed.
  }
  return CLOSED;
}

let state: PanelState | null = null;
const listeners = new Set<() => void>();
const current = (): PanelState => {
  state ??= stored();
  return state;
};

function update(next: PanelState): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be off; the panel still opens for this page.
  }
  for (const listener of [...listeners]) listener();
}

/** Shows or hides the side column, on the panel it showed last. */
export const togglePanel = (): void => update({ ...current(), open: !current().open });
/** Shows the side column on one panel. */
export const showPanel = (panel: string): void => update({ open: true, panel });
export const hidePanel = (): void => update({ ...current(), open: false });

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function usePanelState(): PanelState {
  return useSyncExternalStore(subscribe, current);
}

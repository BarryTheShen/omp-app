import { useSyncExternalStore } from "react";

/**
 * Settings → App → Look → Group tool calls: whether a run of tool calls is drawn as one card (`groupToolRuns`). On
 * unless turned off; kept in this browser, as the style and theme are.
 */
const KEY = "omp-app.ui.group-tools";
const listeners = new Set<() => void>();
/** The choice when this browser keeps no storage: it holds until the page reloads. */
let unkept = true;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return unkept;
  }
}

export function setGroupTools(on: boolean): void {
  unkept = on;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // No storage: `unkept` holds the choice.
  }
  for (const listener of listeners) listener();
}

/** Whether runs of tool calls are grouped, kept current. */
export function useGroupTools(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => true,
  );
}

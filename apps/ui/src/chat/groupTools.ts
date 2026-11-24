import { useSyncExternalStore } from "react";
import { lookChanged } from "../look/changes";

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

/** Groups runs or not; `fromLook`: the look for every device brought it (`look/sync.ts`), not a change made here. */
export function setGroupTools(on: boolean, fromLook = false): void {
  unkept = on;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // No storage: `unkept` holds the choice.
  }
  for (const listener of listeners) listener();
  if (!fromLook) lookChanged();
}

/** Whether runs of tool calls are grouped, as this browser keeps it. */
export const groupToolsNow = (): boolean => read();

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

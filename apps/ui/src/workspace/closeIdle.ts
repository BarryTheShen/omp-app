import { useSyncExternalStore } from "react";
import { lookChanged } from "../look/changes";

/**
 * Settings → App → Workspaces → Close workspaces not used for: how long a workspace may stay out of front before it
 * closes by itself (`idleTabs`), in hours; null never. 12 hours unless changed; kept in this browser, as the style and
 * theme are.
 */
const KEY = "omp-app.ui.workspace.close-after";

/** The choices, in hours; null is Never. */
export const CLOSE_AFTER_CHOICES: readonly (number | null)[] = [1, 12, 24, 168, null];
export const DEFAULT_CLOSE_AFTER = 12;

const listeners = new Set<() => void>();
/** The choice when this browser keeps no storage: it holds until the page reloads. */
let unkept: number | null = DEFAULT_CLOSE_AFTER;

function parse(raw: string | null): number | null {
  if (raw === null) return DEFAULT_CLOSE_AFTER;
  if (raw === "never") return null;
  const hours = Number(raw);
  return CLOSE_AFTER_CHOICES.includes(hours) ? hours : DEFAULT_CLOSE_AFTER;
}

function read(): number | null {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return unkept;
  }
}

/** Sets the hours; `fromLook`: the look for every device brought it (`look/sync.ts`), not a change made here. */
export function setCloseAfter(hours: number | null, fromLook = false): void {
  unkept = hours;
  try {
    if (hours === DEFAULT_CLOSE_AFTER) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, hours === null ? "never" : String(hours));
  } catch {
    // No storage: `unkept` holds the choice.
  }
  for (const listener of listeners) listener();
  if (!fromLook) lookChanged();
}

/** The hours as this browser keeps them; null never. */
export const closeAfterNow = (): number | null => read();

/** How many hours a workspace may go unused before it closes; null never. Kept current. */
export function useCloseAfter(): number | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => DEFAULT_CLOSE_AFTER,
  );
}

/** The choice's words: "1 hour", "12 hours", "1 day", "1 week", "Never". */
export function closeAfterWords(hours: number | null): string {
  if (hours === null) return "Never";
  if (hours === 168) return "1 week";
  if (hours === 24) return "1 day";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

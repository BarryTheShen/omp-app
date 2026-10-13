/**
 * The notices the stack has drawn in this tab, kept in the tab's sessionStorage so a reload draws them again without a
 * fade. A stream notice's key holds the server's sequence number for its event, and a reload replays that event under
 * the same key (see `notificationKey`), so the key names the same notice on both loads.
 */

/** The most recent drawn notices kept. An older one that comes back fades in again. */
export const MAX_DRAWN_NOTICES = 100;

/** The sessionStorage key of this tab's drawn notices. */
export const DRAWN_NOTICES_STORAGE_KEY = "omp-app.drawn-notices";

/** The part of Web Storage the memory uses, so a test can pass its own. */
export type DrawnNoticeStorage = Pick<Storage, "getItem" | "setItem">;

export interface DrawnNotices {
  /** Whether an earlier load of this tab drew the notice and it has not left since: a reload draws it without a fade. */
  isRestored(key: string): boolean;
  /** The stack drew the notice: remember it, so a reload draws it without a fade. */
  drew(key: string): void;
  /** The notice left the stack: forget it, so it fades in again if it comes back. */
  left(key: string): void;
}

function tabStorage(): DrawnNoticeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // The browser refuses storage: nothing is remembered across a reload.
  }
}

function readKeys(storage: DrawnNoticeStorage | null): string[] {
  if (storage === null) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DRAWN_NOTICES_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return []; // Damaged storage restores nothing.
  }
}

function writeKeys(storage: DrawnNoticeStorage | null, keys: readonly string[]): void {
  if (storage === null) return;
  try {
    storage.setItem(DRAWN_NOTICES_STORAGE_KEY, JSON.stringify(keys.slice(-MAX_DRAWN_NOTICES)));
  } catch {
    // Storage that is full or closed: the notices are not restored after a reload, and nothing else changes.
  }
}

/**
 * The drawn notices of one tab. The keys an earlier load drew are read once, when the memory is made, so a notice's fade
 * decision cannot change while it is drawn: `drew` only writes to storage, and `left` forgets the key in both places.
 */
export function sessionDrawnNotices(
  storage: DrawnNoticeStorage | null = tabStorage(),
): DrawnNotices {
  const restored = new Set(readKeys(storage));
  return {
    isRestored: (key) => restored.has(key),
    drew(key) {
      writeKeys(storage, [...readKeys(storage).filter((item) => item !== key), key]);
    },
    left(key) {
      restored.delete(key);
      writeKeys(
        storage,
        readKeys(storage).filter((item) => item !== key),
      );
    },
  };
}

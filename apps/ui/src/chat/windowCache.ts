import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { createStore, del, get, set } from "idb-keyval";

/**
 * The newest window of each recently opened chat, kept in this browser so a chat opened again shows at once, before
 * the app's server has read its file. The file's window replaces it as soon as it arrives.
 */
const store = createStore("omp-app-ui-windows", "windows");

/** How many chats are kept; the least recently opened go first. */
const KEPT_CHATS = 40;
const ORDER = "order";

export interface CachedWindow {
  readonly entries: readonly SessionEntry[];
  readonly hasOlder: boolean;
}

/** The window kept for a chat, if any (and nothing if this browser cannot use IndexedDB). */
export async function cachedWindow(threadId: string): Promise<CachedWindow | undefined> {
  try {
    return await get<CachedWindow>(`chat:${threadId}`, store);
  } catch {
    return undefined;
  }
}

let writing = Promise.resolve();

/** Keeps a chat's newest window, and forgets the least recently opened chats beyond {@link KEPT_CHATS}. */
export function keepWindow(threadId: string, window: CachedWindow): void {
  // One write after another, so the order of chats is never written from two places at once.
  writing = writing
    .then(async () => {
      await set(`chat:${threadId}`, { entries: window.entries, hasOlder: window.hasOlder }, store);
      const order = ((await get<string[]>(ORDER, store)) ?? []).filter((id) => id !== threadId);
      order.push(threadId);
      for (const gone of order.splice(0, Math.max(0, order.length - KEPT_CHATS)))
        await del(`chat:${gone}`, store);
      await set(ORDER, order, store);
    })
    .catch(() => undefined);
}

import type { ThreadId } from "@omp-app/contracts";
import { unsentChatReloadTarget } from "@/modules/U2/drafts";

export const FOLDER_KEY = "omp.app.root.folder";
export const THREAD_KEY = "omp.app.root.thread";
export const UNSENT_CHAT_KEY = "omp.app.root.unsent-chat";

export function readSessionValue(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Reload persistence is best effort; the visible application remains usable.
  }
}
export function readTabValue(key: string, fallback: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeTabValue(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // The marker only restores the new-chat view; the local draft remains the durable copy.
  }
}

export function persistUnsentChatReload(threadId?: ThreadId): void {
  const target = unsentChatReloadTarget(
    {
      savedThread: readSessionValue(THREAD_KEY, ""),
      unsentMarker: readTabValue(UNSENT_CHAT_KEY, ""),
    },
    threadId,
  );
  writeSessionValue(THREAD_KEY, target.savedThread);
  writeTabValue(UNSENT_CHAT_KEY, target.unsentMarker);
}

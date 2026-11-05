import type { ThreadId } from "@omp-app/contracts";
import { useSyncExternalStore } from "react";

/**
 * Each saved chat's name as the chat list reads it from its file (`titleOf`: the name it was given, omp's name, else its
 * first message), for a window's title bar and the workspace it names (#2829): the list, the phone's top bar, the
 * window and the workspace show the same name. A chat not saved yet has none here.
 */
const titles = new Map<ThreadId, string>();
const listeners = new Set<() => void>();

/** The list read these chats' names. */
export function noteSavedTitles(named: Iterable<readonly [ThreadId, string]>): void {
  let changed = false;
  for (const [id, title] of named) {
    if (titles.get(id) === title) continue;
    titles.set(id, title);
    changed = true;
  }
  if (changed) for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chat's name from its file, kept current as the list reads it again; undefined before the chat is saved. */
export function useSavedTitle(threadId: ThreadId | null): string | undefined {
  return useSyncExternalStore(subscribe, () =>
    threadId === null ? undefined : titles.get(threadId),
  );
}

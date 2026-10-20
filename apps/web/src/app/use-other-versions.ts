import type { EntryId, ThreadId } from "@omp-app/contracts";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { type OtherVersion, otherVersionsFor } from "@/modules/P3/runs";

/** What the open chat reads from the session catalog: its session list, and a word that the list changed. */
export interface CatalogSessions {
  getSnapshot(): { readonly sessions: Parameters<typeof otherVersionsFor>[0] };
  subscribe(listener: () => void): () => void;
}

/**
 * The other versions of the open chat, read from the session catalog. The catalog publishes a new session list on every
 * change, so each result is compared with the last one: while the versions are unchanged the same array comes back, and
 * the chat's rows are not drawn again for a catalog change that leaves its versions as they were.
 */
export function useOtherVersions(
  catalog: CatalogSessions | null,
  threadId: ThreadId,
): readonly OtherVersion[] {
  const latest = useRef<readonly OtherVersion[] | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => catalog?.subscribe(listener) ?? (() => undefined),
    [catalog],
  );
  const getSnapshot = useCallback((): readonly OtherVersion[] => {
    const versions = otherVersionsFor(catalog?.getSnapshot().sessions ?? [], threadId);
    const previous = latest.current;
    const unchanged =
      previous !== null &&
      previous.length === versions.length &&
      previous.every((version, index) => {
        const next = versions[index];
        return (
          next !== undefined && version.threadId === next.threadId && version.title === next.title
        );
      });
    if (previous !== null && unchanged) return previous;
    latest.current = versions;
    return versions;
  }, [catalog, threadId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The chat's last saved user message and its other versions, published after the chat draws. Only the row of that
 * message shows the version switcher, and each row reads its own answer here, so a change of the last user message
 * draws the two rows whose switcher changes, not every row of the transcript.
 */
export interface LastUserVersions {
  /** The other versions if `entryId` is the last saved user message, else undefined. The same array while nothing changes. */
  versionsFor(entryId: EntryId): readonly OtherVersion[] | undefined;
  /** Calls the listener when the published message or its versions change. */
  subscribe(listener: () => void): () => void;
  /** Publishes the last saved user message and its versions; the listeners are called only when one of them changed. */
  publish(entryId: EntryId | null, versions: readonly OtherVersion[]): void;
}

const NO_VERSIONS: readonly OtherVersion[] = [];

export function createLastUserVersions(): LastUserVersions {
  let lastUser: EntryId | null = null;
  let versions = NO_VERSIONS;
  const listeners = new Set<() => void>();
  return {
    versionsFor: (entryId) => (lastUser === entryId ? versions : undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(nextLastUser, nextVersions) {
      if (nextLastUser === lastUser && nextVersions === versions) return;
      lastUser = nextLastUser;
      versions = nextVersions;
      for (const listener of [...listeners]) listener();
    },
  };
}

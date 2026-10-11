import type { ThreadId } from "@omp-app/contracts";
import { z } from "zod";

/**
 * The stream notices a person let go of (dismissed, or timed out), so that a replay of their stream does not bring
 * them back (see `NotificationBus.retire`). A notice is named by its chat and its dedupe key.
 */
export interface RetiredNotices {
  has(threadId: ThreadId, dedupeKey: string): boolean;
  remember(threadId: ThreadId, dedupeKey: string): void;
}

/** The most retired notices kept per chat. A replay holds at most one stream's window of events, so this bounds storage. */
export const MAX_RETIRED_PER_THREAD = 256;

/** The sessionStorage key of this tab's retired notices. */
export const RETIRED_NOTICES_STORAGE_KEY = "omp-app.retired-notices";

const StoredSchema = z.object({
  instanceId: z.string(),
  threads: z.record(z.string(), z.array(z.string())),
});
type Stored = z.infer<typeof StoredSchema>;

function readStored(storage: Pick<Storage, "getItem">, key: string): Stored | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(storage: Pick<Storage, "setItem">, key: string, stored: Stored): void {
  try {
    storage.setItem(key, JSON.stringify(stored));
  } catch {
    // Storage that is full or closed: the notices stay retired on this page, but not after a reload.
  }
}

/**
 * The retired notices of one tab, kept in its sessionStorage so a reload does not bring them back. They belong to one
 * server instance: a stream's sequence numbers restart when the server restarts, so an entry from another instance
 * names a different event and is not used. With no instance (not connected yet), nothing is retired.
 */
export function sessionRetiredNotices(
  storage: Pick<Storage, "getItem" | "setItem">,
  instanceId: () => string | undefined,
  key = RETIRED_NOTICES_STORAGE_KEY,
): RetiredNotices {
  let stored = readStored(storage, key);
  return {
    has(threadId, dedupeKey) {
      const current = instanceId();
      if (current === undefined || stored?.instanceId !== current) return false;
      return (stored.threads[threadId] ?? []).includes(dedupeKey);
    },
    remember(threadId, dedupeKey) {
      const current = instanceId();
      if (current === undefined) return;
      const threads: Stored["threads"] = stored?.instanceId === current ? stored.threads : {};
      const kept = (threads[threadId] ?? []).filter((item) => item !== dedupeKey);
      stored = {
        instanceId: current,
        threads: { ...threads, [threadId]: [...kept, dedupeKey].slice(-MAX_RETIRED_PER_THREAD) },
      };
      writeStored(storage, key, stored);
    },
  };
}

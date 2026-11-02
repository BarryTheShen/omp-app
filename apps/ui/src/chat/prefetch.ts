import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { AppClient } from "@omp-app/client";
import { type SessionFilePath, SessionFileStore, type ThreadId } from "@omp-app/contracts";
import { firstWindowBytes } from "./controller";
import { keepWindow } from "./windowCache";

/** A chat read ahead in the last half minute is not read again. */
const FRESH_MS = 30_000;
const readAt = new Map<ThreadId, number>();

/**
 * Reads a chat's newest window ahead (the pointer rests on it in the list) and keeps it, so opening the chat shows it at
 * once. Failures are of no consequence: opening reads the file anyway.
 */
export function prefetchWindow(
  client: AppClient,
  threadId: ThreadId,
  sessionFile: SessionFilePath,
): void {
  const now = Date.now();
  if ((readAt.get(threadId) ?? 0) > now - FRESH_MS) return;
  readAt.set(threadId, now);
  client
    .port(SessionFileStore)
    .readEntryWindow({ sessionFile, byteBudget: firstWindowBytes() })
    .then((window) =>
      keepWindow(threadId, {
        entries: window.entries as unknown as SessionEntry[],
        hasOlder: window.hasOlder,
      }),
    )
    .catch(() => readAt.delete(threadId));
}

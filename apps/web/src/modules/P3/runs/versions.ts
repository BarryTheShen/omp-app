import type { EntryId, SessionFilePath, ThreadId } from "@omp-app/contracts";

export interface SessionVersionCandidate {
  readonly id: ThreadId;
  readonly sessionFile: SessionFilePath;
  readonly parentSession: SessionFilePath | null;
  readonly title: string | null;
  readonly displayTitle: string | null;
  readonly firstPrompt: string | null;
  readonly createdAt: string;
}

export interface OtherVersion {
  readonly threadId: ThreadId;
  readonly title: string;
}

/**
 * Lists the original chat and sessions created from it, oldest first. omp's durable branch helper records the source
 * session file in `parentSession`; `/fork` writes an id-only marker and is not part of this file-based edit lineage.
 */
export function otherVersionsFor(
  sessions: readonly SessionVersionCandidate[],
  currentThreadId: ThreadId,
): readonly OtherVersion[] {
  const current = sessions.find((session) => session.id === currentThreadId);
  if (current === undefined) return [];
  const rootFile = current.parentSession ?? current.sessionFile;
  return sessions
    .filter(
      (session) =>
        session.id !== currentThreadId &&
        (session.sessionFile === rootFile || session.parentSession === rootFile),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((session) => ({
      threadId: session.id,
      title: session.displayTitle ?? session.firstPrompt ?? "Other chat",
    }));
}

export function lastSavedUserEntryId(
  rows: readonly { readonly role: string; readonly entryId: EntryId | null }[],
): EntryId | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role === "user" && row.entryId !== null) return row.entryId;
  }
  return null;
}

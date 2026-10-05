import type {
  EntryId,
  SessionFilePath,
  SessionLiveness,
  SessionStatus,
  SubagentTranscript,
  ThreadId,
  Timestamp,
} from "@omp-app/contracts";
import {
  Cursor as CursorSchema,
  SessionFile,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { z } from "zod";
import { SessionProvenance, SessionScope } from "./scope";

/** Native omp metadata plus the R1-only scope, provenance and pin presentation fields. */
export const SessionMetadata = SessionFile.extend({
  scope: SessionScope,
  provenance: SessionProvenance,
  pinned: z.boolean(),
});
export type SessionMetadata = z.infer<typeof SessionMetadata>;

export type { SessionLiveness, SessionStatus, SubagentTranscript };
/** Explicit native/import origin; foreign sessions enter the catalog only after an A1 import. */
export { SessionProvenance };

export const SessionCatalogPage = z.strictObject({
  sessions: z.array(SessionMetadata),
  nextCursor: CursorSchema.nullable(),
});
export type SessionCatalogPage = z.infer<typeof SessionCatalogPage>;

export const SessionCatalogSelection = z.strictObject({
  currentThreadId: ThreadIdSchema.nullable(),
  revision: z.int().nonnegative(),
});
export type SessionCatalogSelection = z.infer<typeof SessionCatalogSelection>;

export interface SelectionToken {
  readonly threadId: ThreadId | null;
  readonly revision: number;
}

/** A stale async open result may not replace a newer selection. */
export function isCurrentSelection(
  token: SelectionToken,
  selection: SessionCatalogSelection,
): boolean {
  return token.revision === selection.revision && token.threadId === selection.currentThreadId;
}

export interface SessionMetadataSummary {
  readonly id: ThreadId;
  readonly sessionFile: SessionFilePath;
  readonly title: string | null;
  readonly cwd: string;
  readonly updatedAt: Timestamp;
  readonly parentSession: SessionFilePath | null;
  readonly entryId?: EntryId;
}

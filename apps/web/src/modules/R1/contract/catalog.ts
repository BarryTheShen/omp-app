import type { AppError, Cursor, ThreadId } from "@omp-app/contracts";
import { z } from "zod";
import type { SessionCatalogPage, SessionMetadata } from "./metadata";
import type { SessionCatalogFilter, SessionCatalogPageArgs } from "./scope";

export interface SessionCatalogState {
  readonly filter: SessionCatalogFilter;
  readonly sessions: readonly SessionMetadata[];
  readonly nextCursor: Cursor | null;
  readonly selectedThreadId: ThreadId | null;
  readonly selectionRevision: number;
  readonly isLoading: boolean;
  readonly error: AppError | null;
}

export interface SessionCatalog {
  readonly getState: () => SessionCatalogState;
  readonly list: (args: SessionCatalogPageArgs) => Promise<SessionCatalogPage>;
  readonly fetch: (threadId: ThreadId) => Promise<SessionMetadata>;
  readonly subscribe: (listener: (state: SessionCatalogState) => void) => () => void;
}

export const SessionCatalogLoadState = z.enum(["idle", "loading", "ready", "error"]);
export type SessionCatalogLoadState = z.infer<typeof SessionCatalogLoadState>;

export interface SessionCatalogSnapshot extends SessionCatalogState {
  readonly loadState: SessionCatalogLoadState;
}

import type { AppError, Cursor, RunningSession, ThreadId } from "@omp-app/contracts";
import { z } from "zod";
import type { SessionCatalogPage, SessionMetadata } from "./metadata";
import type { SessionCatalogFilter, SessionCatalogPageArgs } from "./scope";

export interface SessionCatalogState {
  readonly filter: SessionCatalogFilter;
  readonly sessions: readonly SessionMetadata[];
  /** The chats running now that omp has not yet written a session file for. A search lists none. */
  readonly running: readonly RunningSession[];
  readonly nextCursor: Cursor | null;
  readonly selectedThreadId: ThreadId | null;
  readonly selectionRevision: number;
  /** True after a full list has succeeded, even when the folder has no sessions. */
  readonly isLoaded: boolean;
  readonly isLoading: boolean;
  /** True while `loadMore` fetches the next page; the list stays on screen meanwhile. */
  readonly isLoadingMore: boolean;
  readonly error: AppError | null;
  /** Why the last `loadMore` failed; the chats already shown are kept. Cleared by the next try. */
  readonly moreError: AppError | null;
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

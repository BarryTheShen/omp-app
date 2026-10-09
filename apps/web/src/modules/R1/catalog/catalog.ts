import type {
  Cursor,
  FolderPath,
  GitState,
  Revision,
  SessionFile,
  SessionFileChanged,
  SessionFilePath,
  SessionListResult,
  SessionPinListResult,
  SessionReadArgs,
  ThreadId,
  WorkspaceReadArgs,
  WorkspaceState,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type {
  SessionCatalogFilter,
  SessionCatalogPage,
  SessionCatalogPageArgs,
  SessionCatalogState,
  SessionMetadata,
  SessionScope,
} from "../contract";

export interface SessionFilesClient {
  listSessions(args: {
    readonly folder: FolderPath;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<SessionListResult>;
  readSession(args: SessionReadArgs): Promise<SessionFile>;
}

export interface GitStateClient {
  read(args: WorkspaceReadArgs): Promise<WorkspaceState>;
}

export interface SessionPinsClient {
  list(args?: Record<string, never>): Promise<SessionPinListResult>;
}

export interface CatalogModelOptions {
  readonly scope: SessionScope;
  readonly sessionFiles: SessionFilesClient;
  readonly gitState?: GitStateClient;
  readonly pins?: SessionPinsClient;
}

export interface CatalogSnapshot extends SessionCatalogState {
  readonly scope: SessionScope;
  readonly git: GitState | null;
  readonly pinsRevision: Revision | null;
}

function internalFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function unavailable(message: string, capability: `host.${string}`): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

function queryMatches(session: SessionMetadata, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  return [session.title ?? "", session.firstPrompt ?? "", session.id, session.cwd].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function compareSessions(left: SessionMetadata, right: SessionMetadata): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  return left.id.localeCompare(right.id);
}

function metadataFromFile(
  file: SessionFile,
  scope: SessionScope,
  pinned: ReadonlySet<ThreadId>,
): SessionMetadata {
  return {
    ...file,
    scope,
    provenance: "native",
    pinned: pinned.has(file.id),
  };
}

function sameSession(left: SessionMetadata, right: SessionMetadata): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameFilter(left: SessionCatalogFilter, right: SessionCatalogFilter): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A search looks through every chat it can load, up to this many... */
const MAX_SEARCHED = 1_000;
/** ...fetched in at most this many requests (the server gives at most 100 chats per request). */
const MAX_PAGES = 20;

interface FetchedSessions {
  readonly sessions: readonly SessionMetadata[];
  readonly nextCursor: Cursor | null;
}

function folderRoots(scope: SessionScope, git: GitState | null): readonly FolderPath[] {
  if (scope.kind === "folder") return [scope.folder];
  const roots = [scope.repositoryRoot, ...(git?.worktrees.map((worktree) => worktree.path) ?? [])];
  return [...new Set(roots)];
}

function changedInScope(scope: SessionScope, session: SessionMetadata): boolean {
  if (scope.kind === "folder") return session.cwd === scope.folder;
  return session.cwd === scope.repositoryRoot || session.cwd.startsWith(`${scope.repositoryRoot}/`);
}

/**
 * Browser catalog model over A1's typed read-only stores. It keeps metadata only (not transcript
 * messages or omp session files), preserves unchanged SessionMetadata references, and treats remove
 * events as tombstones so a stale in-flight update cannot resurrect a deleted row.
 */
export class SessionCatalogModel {
  private readonly options: CatalogModelOptions;
  private readonly listeners = new Set<(snapshot: CatalogSnapshot) => void>();
  private readonly tombstones = new Map<ThreadId, number>();
  private snapshot: CatalogSnapshot;
  private operation = 0;
  /** Bumped by `list` only: a page `loadMore` fetched before a newer `list` began is dropped. */
  private listGeneration = 0;
  private pins: ReadonlySet<ThreadId> = new Set();

  public constructor(options: CatalogModelOptions) {
    this.options = options;
    const filter: SessionCatalogFilter = { scope: options.scope, query: "" };
    this.snapshot = Object.freeze({
      filter,
      scope: options.scope,
      sessions: Object.freeze([]),
      nextCursor: null,
      selectedThreadId: null,
      selectionRevision: 0,
      isLoaded: false,
      isLoading: false,
      isLoadingMore: false,
      error: null,
      moreError: null,
      git: null,
      pinsRevision: null,
    });
  }

  public getSnapshot(): CatalogSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: CatalogSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async list(args: SessionCatalogPageArgs): Promise<SessionCatalogPage> {
    const operation = ++this.operation;
    const generation = ++this.listGeneration;
    // Removals that happened before this full load began are settled by it; later ones still hide
    // their chat from this load's pages (a removal also supersedes the load).
    if (args.cursor === undefined) this.clearTombstonesBefore(operation);
    const filter = args.filter;
    // A loaded catalog is refreshed in the background: the previous rows stay actionable until
    // the new page set arrives, and even a previously empty result does not flash placeholders.
    const wanted =
      args.cursor !== undefined
        ? 0
        : filter.query.trim().length > 0
          ? MAX_SEARCHED
          : sameFilter(filter, this.snapshot.filter)
            ? this.snapshot.sessions.length
            : 0;
    this.commit({
      filter,
      isLoading: !this.snapshot.isLoaded,
      isLoadingMore: false,
      error: null,
      moreError: null,
    });
    try {
      const git = await this.readGit(filter.scope);
      const pins = await this.readPins();
      const first = await this.fetchSessions(filter, git, pins, args);
      const byId = new Map(first.sessions.map((session) => [session.id, session]));
      let nextCursor = first.nextCursor;
      for (
        let pages = 1;
        nextCursor !== null &&
        byId.size < wanted &&
        pages < MAX_PAGES &&
        generation === this.listGeneration;
        pages += 1
      ) {
        const more = await this.fetchSessions(filter, git, pins, { ...args, cursor: nextCursor });
        for (const session of more.sessions) byId.set(session.id, session);
        nextCursor = more.nextCursor;
      }
      if (operation !== this.operation) return this.pageFromSnapshot();
      const sessions = [...byId.values()].sort(compareSessions);
      this.commit({
        filter,
        sessions,
        nextCursor,
        isLoaded: true,
        isLoading: false,
        error: null,
        git,
        pinsRevision: this.snapshot.pinsRevision,
      });
      return { sessions, nextCursor };
    } catch (error) {
      const failure = internalFailure(error, "Loading the session catalog failed");
      if (operation === this.operation) this.commit({ isLoading: false, error: failure.appError });
      throw failure;
    }
  }

  /**
   * Adds the next page after the chats already shown; the list stays on screen while it loads and
   * a failure is kept in `moreError`, never in `error`. A `list` that starts meanwhile has the newer
   * truth, so the page is dropped.
   */
  public async loadMore(limit = 50): Promise<void> {
    const cursor = this.snapshot.nextCursor;
    if (cursor === null || this.snapshot.isLoading || this.snapshot.isLoadingMore) return;
    const generation = this.listGeneration;
    this.commit({ isLoadingMore: true, moreError: null });
    try {
      const pins = await this.readPins();
      const fetched = await this.fetchSessions(this.snapshot.filter, this.snapshot.git, pins, {
        filter: this.snapshot.filter,
        cursor,
        limit,
      });
      if (generation !== this.listGeneration) return;
      const byId = new Map(this.snapshot.sessions.map((session) => [session.id, session]));
      // A chat already shown may have been refreshed by an event: its copy stays.
      for (const session of fetched.sessions)
        if (!byId.has(session.id)) byId.set(session.id, session);
      this.commit({
        sessions: [...byId.values()].sort(compareSessions),
        nextCursor: fetched.nextCursor,
        isLoadingMore: false,
      });
    } catch (error) {
      if (generation !== this.listGeneration) return;
      this.commit({
        isLoadingMore: false,
        moreError: internalFailure(error, "Loading older chats failed").appError,
      });
    }
  }

  public async fetch(threadId: ThreadId): Promise<SessionMetadata> {
    try {
      const file = await this.options.sessionFiles.readSession({
        sessionFile: this.requireSessionFile(threadId),
      });
      return metadataFromFile(file, this.snapshot.scope, this.pins);
    } catch (error) {
      throw internalFailure(error, "Reading session metadata failed");
    }
  }

  public select(threadId: ThreadId | null): void {
    this.commit({
      selectedThreadId: threadId,
      selectionRevision: this.snapshot.selectionRevision + 1,
    });
  }

  /** Reconcile one A1 changed event; stale updates after a remove are ignored. */
  public async reconcile(change: SessionFileChanged): Promise<void> {
    if (!this.eventInScope(change)) return;
    const operation = ++this.operation;
    if (change.kind === "removed") {
      this.rememberRemoval(change.id, operation);
      this.commit({
        sessions: this.snapshot.sessions.filter((session) => session.id !== change.id),
      });
      return;
    }
    if (this.tombstones.has(change.id)) return;
    try {
      const file = await this.options.sessionFiles.readSession({ sessionFile: change.sessionFile });
      if (operation !== this.operation || this.tombstones.has(change.id)) return;
      const metadata = metadataFromFile(file, this.snapshot.scope, this.pins);
      if (!changedInScope(this.snapshot.scope, metadata)) {
        this.commit({
          sessions: this.snapshot.sessions.filter((session) => session.id !== change.id),
        });
        return;
      }
      const index = this.snapshot.sessions.findIndex((session) => session.id === metadata.id);
      if (index < 0) {
        this.commit({ sessions: [...this.snapshot.sessions, metadata].sort(compareSessions) });
      } else {
        const current = this.snapshot.sessions[index];
        if (!current || sameSession(current, metadata)) return;
        const sessions = [...this.snapshot.sessions];
        sessions[index] = metadata;
        sessions.sort(compareSessions);
        this.commit({ sessions });
      }
    } catch (error) {
      this.commit({
        error: internalFailure(error, "Reconciling the session catalog failed").appError,
      });
    }
  }

  public async reconcilePin(
    sessionId: ThreadId,
    pinned: boolean,
    revision: Revision,
  ): Promise<void> {
    const pins = new Set(this.pins);
    if (pinned) pins.add(sessionId);
    else pins.delete(sessionId);
    this.pins = pins;
    const sessions = this.snapshot.sessions
      .map((session) => (session.id === sessionId ? { ...session, pinned } : session))
      .sort(compareSessions);
    this.commit({ sessions, pinsRevision: revision });
  }

  /**
   * Re-reads one listed chat's file, so its row shows the title saved in it now (after a rename). A
   * chat the list does not hold is left out, and a chat that was removed stays removed.
   */
  public async refresh(threadId: ThreadId): Promise<void> {
    const listed = this.snapshot.sessions.find((session) => session.id === threadId);
    if (!listed || this.tombstones.has(threadId)) return;
    try {
      const file = await this.options.sessionFiles.readSession({
        sessionFile: listed.sessionFile,
      });
      const current = this.snapshot.sessions.find((session) => session.id === threadId);
      if (!current || this.tombstones.has(threadId)) return;
      const metadata = metadataFromFile(file, this.snapshot.scope, this.pins);
      if (sameSession(current, metadata)) return;
      this.commit({
        sessions: this.snapshot.sessions
          .map((session) => (session.id === threadId ? metadata : session))
          .sort(compareSessions),
      });
    } catch (error) {
      this.commit({ error: internalFailure(error, "Reading the renamed chat failed").appError });
    }
  }

  /** One request per folder for the given page; nothing is committed. */
  private async fetchSessions(
    filter: SessionCatalogFilter,
    git: GitState | null,
    pins: ReadonlySet<ThreadId>,
    args: SessionCatalogPageArgs,
  ): Promise<FetchedSessions> {
    const pages = await Promise.all(
      folderRoots(filter.scope, git).map((folder) =>
        this.options.sessionFiles.listSessions({
          folder,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      ),
    );
    const sessions: SessionMetadata[] = [];
    for (const session of pages.flatMap((page) => page.sessions)) {
      if (this.tombstones.has(session.id)) continue;
      const metadata = metadataFromFile(session, filter.scope, pins);
      if (queryMatches(metadata, filter.query)) sessions.push(metadata);
    }
    return {
      sessions,
      nextCursor: pages.find((page) => page.nextCursor !== null)?.nextCursor ?? null,
    };
  }

  private async readGit(scope: SessionScope): Promise<GitState | null> {
    if (scope.kind === "folder") return this.snapshot.git;
    if (!this.options.gitState)
      throw unavailable("Project scope requires GitState", "host.git-state");
    const state = await this.options.gitState.read({ folder: scope.folder });
    return state.git;
  }

  private async readPins(): Promise<ReadonlySet<ThreadId>> {
    if (!this.options.pins) return this.pins;
    try {
      const result = await this.options.pins.list({});
      this.pins = new Set(result.pins.map((pin) => pin.sessionId));
      this.commit({ pinsRevision: result.revision });
    } catch (error) {
      const failure =
        error instanceof AppFailure ? error : internalFailure(error, "Loading session pins failed");
      if (failure.appError.code !== "unavailable") throw failure;
    }
    return this.pins;
  }

  private rememberRemoval(id: ThreadId, operation: number): void {
    this.tombstones.delete(id);
    this.tombstones.set(id, operation);
    while (this.tombstones.size > 1_000) {
      const oldest = this.tombstones.keys().next();
      if (oldest.done) break;
      this.tombstones.delete(oldest.value);
    }
  }

  private clearTombstonesBefore(operation: number): void {
    for (const [id, removalOperation] of this.tombstones) {
      if (removalOperation < operation) this.tombstones.delete(id);
    }
  }

  private eventInScope(change: SessionFileChanged): boolean {
    if (this.snapshot.scope.kind === "folder") return change.folder === this.snapshot.scope.folder;
    return (
      change.folder === this.snapshot.scope.repositoryRoot ||
      change.folder.startsWith(`${this.snapshot.scope.repositoryRoot}/`)
    );
  }

  private requireSessionFile(threadId: ThreadId): SessionFilePath {
    const session = this.snapshot.sessions.find((item) => item.id === threadId);
    if (!session)
      throw new AppFailure({
        code: "not_found",
        message: "Session is not in the catalog",
        retryable: false,
      });
    return session.sessionFile;
  }

  private pageFromSnapshot(): SessionCatalogPage {
    return { sessions: [...this.snapshot.sessions], nextCursor: this.snapshot.nextCursor };
  }

  private commit(patch: Partial<CatalogSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.sessions !== this.snapshot.sessions) next.sessions = Object.freeze([...next.sessions]);
    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

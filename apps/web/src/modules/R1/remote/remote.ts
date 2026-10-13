import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type {
  AppError,
  CapabilityKey,
  OpenThreadArgs,
  OpenThreadResult,
  SessionRenameArgs,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import type { SessionCatalogFilter, SessionCatalogPageArgs, SessionMetadata } from "../contract";
import { type CloseThread, releaseThread } from "../release";

type RemoteThreadListResponse = Awaited<ReturnType<RemoteThreadListAdapter["list"]>>;
type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;
type RemoteThreadInitializeResponse = Awaited<ReturnType<RemoteThreadListAdapter["initialize"]>>;

export interface RemoteThreadCatalogSource {
  getSnapshot(): { readonly filter: SessionCatalogFilter };
  list(
    args: SessionCatalogPageArgs,
  ): Promise<{ readonly sessions: readonly SessionMetadata[]; readonly nextCursor: string | null }>;
  fetch(threadId: ThreadId): Promise<SessionMetadata>;
  /** Re-reads one listed chat's file so its row shows what the file says now (after a rename). */
  refresh(threadId: ThreadId): Promise<void>;
}

export interface RemoteThreadListOptions {
  readonly catalog: RemoteThreadCatalogSource;
  readonly open: (args: OpenThreadArgs) => Promise<OpenThreadResult>;
  /**
   * Lets go of the hold `open` takes on a chat. The adapter's open only creates the chat or starts
   * its omp: the selected-chat controller opens it again to view it, and that one hold is what
   * keeps its process running. Without `close` the chat would be held twice and never released.
   */
  readonly close?: CloseThread;
  /** A0's typed rename: omp sets the chat's name, open or not (the `rename` port method). */
  readonly rename?: (args: SessionRenameArgs) => Promise<unknown>;
  /** A1.8's typed native `/delete` gateway; absent means the action is visibly unavailable. */
  readonly deleteThread?: (threadId: ThreadId) => Promise<void>;
  readonly onThreadIdChange?: (threadId: ThreadId | undefined) => void;
  /**
   * The chat the page has open and loaded, as the selected-chat controller holds it. A pick of that chat sends nothing
   * while the newest open has finished: the controller then keeps the chat as it is (issue 1359).
   */
  readonly loadedThreadId?: () => ThreadId | undefined;
  readonly generateTitle?: RemoteThreadListAdapter["generateTitle"];
}

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    } satisfies AppError,
    { cause: error },
  );
}

function unavailable(message: string, capability: CapabilityKey): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

function mapMetadata(metadata: SessionMetadata): RemoteThreadMetadata {
  return {
    status: "regular",
    remoteId: metadata.id,
    externalId: metadata.sessionFile,
    ...(metadata.title === null ? {} : { title: metadata.title }),
    lastMessageAt: new Date(metadata.updatedAt),
    custom: {
      cwd: metadata.cwd,
      pinned: metadata.pinned,
      provenance: metadata.provenance,
      status: metadata.status,
      liveness: metadata.liveness,
      parseWarnings: metadata.parseWarnings,
    },
  };
}

function isNewThreadId(threadId: string): boolean {
  return threadId === "new" || threadId.startsWith("new:") || threadId.startsWith("local:");
}

/**
 * Stable assistant-ui RemoteThreadListAdapter over R1.3 metadata. It never owns a transcript or
 * message store: selecting/initializing a thread only completes after the typed A0 open resolves.
 */
export class NativeRemoteThreadListAdapter implements RemoteThreadListAdapter {
  private readonly options: RemoteThreadListOptions;
  /** The open still in flight for each id, with its number (see `initialize`). */
  private readonly initializations = new Map<
    string,
    { readonly task: Promise<RemoteThreadInitializeResponse>; readonly request: number }
  >();
  private currentThreadId: ThreadId | undefined;
  /** Each open takes the next number when it is made, so the pick made last has the highest. */
  private requests = 0;
  /** The newest open that has finished, opened or failed. */
  private finishedRequest = 0;

  public constructor(options: RemoteThreadListOptions) {
    this.options = options;
  }

  public async list(params?: { readonly after?: string }): Promise<RemoteThreadListResponse> {
    try {
      const filter = this.options.catalog.getSnapshot().filter;
      const page = await this.options.catalog.list({
        filter,
        cursor: params?.after,
        limit: 100,
      });
      return {
        threads: page.sessions.map(mapMetadata),
        ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
      };
    } catch (error) {
      throw failure(error, "Listing remote threads failed");
    }
  }

  public async fetch(threadId: string): Promise<RemoteThreadMetadata> {
    try {
      return mapMetadata(await this.options.catalog.fetch(ThreadIdSchema.parse(threadId)));
    } catch (error) {
      throw failure(error, "Fetching remote thread metadata failed");
    }
  }

  /**
   * Initializes before the first append. Existing ids open by ThreadId; `new`/`new:*`/`local:*`
   * requests create through A0's folder-scoped `open({ start: "new" })`. A second call for an id whose open is still
   * in flight shares that open, but not once a later open has started: the newest pick is the one to open.
   * The chat already loaded returns with no request while the newest open has finished: picking it sends nothing to
   * omp (issue 1359).
   */
  public initialize(threadId: string): Promise<RemoteThreadInitializeResponse> {
    const loaded = this.options.loadedThreadId?.();
    if (loaded !== undefined && loaded === threadId && this.requests === this.finishedRequest) {
      this.currentThreadId = loaded;
      return Promise.resolve({ remoteId: loaded });
    }
    const existing = this.initializations.get(threadId);
    if (existing && existing.request === this.requests) return existing.task;
    const task = this.open(threadId);
    // `open` takes its number as its first step, so the counter holds the number of this open now.
    const entry = { task, request: this.requests };
    this.initializations.set(threadId, entry);
    const forget = (): void => {
      if (this.initializations.get(threadId) === entry) this.initializations.delete(threadId);
    };
    void task.then(forget, forget);
    return task;
  }

  /**
   * Renames a chat through the rename port: omp sets the name in the chat's file, open or not. Then
   * the list re-reads that file, so the row shows the title omp kept (it trims the title).
   */
  public async rename(remoteId: string, newTitle: string): Promise<void> {
    if (!this.options.rename) {
      throw unavailable("Rename requires omp's set_session_name RPC", "omp.cmd.set_session_name");
    }
    const threadId = this.parseThreadId(remoteId);
    try {
      await this.options.rename({ threadId, name: newTitle });
    } catch (error) {
      throw failure(error, "Renaming the remote thread failed");
    }
    await this.options.catalog.refresh(threadId);
  }

  public async archive(_remoteId: string): Promise<void> {
    throw unavailable("omp 18.6.1 has no native archive state", "upstream.session-archive");
  }

  public async unarchive(_remoteId: string): Promise<void> {
    throw unavailable("omp 18.6.1 has no native archive state", "upstream.session-archive");
  }

  public async delete(remoteId: string): Promise<void> {
    if (!this.options.deleteThread) {
      throw unavailable(
        "Deleting sessions requires A1.8's native command gateway",
        "host.command-gateway",
      );
    }
    try {
      await this.options.deleteThread(this.parseThreadId(remoteId));
    } catch (error) {
      throw failure(error, "Deleting the remote thread failed");
    }
  }

  public async generateTitle(
    remoteId: string,
    messages: Parameters<NonNullable<RemoteThreadListAdapter["generateTitle"]>>[1],
  ): Promise<Awaited<ReturnType<NonNullable<RemoteThreadListAdapter["generateTitle"]>>>> {
    if (!this.options.generateTitle) {
      throw unavailable(
        "Title generation requires an authoritative title writer",
        "host.session-files",
      );
    }
    return this.options.generateTitle(remoteId, messages);
  }

  public async switchToThread(threadId: ThreadId): Promise<void> {
    await this.openExisting(threadId);
  }

  public getCurrentThreadId(): ThreadId | undefined {
    return this.currentThreadId;
  }

  /**
   * Opens one pick. Picks can finish out of order: a new chat waits for omp to start, while a chat that is
   * already running opens at once. A pick that finishes after a later pick has already finished is let go and
   * never selected, because the person made the later pick last. A pick that fails counts as a later pick too.
   */
  private async open(threadId: string): Promise<RemoteThreadInitializeResponse> {
    const request = ++this.requests;
    try {
      let args: OpenThreadArgs;
      if (isNewThreadId(threadId)) {
        const filter = this.options.catalog.getSnapshot().filter;
        if (filter.scope.kind !== "folder") {
          throw new AppFailure({
            code: "invalid_args",
            message: "New sessions require a folder scope",
            retryable: false,
          });
        }
        args = { folderPath: filter.scope.folder, start: "new" };
      } else {
        args = { threadId: this.parseThreadId(threadId) };
      }
      const result = await this.options.open(args);
      const nextThreadId = ThreadIdSchema.parse(result.threadId);
      if (request < this.finishedRequest) {
        if (this.options.close) void releaseThread(this.options.close, nextThreadId);
        throw new AppFailure({
          code: "cancelled",
          message: "A chat picked after this one opened first, so this one was not opened.",
          retryable: false,
        });
      }
      this.finishedRequest = request;
      this.currentThreadId = nextThreadId;
      if (this.options.close) void releaseThread(this.options.close, nextThreadId);
      this.options.onThreadIdChange?.(nextThreadId);
      return {
        remoteId: nextThreadId,
        ...(result.sessionFile ? { externalId: result.sessionFile } : {}),
      };
    } catch (error) {
      this.finishedRequest = Math.max(this.finishedRequest, request);
      throw failure(error, "Opening the remote thread failed");
    }
  }

  private async openExisting(threadId: ThreadId): Promise<void> {
    await this.open(threadId);
  }

  private parseThreadId(value: string): ThreadId {
    try {
      return ThreadIdSchema.parse(value);
    } catch (error) {
      throw failure(error, "The remote thread id is invalid");
    }
  }
}

export function createNativeRemoteThreadListAdapter(
  options: RemoteThreadListOptions,
): NativeRemoteThreadListAdapter {
  return new NativeRemoteThreadListAdapter(options);
}

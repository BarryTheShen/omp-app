import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type {
  AppError,
  CapabilityKey,
  OpenThreadArgs,
  OpenThreadResult,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import type { SessionCatalogFilter, SessionCatalogPageArgs, SessionMetadata } from "../contract";

type RemoteThreadListResponse = Awaited<ReturnType<RemoteThreadListAdapter["list"]>>;
type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;
type RemoteThreadInitializeResponse = Awaited<ReturnType<RemoteThreadListAdapter["initialize"]>>;

export interface RemoteThreadCatalogSource {
  getSnapshot(): { readonly filter: SessionCatalogFilter };
  list(
    args: SessionCatalogPageArgs,
  ): Promise<{ readonly sessions: readonly SessionMetadata[]; readonly nextCursor: string | null }>;
  fetch(threadId: ThreadId): Promise<SessionMetadata>;
}

export interface RemoteThreadListOptions {
  readonly catalog: RemoteThreadCatalogSource;
  readonly open: (args: OpenThreadArgs) => Promise<OpenThreadResult>;
  readonly send?: RpcSessionSend;
  /** A1.8's typed native `/delete` gateway; absent means the action is visibly unavailable. */
  readonly deleteThread?: (threadId: ThreadId) => Promise<void>;
  readonly onThreadIdChange?: (threadId: ThreadId | undefined) => void;
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
  private readonly initializations = new Map<string, Promise<RemoteThreadInitializeResponse>>();
  private currentThreadId: ThreadId | undefined;

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
   * requests create through A0's folder-scoped `open({ start: "new" })`.
   */
  public initialize(threadId: string): Promise<RemoteThreadInitializeResponse> {
    const existing = this.initializations.get(threadId);
    if (existing) return existing;
    const task = this.open(threadId);
    this.initializations.set(threadId, task);
    void task.then(
      () => this.initializations.delete(threadId),
      () => this.initializations.delete(threadId),
    );
    return task;
  }

  public async rename(remoteId: string, newTitle: string): Promise<void> {
    if (!this.options.send) {
      throw unavailable("Rename requires omp's set_session_name RPC", "host.session-files");
    }
    const threadId = this.parseThreadId(remoteId);
    try {
      await this.options.send({
        threadId,
        command: { type: "set_session_name", name: newTitle },
      });
    } catch (error) {
      throw failure(error, "Renaming the remote thread failed");
    }
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

  private async open(threadId: string): Promise<RemoteThreadInitializeResponse> {
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
    try {
      const result = await this.options.open(args);
      const nextThreadId = ThreadIdSchema.parse(result.threadId);
      this.currentThreadId = nextThreadId;
      this.options.onThreadIdChange?.(nextThreadId);
      return {
        remoteId: nextThreadId,
        ...(result.sessionFile ? { externalId: result.sessionFile } : {}),
      };
    } catch (error) {
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

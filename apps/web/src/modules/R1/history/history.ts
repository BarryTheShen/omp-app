import type { AppClient } from "@omp-app/client";
import type {
  AppError,
  FolderPath,
  OpenThreadArgs,
  RpcSessionClient,
  RpcSessionEvent,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, RpcSessionPort as RpcSessionPortSchema } from "@omp-app/contracts";
import { SessionHistoryLoader } from "@/modules/R0/history/history";
import { OmpRuntimeStore } from "@/modules/R0/store/store";

interface EventSubscription {
  readonly stream: string;
  readonly lastSeq: number;
  onEvent(listener: (payload: RpcSessionEvent, seq: number) => void): () => void;
  unsubscribe(): Promise<void>;
}

export interface SelectedThreadHistoryState {
  readonly threadId: ThreadId | undefined;
  readonly store: OmpRuntimeStore | undefined;
  readonly isLoading: boolean;
  readonly error: AppError | null;
}

export interface SelectedThreadHistoryOptions {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly onThreadIdChange?: (threadId: ThreadId | undefined) => void;
  readonly createStore?: (threadId: ThreadId, session: RpcSessionClient) => OmpRuntimeStore;
  readonly createLoader?: (
    threadId: ThreadId,
    session: RpcSessionClient,
    store: OmpRuntimeStore,
  ) => SessionHistoryLoader;
  /** Older entry pages are delegated to R0/R1 history; no whole-file browser fallback is invented. */
  readonly loadOlder?: (threadId: ThreadId, store: OmpRuntimeStore) => Promise<void>;
}

function asFailure(error: unknown, fallback: string): AppFailure {
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

function unavailable(message: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message,
    retryable: false,
    capability: "host.session-files",
  });
}

/**
 * Owns only selected-thread lifecycle. A0 owns the socket and event resume; R0 owns event/store
 * reduction and history loading. Switching always disposes the old subscription before publishing
 * the new store, and an in-process session_info_update re-keys through the same path without an
 * extra prompt or a second transcript store.
 */
export class SelectedThreadHistoryController {
  private readonly options: SelectedThreadHistoryOptions;
  private readonly client: AppClient;
  private readonly rpc: RpcSessionClient;
  private state: SelectedThreadHistoryState = Object.freeze({
    threadId: undefined,
    store: undefined,
    isLoading: false,
    error: null,
  });
  private subscription: EventSubscription | undefined;
  private offEvents: (() => void) | undefined;
  private loader: SessionHistoryLoader | undefined;
  private stopRefetchWatch: (() => void) | undefined;
  private listeners = new Set<(state: SelectedThreadHistoryState) => void>();
  private rekeying: Promise<void> | undefined;

  public constructor(options: SelectedThreadHistoryOptions) {
    this.options = options;
    this.client = options.client;
    this.rpc = this.client.port(RpcSessionPortSchema);
  }

  public getSnapshot(): SelectedThreadHistoryState {
    return this.state;
  }

  public subscribe(listener: (state: SelectedThreadHistoryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async openExisting(threadId: ThreadId): Promise<OmpRuntimeStore> {
    return this.open({ threadId });
  }

  public async openNew(): Promise<OmpRuntimeStore> {
    return this.open({ folderPath: this.options.folder, start: "new" });
  }

  public async openLatest(): Promise<OmpRuntimeStore> {
    return this.open({ folderPath: this.options.folder, start: "latest" });
  }

  /** Re-subscribes without replay duplication; A0's afterSeq is the authoritative resume cursor. */
  public async resume(afterSeq?: number): Promise<void> {
    const threadId = this.state.threadId;
    const store = this.state.store;
    if (!threadId || !store) throw unavailable("No selected thread is open");
    store.resetSequence(afterSeq ?? this.subscription?.lastSeq ?? store.getSnapshot().lastSeq);
    await this.attachSubscription(threadId, store, afterSeq);
  }

  /** Loads older history through R0/R1's injected paging seam, never by reading session files here. */
  public async loadOlder(): Promise<void> {
    const threadId = this.state.threadId;
    const store = this.state.store;
    if (!threadId || !store) throw unavailable("No selected thread is open");
    if (!this.options.loadOlder)
      throw unavailable("Older history paging is unavailable for this thread");
    try {
      await this.options.loadOlder(threadId, store);
    } catch (error) {
      throw asFailure(error, "Loading older session history failed");
    }
  }

  public async close(): Promise<void> {
    this.loader?.dispose();
    this.stopRefetchWatch?.();
    this.loader = undefined;
    this.stopRefetchWatch = undefined;
    this.offEvents?.();
    this.offEvents = undefined;
    const subscription = this.subscription;
    this.subscription = undefined;
    if (subscription) await subscription.unsubscribe();
    this.commit({ threadId: undefined, store: undefined, isLoading: false, error: null });
  }

  private async open(args: OpenThreadArgs): Promise<OmpRuntimeStore> {
    await this.close();
    this.commit({ isLoading: true, error: null });
    try {
      const result = await this.rpc.open(args);
      const threadId = result.threadId;
      const store = this.options.createStore?.(threadId, this.rpc) ?? this.defaultStore(threadId);
      const loader =
        this.options.createLoader?.(threadId, this.rpc, store) ??
        this.defaultLoader(threadId, store);
      this.loader = loader;
      this.commit({ threadId, store, isLoading: true, error: null });
      await this.attachSubscription(threadId, store);
      await loader.loadInitial();
      this.stopRefetchWatch = loader.watchNeedsRefetch();
      this.commit({ threadId, store, isLoading: false, error: null });
      this.options.onThreadIdChange?.(threadId);
      return store;
    } catch (error) {
      const failure = asFailure(error, "Opening the selected thread failed");
      await this.close();
      this.commit({ isLoading: false, error: failure.appError });
      throw failure;
    }
  }

  private defaultStore(threadId: ThreadId): OmpRuntimeStore {
    const transport = {
      send: this.rpc.send,
      answerExtensionUi: this.rpc.answerExtensionUi,
      answerHostTool: this.rpc.answerHostTool,
      answerHostUri: this.rpc.answerHostUri,
    };
    return new OmpRuntimeStore({ threadId, transport });
  }

  private defaultLoader(threadId: ThreadId, store: OmpRuntimeStore): SessionHistoryLoader {
    return new SessionHistoryLoader({ threadId, send: this.rpc.send, store });
  }

  private async attachSubscription(
    threadId: ThreadId,
    store: OmpRuntimeStore,
    afterSeq?: number,
  ): Promise<void> {
    this.offEvents?.();
    this.offEvents = undefined;
    const previous = this.subscription;
    this.subscription = undefined;
    if (previous) await previous.unsubscribe();
    const subscription = (await this.client.subscribe(RpcSessionPortSchema, "event", {
      scope: threadId,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    })) as EventSubscription;
    this.subscription = subscription;
    this.offEvents = subscription.onEvent((payload, seq) => {
      store.ingest(payload, seq);
      const nextThreadId = this.sessionIdFromEvent(payload);
      if (nextThreadId && nextThreadId !== this.state.threadId) {
        void this.rekeyInProcess(nextThreadId);
      }
    });
  }

  private sessionIdFromEvent(event: RpcSessionEvent): ThreadId | undefined {
    if (event.kind !== "notification") return undefined;
    const frame = event.frame;
    if (frame.type !== "session_info_update") return undefined;
    return frame.sessionId as ThreadId;
  }

  private async rekeyInProcess(threadId: ThreadId): Promise<void> {
    if (this.rekeying) return this.rekeying;
    this.rekeying = this.rekey(threadId).finally(() => {
      this.rekeying = undefined;
    });
    return this.rekeying;
  }

  private async rekey(threadId: ThreadId): Promise<void> {
    this.loader?.dispose();
    this.stopRefetchWatch?.();
    this.loader = undefined;
    this.stopRefetchWatch = undefined;
    const store = this.options.createStore?.(threadId, this.rpc) ?? this.defaultStore(threadId);
    const loader =
      this.options.createLoader?.(threadId, this.rpc, store) ?? this.defaultLoader(threadId, store);
    this.loader = loader;
    this.commit({ threadId, store, isLoading: true, error: null });
    await this.attachSubscription(threadId, store);
    await loader.loadInitial();
    this.stopRefetchWatch = loader.watchNeedsRefetch();
    this.commit({ threadId, store, isLoading: false, error: null });
    this.options.onThreadIdChange?.(threadId);
  }

  private commit(patch: Partial<SelectedThreadHistoryState>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener(this.state);
  }
}

export function createSelectedThreadHistoryController(
  options: SelectedThreadHistoryOptions,
): SelectedThreadHistoryController {
  return new SelectedThreadHistoryController(options);
}

import type {
  SessionInfoMetadata,
  SessionInfoMetadataSource,
  SessionInfoRuntimeSnapshot,
  SessionInfoRuntimeSource,
  SessionInfoSnapshot,
  SessionInfoSource,
} from "../contract";

export interface SessionInfoModelOptions {
  readonly runtime: SessionInfoRuntimeSource;
  readonly metadata: SessionInfoMetadataSource;
}

type SessionInfoListener = (snapshot: SessionInfoSnapshot) => void;

/**
 * Projects R0's live session state and R1's selected metadata without creating another reducer.
 * `session` is kept by reference, so model/thinking/context/compaction updates remain sourced from
 * R0's `snapshot.session` after each `get_state` refresh.
 */
export class SessionInfoModel implements SessionInfoSource {
  private readonly runtime: SessionInfoRuntimeSource;
  private readonly metadata: SessionInfoMetadataSource;
  private readonly listeners = new Set<SessionInfoListener>();
  private readonly stopRuntime: () => void;
  private readonly stopMetadata: () => void;
  private lastRuntime: SessionInfoRuntimeSnapshot | undefined;
  private lastMetadata: SessionInfoMetadata | null | undefined;
  private snapshot: SessionInfoSnapshot | undefined;
  private disposed = false;

  public constructor(options: SessionInfoModelOptions) {
    this.runtime = options.runtime;
    this.metadata = options.metadata;
    this.stopRuntime = this.runtime.subscribe(() => this.changed());
    this.stopMetadata = this.metadata.subscribe(() => this.changed());
  }

  public getSnapshot(): SessionInfoSnapshot {
    if (this.disposed) {
      throw new Error("SessionInfoModel has been disposed");
    }
    const runtime = this.runtime.getSnapshot();
    const metadata = this.metadata.getSnapshot();
    if (this.snapshot && this.lastRuntime === runtime && this.lastMetadata === metadata) {
      return this.snapshot;
    }

    const currentMetadata = metadata?.id === runtime.threadId ? metadata : null;
    this.lastRuntime = runtime;
    this.lastMetadata = metadata;
    this.snapshot = {
      id: runtime.threadId,
      // R0's get_state name is authoritative once present; catalog title is the initial fallback.
      title: runtime.session.sessionName ?? currentMetadata?.title ?? null,
      cwd: currentMetadata?.cwd ?? null,
      sessionFile: currentMetadata?.sessionFile ?? null,
      session: runtime.session,
    };
    return this.snapshot;
  }

  public subscribe(listener: SessionInfoListener): () => void {
    if (this.disposed) {
      throw new Error("SessionInfoModel has been disposed");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRuntime();
    this.stopMetadata();
    this.listeners.clear();
    this.snapshot = undefined;
    this.lastRuntime = undefined;
    this.lastMetadata = undefined;
  }

  private changed(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

import type {
  EntryId,
  OmpWire,
  PortCallOptions,
  RpcSessionSend,
  SessionEntryHead,
  ThreadId,
} from "@omp-app/contracts";
import {
  AppFailure,
  EntryId as EntryIdSchema,
  SessionEntryHead as SessionEntryHeadSchema,
} from "@omp-app/contracts";
import { z } from "zod";
import type { EntryCursor, SessionTreePort, TreeNode, TreeSnapshot } from "../contract";
import { ReadOnlyTreeLabelSchema } from "../contract";

/** The port seam used by the cursor; A0/R0 remain the only owners of transport and stores. */
export interface OmpSessionTreePortOptions {
  readonly send: RpcSessionSend;
  readonly sessionFile?: TreeSnapshot["sessionFile"];
  readonly labelsCapability?: TreeSnapshot["labelsCapability"];
}

const EMPTY_ENTRIES: readonly SessionEntryHead[] = Object.freeze([]);
const DEFAULT_PAGE_SIZE = 50;
const RawTreeNodeSchema = z.record(z.string(), z.unknown());

function asAppFailure(error: unknown, fallback: string): AppFailure {
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

function normalizeEntry(value: unknown): SessionEntryHead {
  try {
    return SessionEntryHeadSchema.parse(value);
  } catch (error) {
    throw asAppFailure(error, "The omp history entry was malformed");
  }
}

interface PendingTreeNode {
  readonly value: unknown;
  readonly destination: TreeNode[];
  readonly index: number;
}

interface NormalizedTree {
  readonly tree: readonly TreeNode[];
  readonly labels: readonly NonNullable<TreeNode["label"]>[];
}

function normalizeTreeLabel(value: unknown, targetId: EntryId): TreeNode["label"] {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return {
      targetId,
      text: value,
      editable: false,
      disabledReason: "Labels can't be changed here.",
    };
  }
  try {
    return ReadOnlyTreeLabelSchema.parse(value);
  } catch (error) {
    throw asAppFailure(error, "The omp tree label was malformed");
  }
}

function normalizeTreeNodes(values: readonly unknown[]): NormalizedTree {
  const roots = new Array<TreeNode>(values.length);
  const labels: NonNullable<TreeNode["label"]>[] = [];
  const pending: PendingTreeNode[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    pending.push({ value: values[index], destination: roots, index });
  }

  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    const rawNode = RawTreeNodeSchema.safeParse(item.value);
    if (!rawNode.success) {
      throw new AppFailure({
        code: "invalid_args",
        message: "The omp tree node was malformed",
        retryable: false,
      });
    }

    const value = rawNode.data;
    const entry = normalizeEntry(value.entry);
    const rawChildren = Array.isArray(value.children) ? value.children : [];
    const children = new Array<TreeNode>(rawChildren.length);
    const label = normalizeTreeLabel(value.label, entry.id);
    if (label !== undefined) labels.push(label);
    const node = {
      entry,
      children,
      ...(label === undefined ? {} : { label }),
      raw: value,
    } satisfies TreeNode;
    item.destination[item.index] = node;

    for (let index = rawChildren.length - 1; index >= 0; index -= 1) {
      pending.push({ value: rawChildren[index], destination: children, index });
    }
  }
  return { tree: roots, labels };
}

function entryId(value: string | null): EntryCursor["leafId"] {
  return value === null ? null : EntryIdSchema.parse(value);
}

function lastEntry(entries: readonly SessionEntryHead[]): EntryCursor["nextSince"] {
  return entries.at(-1)?.id;
}

function cursorFromResult(threadId: ThreadId, result: OmpWire.SessionEntries): EntryCursor {
  const entries = result.entries.map(normalizeEntry);
  return {
    threadId,
    entries,
    leafId: entryId(result.leafId),
    ...(lastEntry(entries) === undefined ? {} : { nextSince: lastEntry(entries) }),
  };
}

/** Typed browser adapter over omp's get_entries/get_tree commands. */
export class OmpSessionTreePort implements SessionTreePort {
  private readonly send: RpcSessionSend;
  private readonly sessionFile: TreeSnapshot["sessionFile"];
  private readonly labelsCapability: TreeSnapshot["labelsCapability"];
  private readonly listeners = new Map<ThreadId, Set<(snapshot: TreeSnapshot) => void>>();

  public constructor(options: OmpSessionTreePortOptions) {
    this.send = options.send;
    this.sessionFile = options.sessionFile ?? null;
    this.labelsCapability = options.labelsCapability ?? "unavailable";
  }

  public async load(threadId: ThreadId, signal?: AbortSignal): Promise<EntryCursor> {
    try {
      const result = (await this.send(
        { threadId, command: { type: "get_entries" } },
        this.callOptions(signal),
      )) as OmpWire.SessionEntries;
      return cursorFromResult(threadId, result);
    } catch (error) {
      throw asAppFailure(error, "Loading omp session history failed");
    }
  }

  public async loadAfter(
    threadId: ThreadId,
    since: EntryId,
    signal?: AbortSignal,
  ): Promise<EntryCursor> {
    try {
      const result = (await this.send(
        { threadId, command: { type: "get_entries", since } },
        this.callOptions(signal),
      )) as OmpWire.SessionEntries;
      return cursorFromResult(threadId, result);
    } catch (error) {
      throw asAppFailure(error, "Loading newer omp session history failed");
    }
  }

  public async readTree(threadId: ThreadId, signal?: AbortSignal): Promise<TreeSnapshot> {
    try {
      const result = (await this.send(
        { threadId, command: { type: "get_tree" } },
        this.callOptions(signal),
      )) as OmpWire.SessionTree;
      const { tree, labels } = normalizeTreeNodes(result.tree);
      const snapshot: TreeSnapshot = {
        threadId,
        sessionFile: this.sessionFile,
        tree,
        leafId: entryId(result.leafId),
        labels,
        labelsCapability: this.labelsCapability,
      };
      this.emit(snapshot);
      return snapshot;
    } catch (error) {
      throw asAppFailure(error, "Loading the omp session tree failed");
    }
  }

  public subscribe(threadId: ThreadId, listener: (snapshot: TreeSnapshot) => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  private callOptions(signal?: AbortSignal): PortCallOptions | undefined {
    return signal === undefined ? undefined : { signal };
  }

  private emit(snapshot: TreeSnapshot): void {
    for (const listener of this.listeners.get(snapshot.threadId) ?? []) listener(snapshot);
  }
}

export interface IncrementalHistorySnapshot {
  readonly threadId: ThreadId | undefined;
  readonly entries: readonly SessionEntryHead[];
  readonly tree: TreeSnapshot | null;
  readonly leafId: EntryCursor["leafId"];
  readonly hasOlder: boolean;
  readonly isLoading: boolean;
  readonly error: AppFailure | null;
}

export interface IncrementalHistoryCursorOptions {
  readonly port: SessionTreePort;
  readonly pageSize?: number;
}

/**
 * Keeps a canonical entry set while exposing newest-first local pages. omp's get_entries is an
 * append-history read (not an older-page endpoint), so older pages are sliced from the canonical
 * read and never re-requested or duplicated. A generation gate makes a branch/session switch
 * unable to publish an older request's result.
 */
export class IncrementalHistoryCursor {
  private readonly port: SessionTreePort;
  private readonly pageSize: number;
  private readonly listeners = new Set<(snapshot: IncrementalHistorySnapshot) => void>();
  private snapshot: IncrementalHistorySnapshot = Object.freeze({
    threadId: undefined,
    entries: EMPTY_ENTRIES,
    tree: null,
    leafId: null,
    hasOlder: false,
    isLoading: false,
    error: null,
  });
  private allEntries: readonly SessionEntryHead[] = EMPTY_ENTRIES;
  private visibleStart = 0;
  private generation = 0;

  public constructor(options: IncrementalHistoryCursorOptions) {
    if (
      !Number.isSafeInteger(options.pageSize ?? DEFAULT_PAGE_SIZE) ||
      (options.pageSize ?? 0) < 1
    ) {
      throw new RangeError("History page size must be a positive safe integer");
    }
    this.port = options.port;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  public getSnapshot(): IncrementalHistorySnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: IncrementalHistorySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async loadNewest(
    threadId: ThreadId,
    signal?: AbortSignal,
  ): Promise<IncrementalHistorySnapshot> {
    const generation = ++this.generation;
    this.commit({ isLoading: true, error: null, threadId });
    try {
      const [cursor, tree] = await Promise.all([
        this.port.load(threadId, signal),
        this.port.readTree(threadId, signal),
      ]);
      if (generation !== this.generation) return this.snapshot;
      this.allEntries = deduplicateEntries(cursor.entries);
      this.visibleStart = Math.max(0, this.allEntries.length - this.pageSize);
      this.commit({
        threadId,
        entries: this.allEntries.slice(this.visibleStart),
        tree,
        leafId: tree.leafId ?? cursor.leafId,
        hasOlder: this.visibleStart > 0,
        isLoading: false,
        error: null,
      });
      return this.snapshot;
    } catch (error) {
      if (generation !== this.generation) return this.snapshot;
      const failure = asAppFailure(error, "Loading incremental omp history failed");
      this.commit({ isLoading: false, error: failure });
      throw failure;
    }
  }

  public async loadOlder(): Promise<EntryCursor | null> {
    if (this.snapshot.threadId === undefined || this.visibleStart === 0) return null;
    const end = this.visibleStart;
    const start = Math.max(0, end - this.pageSize);
    const entries = this.allEntries.slice(start, end);
    this.visibleStart = start;
    this.commit({ entries: this.allEntries.slice(start), hasOlder: start > 0 });
    return {
      threadId: this.snapshot.threadId,
      entries,
      leafId: this.snapshot.leafId,
      ...(lastEntry(entries) === undefined ? {} : { nextSince: lastEntry(entries) }),
    };
  }

  public async loadNewer(
    threadId: ThreadId,
    signal?: AbortSignal,
  ): Promise<IncrementalHistorySnapshot> {
    if (this.snapshot.threadId !== threadId || this.allEntries.length === 0) {
      return this.loadNewest(threadId, signal);
    }
    const since = this.allEntries.at(-1)?.id;
    if (since === undefined) return this.loadNewest(threadId, signal);
    const generation = ++this.generation;
    try {
      const [cursor, tree] = await Promise.all([
        this.port.loadAfter(threadId, since, signal),
        this.port.readTree(threadId, signal),
      ]);
      if (generation !== this.generation) return this.snapshot;
      this.allEntries = deduplicateEntries([...this.allEntries, ...cursor.entries]);
      this.visibleStart = Math.max(0, this.allEntries.length - this.pageSize);
      this.commit({
        entries: this.allEntries.slice(this.visibleStart),
        tree,
        leafId: tree.leafId ?? cursor.leafId,
        hasOlder: this.visibleStart > 0,
        error: null,
      });
      return this.snapshot;
    } catch (error) {
      if (isUnknownSinceFailure(error)) return this.loadNewest(threadId, signal);
      const failure = asAppFailure(error, "Loading newer omp history failed");
      this.commit({ error: failure });
      throw failure;
    }
  }

  public reset(): void {
    this.generation += 1;
    this.allEntries = EMPTY_ENTRIES;
    this.visibleStart = 0;
    this.commit({
      threadId: undefined,
      entries: EMPTY_ENTRIES,
      tree: null,
      leafId: null,
      hasOlder: false,
      isLoading: false,
      error: null,
    });
  }

  private commit(patch: Partial<IncrementalHistorySnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export interface SelectedThreadHistoryStore {
  getSnapshot(): {
    readonly threadId: ThreadId;
    readonly processGeneration: number;
    readonly needsRefetch: boolean;
  };
}

export interface SelectedThreadHistoryState {
  readonly threadId: ThreadId | undefined;
  readonly store: SelectedThreadHistoryStore | undefined;
}

export interface SelectedThreadHistorySource {
  getSnapshot(): SelectedThreadHistoryState;
  subscribe(listener: () => void): () => void;
}

/** Reconciles the cursor with R1.5's selected-thread/store lifecycle without replay duplication. */
export class SelectedThreadHistoryReconciler {
  private readonly source: SelectedThreadHistorySource;
  private readonly cursor: IncrementalHistoryCursor;
  private readonly onError: ((error: AppFailure) => void) | undefined;
  private stopListening: (() => void) | undefined;
  private pending: Promise<void> | undefined;
  private lastThreadId: ThreadId | undefined;
  private lastStore: SelectedThreadHistoryStore | undefined;
  private lastGeneration: number | undefined;
  private lastNeedsRefetch = false;

  public constructor(options: {
    readonly source: SelectedThreadHistorySource;
    readonly cursor: IncrementalHistoryCursor;
    readonly onError?: (error: AppFailure) => void;
  }) {
    this.source = options.source;
    this.cursor = options.cursor;
    this.onError = options.onError;
    this.lastStore = undefined;
  }

  public start(): () => void {
    if (this.stopListening !== undefined) return this.stopListening;
    const listener = () => {
      void this.reconcile();
    };
    this.stopListening = this.source.subscribe(listener);
    void this.reconcile();
    return () => this.stop();
  }

  public stop(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    this.cursor.reset();
  }

  public async reconcile(): Promise<void> {
    if (this.pending !== undefined) return this.pending;
    this.pending = this.reconcileNow().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async reconcileNow(): Promise<void> {
    const state = this.source.getSnapshot();
    const store = state.store;
    if (state.threadId === undefined || store === undefined) {
      if (this.lastThreadId !== undefined) this.cursor.reset();
      this.lastThreadId = state.threadId;
      this.lastStore = store;
      return;
    }
    const storeSnapshot = store.getSnapshot();
    const switched = state.threadId !== this.lastThreadId || store !== this.lastStore;
    const generationChanged = storeSnapshot.processGeneration !== this.lastGeneration;
    const refetchStarted = storeSnapshot.needsRefetch && !this.lastNeedsRefetch;
    this.lastThreadId = state.threadId;
    this.lastStore = store;
    this.lastGeneration = storeSnapshot.processGeneration;
    this.lastNeedsRefetch = storeSnapshot.needsRefetch;
    if (!switched && !generationChanged && !refetchStarted) return;
    try {
      await this.cursor.loadNewest(state.threadId);
    } catch (error) {
      this.onError?.(asAppFailure(error, "Reconciling selected-thread history failed"));
    }
  }
}

function deduplicateEntries(entries: readonly SessionEntryHead[]): readonly SessionEntryHead[] {
  const byId = new Map<SessionEntryHead["id"], SessionEntryHead>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

function isUnknownSinceFailure(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.omp?.code === "unknown_since";
}

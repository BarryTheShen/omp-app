import type {
  AppError,
  CapabilityMap,
  CheckpointListResult,
  CheckpointSnapshotArgs,
  ConversationHead,
  FolderPath,
  PortCallOptions,
  PortClient,
  SnapshotGuarantee,
  SnapshotId,
  SnapshotRecord,
} from "@omp-app/contracts";
import {
  AppFailure,
  CheckpointListResult as CheckpointListResultSchema,
  type CheckpointStore,
  ConversationHead as ConversationHeadSchema,
  SnapshotRecord as SnapshotRecordSchema,
} from "@omp-app/contracts";
import type { PendingRequestsState, RuntimeSnapshot, ToolCallState } from "../../R0/store";
import { canClaimExact, WORKSPACE_EXACT_CAPABILITY } from "../contract";

/** The A1.7 browser proxy used by the coordinator. Filesystem work stays server-owned. */
export type CheckpointStorePort = PortClient<typeof CheckpointStore>;

/** R0.1's state fields that establish whether the workspace is at a safe turn boundary. */
export type QuietPointRuntimeSnapshot = Pick<
  RuntimeSnapshot,
  "prompt" | "queue" | "tools" | "pending" | "process" | "session" | "needsRefetch"
>;

export interface QuietPointRuntime {
  readonly getSnapshot: () => QuietPointRuntimeSnapshot;
  readonly subscribe: (listener: (snapshot: QuietPointRuntimeSnapshot) => void) => () => void;
}

export type QuietPointReason =
  | "session-not-settled"
  | "turn-streaming"
  | "tracked-tool-running"
  | "queued-steering"
  | "queued-follow-up"
  | "pending-extension-ui"
  | "pending-host-tool"
  | "pending-host-uri"
  | "compacting"
  | "state-out-of-date"
  | "process-unavailable";

export interface QuietPointCheck {
  readonly quiet: boolean;
  readonly reasons: readonly QuietPointReason[];
}

export type SnapshotTrigger =
  | "prompt-boundary"
  | "manual"
  | "post-settle"
  | "pretool-hook"
  | "pre-restore";

/** A1's per-session recent cap; pinned snapshots may be retained in addition. */
export const SNAPSHOT_RETENTION_LIMIT = 100 as const;
export const SNAPSHOT_EXACT_CAPABILITY = WORKSPACE_EXACT_CAPABILITY;

/**
 * v18.6.1 emits `tool_execution_start` as an observation. It does not wait for a host snapshot, so
 * this event can never authorize an exact per-tool snapshot.
 */
export const EXACT_SNAPSHOT_UNAVAILABLE_REASON =
  "Restore points taken right before each tool runs need a newer omp. This version only reports a tool after it has started.";
export const RAW_TOOL_EVENT_UNAVAILABLE_REASON =
  "A tool that has already started can't mark an exact restore point.";

export interface ExactCapabilityGate {
  readonly state: "available" | "unavailable";
  readonly capability: typeof SNAPSHOT_EXACT_CAPABILITY;
  readonly reason?: string;
}

export interface SnapshotRetentionState {
  readonly loadState: "ready" | "unavailable";
  /** Recent-snapshot cap; A1 may retain pinned baselines in addition. */
  readonly limit: number;
  readonly retainedCount: number;
  readonly pinnedBaseline: SnapshotId | null;
  /** IDs known to this coordinator that A1 no longer retains. They are never silently replaced. */
  readonly prunedSnapshotIds: readonly SnapshotId[];
  readonly error: AppError | null;
}

export interface SnapshotView {
  readonly record: SnapshotRecord;
  readonly trigger: SnapshotTrigger;
  readonly guarantee: SnapshotGuarantee;
  readonly includedPaths: SnapshotRecord["includedPaths"];
  readonly excludedPaths: SnapshotRecord["excludedPaths"];
  readonly retention: SnapshotRetentionState;
}

export interface SnapshotListing {
  readonly snapshots: readonly SnapshotView[];
  readonly retention: SnapshotRetentionState;
}

interface CaptureBase {
  readonly trigger: SnapshotTrigger;
  readonly quietPoint: QuietPointCheck;
  readonly exactCapability: ExactCapabilityGate;
}

export interface SnapshotCaptured extends CaptureBase {
  readonly state: "captured";
  readonly record: SnapshotRecord;
  readonly view: SnapshotView;
  readonly retention: SnapshotRetentionState;
  readonly guarantee: SnapshotGuarantee;
  /** Present when a future server returned a boundary record instead of exact. */
  readonly limitation?: string;
}
export interface SnapshotSkipped extends CaptureBase {
  readonly state: "skipped";
  readonly guarantee: "boundary";
  readonly reason: string;
}

export interface SnapshotGated extends CaptureBase {
  readonly state: "gated";
  readonly guarantee: "boundary";
  readonly capability: typeof SNAPSHOT_EXACT_CAPABILITY;
  readonly reason: string;
}

export type SnapshotCaptureResult = SnapshotCaptured | SnapshotSkipped | SnapshotGated;

export interface SnapshotCaptureOptions {
  readonly pinned?: boolean;
  readonly signal?: PortCallOptions["signal"];
}

export interface SnapshotCoordinatorState {
  readonly activeOperations: number;
  readonly lastCapture: SnapshotCaptureResult | null;
  readonly retention: SnapshotRetentionState;
  readonly error: AppError | null;
}

export interface SnapshotCoordinatorOptions {
  readonly store: Pick<CheckpointStorePort, "snapshot" | "list">;
  readonly runtime: QuietPointRuntime;
  readonly workspace: FolderPath;
  readonly conversation: ConversationHead | (() => ConversationHead);
  readonly capabilities?: CapabilityMap | (() => CapabilityMap);
  /** Defaults to true; set false when a composition root wants to call start explicitly. */
  readonly autoStart?: boolean;
}

export type SnapshotCoordinatorListener = (state: SnapshotCoordinatorState) => void;

/** The exact gate used by every pre-tool capture path. Version strings never enable this. */
export function exactSnapshotCapabilityGate(capabilities: CapabilityMap = {}): ExactCapabilityGate {
  if (canClaimExact(capabilities) && capabilities[SNAPSHOT_EXACT_CAPABILITY]?.via === "upstream") {
    return { state: "available", capability: SNAPSHOT_EXACT_CAPABILITY };
  }
  return {
    state: "unavailable",
    capability: SNAPSHOT_EXACT_CAPABILITY,
    reason: EXACT_SNAPSHOT_UNAVAILABLE_REASON,
  };
}

/** A raw start event remains gated even if a future server advertises the upstream capability. */
export function rawToolEventExactGate(): ExactCapabilityGate {
  return {
    state: "unavailable",
    capability: SNAPSHOT_EXACT_CAPABILITY,
    reason: RAW_TOOL_EVENT_UNAVAILABLE_REASON,
  };
}

function activeTool(tool: ToolCallState): boolean {
  return tool.status === "running" || tool.status === "partial";
}

function hasPending(requests: PendingRequestsState, key: keyof PendingRequestsState): boolean {
  return Object.keys(requests[key]).length > 0;
}

const UNAUTHORIZED_EXACT_SNAPSHOT_REASON =
  "The checkpoint store marked a snapshot as exact, but this omp can't guarantee that, so it is kept as a regular restore point.";

/**
 * A quiet point is stronger than `prompt_result`: it requires R0's separate settlement signal, no
 * tracked tool or queued delivery, no pending human/host request, no compaction, and a live process.
 */
export function checkQuietPoint(snapshot: QuietPointRuntimeSnapshot): QuietPointCheck {
  const reasons: QuietPointReason[] = [];
  if (snapshot.needsRefetch) reasons.push("state-out-of-date");
  if (!snapshot.prompt.sessionSettled) reasons.push("session-not-settled");
  if (snapshot.prompt.streaming) reasons.push("turn-streaming");
  if (Object.values(snapshot.tools).some(activeTool)) reasons.push("tracked-tool-running");
  if (snapshot.queue.steering.length > 0) reasons.push("queued-steering");
  if (snapshot.queue.followUp.length > 0) reasons.push("queued-follow-up");
  if (hasPending(snapshot.pending, "extensionUi")) reasons.push("pending-extension-ui");
  if (hasPending(snapshot.pending, "hostTools")) reasons.push("pending-host-tool");
  if (hasPending(snapshot.pending, "hostUris")) reasons.push("pending-host-uri");
  if (snapshot.session.isCompacting) reasons.push("compacting");
  if (snapshot.process.status !== "ready" && snapshot.process.status !== "running") {
    reasons.push("process-unavailable");
  }
  return { quiet: reasons.length === 0, reasons };
}

function quietPointReason(check: QuietPointCheck): string {
  const labels: Record<QuietPointReason, string> = {
    "state-out-of-date": "the runtime state needs to be refetched",
    "session-not-settled": "omp has not finished the session yet",
    "turn-streaming": "the turn is still streaming",
    "tracked-tool-running": "a tracked tool is still running",
    "queued-steering": "steering work is queued",
    "queued-follow-up": "follow-up work is queued",
    "pending-extension-ui": "an extension request is awaiting an answer",
    "pending-host-tool": "a host tool request is awaiting an answer",
    "pending-host-uri": "a host URI request is awaiting an answer",
    compacting: "omp is compacting context",
    "process-unavailable": "the omp process is not ready",
  };
  return check.reasons.map((reason) => labels[reason]).join("; ");
}

function emptyRetention(limit: number): SnapshotRetentionState {
  return {
    loadState: "ready",
    limit,
    retainedCount: 0,
    pinnedBaseline: null,
    prunedSnapshotIds: [],
    error: null,
  };
}

function safeFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function sourceForTrigger(trigger: SnapshotTrigger): CheckpointSnapshotArgs["source"] {
  return trigger === "post-settle" ? "prompt-boundary" : trigger;
}

function conversationFrom(value: ConversationHead | (() => ConversationHead)): ConversationHead {
  return ConversationHeadSchema.parse(typeof value === "function" ? value() : value);
}

function copyRetention(state: SnapshotRetentionState): SnapshotRetentionState {
  return {
    ...state,
    prunedSnapshotIds: [...state.prunedSnapshotIds],
  };
}

function captureView(
  record: SnapshotRecord,
  trigger: SnapshotTrigger,
  retention: SnapshotRetentionState,
): SnapshotView {
  return {
    record,
    trigger,
    guarantee: record.guarantee,
    includedPaths: record.includedPaths,
    excludedPaths: record.excludedPaths,
    retention,
  };
}

export class SnapshotCoordinator {
  private readonly store: Pick<CheckpointStorePort, "snapshot" | "list">;
  private readonly runtime: QuietPointRuntime;
  private readonly workspace: FolderPath;
  private readonly conversation: ConversationHead | (() => ConversationHead);
  private readonly capabilities: () => CapabilityMap;
  private readonly knownSnapshotIds = new Map<string, Set<SnapshotId>>();
  private readonly captureOrder = new Map<string, SnapshotId[]>();
  private readonly pinnedSnapshotIds = new Map<string, Set<SnapshotId>>();
  private readonly prunedSnapshotIds = new Map<string, Set<SnapshotId>>();
  private readonly downgradedSnapshotIds = new Map<string, Set<SnapshotId>>();
  private readonly triggers = new Map<SnapshotId, SnapshotTrigger>();
  private readonly listeners = new Set<SnapshotCoordinatorListener>();
  private readonly queue: Promise<void>[] = [];
  private state: SnapshotCoordinatorState;
  private releaseRuntime: (() => void) | undefined;
  private disposed = false;
  private lastSessionSettled: boolean;
  private turnObserved: boolean;
  private postSettleGeneration = 0;
  private capturedPostSettleGeneration = 0;
  private readonly scheduledPostSettleGenerations = new Set<number>();
  private failedPostSettleGeneration = 0;

  public constructor(options: SnapshotCoordinatorOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.workspace = options.workspace;
    this.conversation = options.conversation;
    const capabilities = options.capabilities;
    this.capabilities =
      typeof capabilities === "function"
        ? () => (capabilities as () => CapabilityMap)()
        : () => capabilities ?? {};
    this.state = {
      activeOperations: 0,
      lastCapture: null,
      retention: emptyRetention(SNAPSHOT_RETENTION_LIMIT),
      error: null,
    };
    const initialRuntime = options.runtime.getSnapshot();
    this.lastSessionSettled = initialRuntime.prompt.sessionSettled;
    this.turnObserved =
      initialRuntime.prompt.streaming ||
      (initialRuntime.prompt.admitted && !initialRuntime.prompt.sessionSettled);
    if (options.autoStart !== false) this.start();
  }

  public getSnapshot(): SnapshotCoordinatorState {
    return this.state;
  }

  public subscribe(listener: SnapshotCoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(): void {
    if (this.disposed || this.releaseRuntime !== undefined) return;
    this.releaseRuntime = this.runtime.subscribe((snapshot) => this.onRuntimeSnapshot(snapshot));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseRuntime?.();
    this.releaseRuntime = undefined;
    this.listeners.clear();
  }

  public checkQuietPoint(): QuietPointCheck {
    return checkQuietPoint(this.runtime.getSnapshot());
  }

  public async takePromptBoundarySnapshot(
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotCaptureResult> {
    return this.capture("prompt-boundary", options);
  }

  public async takeManualSnapshot(
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotCaptureResult> {
    return this.capture("manual", options);
  }

  /** Allows a composition root or a test to request the same post-turn path explicitly. */
  public async takePostSettleSnapshot(
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotCaptureResult> {
    return this.capture("post-settle", options);
  }

  /**
   * The only exact path. Callers must invoke this from an awaitable upstream preflight response;
   * `tool_execution_start` must use `rawToolEventExactGate` and never call this method.
   */
  public async takePretoolHookSnapshot(
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotCaptureResult> {
    return this.capture("pretool-hook", options);
  }

  /** Lists all retained pages and reports IDs that disappeared since this coordinator observed them. */
  public async listSnapshots(options: SnapshotCaptureOptions = {}): Promise<SnapshotListing> {
    return this.serialized(async () => {
      const conversation = conversationFrom(this.conversation);
      try {
        const listing = await this.refreshRetention(conversation.threadId, options.signal);
        const downgraded =
          this.downgradedSnapshotIds.get(conversation.threadId) ?? new Set<SnapshotId>();
        const views = listing.records.map((record) => {
          const isDowngraded = downgraded.has(record.snapshotId);
          const listedRecord = isDowngraded ? { ...record, source: "manual" as const } : record;
          const trigger = isDowngraded
            ? "manual"
            : (this.triggers.get(record.snapshotId) ??
              (record.source === "manual"
                ? "manual"
                : record.source === "pretool-hook"
                  ? "pretool-hook"
                  : record.source === "pre-restore"
                    ? "pre-restore"
                    : "prompt-boundary"));
          return captureView(listedRecord, trigger, listing.retention);
        });
        this.publish({ ...this.state, retention: listing.retention, error: null });
        return { snapshots: views, retention: listing.retention };
      } catch (error) {
        const failure = safeFailure(error, "Checkpoint retention could not be loaded");
        this.publish({ ...this.state, error: failure.appError });
        throw failure;
      }
    });
  }

  private async capture(
    trigger: SnapshotTrigger,
    options: SnapshotCaptureOptions,
  ): Promise<SnapshotCaptureResult> {
    const exactCapability = exactSnapshotCapabilityGate(this.capabilities());
    const quietPoint = this.checkQuietPoint();
    if (trigger === "pretool-hook" && exactCapability.state !== "available") {
      const gated: SnapshotGated = {
        state: "gated",
        trigger,
        quietPoint,
        exactCapability,
        guarantee: "boundary",
        capability: SNAPSHOT_EXACT_CAPABILITY,
        reason: exactCapability.reason ?? EXACT_SNAPSHOT_UNAVAILABLE_REASON,
      };
      this.publish({ ...this.state, lastCapture: gated, error: null });
      return gated;
    }
    if (trigger !== "pretool-hook" && !quietPoint.quiet) {
      const skipped: SnapshotSkipped = {
        state: "skipped",
        trigger,
        quietPoint,
        exactCapability,
        guarantee: "boundary",
        reason: `Snapshot not taken: ${quietPointReason(quietPoint)}. Snapshots are captured only at quiet points.`,
      };
      this.publish({ ...this.state, lastCapture: skipped, error: null });
      return skipped;
    }

    return this.serialized(async () => {
      const currentQuietPoint = this.checkQuietPoint();
      if (trigger !== "pretool-hook" && !currentQuietPoint.quiet) {
        const skipped: SnapshotSkipped = {
          state: "skipped",
          trigger,
          quietPoint: currentQuietPoint,
          exactCapability,
          guarantee: "boundary",
          reason: `Snapshot not taken: ${quietPointReason(currentQuietPoint)}. Snapshots are captured only at quiet points.`,
        };
        this.publish({ ...this.state, lastCapture: skipped, error: null });
        return skipped;
      }

      const conversation = conversationFrom(this.conversation);
      const args: CheckpointSnapshotArgs = {
        workspace: this.workspace,
        conversation,
        source: sourceForTrigger(trigger),
        ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
      };
      try {
        const rawRecord = await this.store.snapshot(args, { signal: options.signal });
        const record = SnapshotRecordSchema.parse(rawRecord);
        if (
          record.guarantee === "exact" &&
          (trigger !== "pretool-hook" ||
            exactCapability.state !== "available" ||
            record.source !== "pretool-hook")
        ) {
          throw new AppFailure({
            code: "unavailable",
            message: UNAUTHORIZED_EXACT_SNAPSHOT_REASON,
            retryable: false,
            capability: SNAPSHOT_EXACT_CAPABILITY,
          });
        }
        const afterCaptureQuietPoint = this.checkQuietPoint();
        const turnStartedDuringCapture =
          trigger !== "pretool-hook" && !afterCaptureQuietPoint.quiet;
        const storedRecord: SnapshotRecord = turnStartedDuringCapture
          ? { ...record, source: "manual" }
          : record;
        const captureTrigger: SnapshotTrigger = turnStartedDuringCapture ? "manual" : trigger;
        if (turnStartedDuringCapture) {
          const downgraded =
            this.downgradedSnapshotIds.get(conversation.threadId) ?? new Set<SnapshotId>();
          downgraded.add(storedRecord.snapshotId);
          this.downgradedSnapshotIds.set(conversation.threadId, downgraded);
        }
        this.triggers.set(storedRecord.snapshotId, captureTrigger);
        const knownIds = this.knownSnapshotIds.get(conversation.threadId) ?? new Set<SnapshotId>();
        const order = this.captureOrder.get(conversation.threadId) ?? [];
        const pinnedIds =
          this.pinnedSnapshotIds.get(conversation.threadId) ?? new Set<SnapshotId>();
        knownIds.add(storedRecord.snapshotId);
        order.push(storedRecord.snapshotId);
        if (storedRecord.pinned) pinnedIds.add(storedRecord.snapshotId);
        const pruned = this.prunedSnapshotIds.get(conversation.threadId) ?? new Set<SnapshotId>();
        while (
          order.filter((snapshotId) => !pinnedIds.has(snapshotId)).length > SNAPSHOT_RETENTION_LIMIT
        ) {
          const candidate = order.find((snapshotId) => !pinnedIds.has(snapshotId));
          if (candidate === undefined) break;
          order.splice(order.indexOf(candidate), 1);
          knownIds.delete(candidate);
          pruned.add(candidate);
        }
        this.knownSnapshotIds.set(conversation.threadId, knownIds);
        this.captureOrder.set(conversation.threadId, order);
        this.pinnedSnapshotIds.set(conversation.threadId, pinnedIds);
        this.prunedSnapshotIds.set(conversation.threadId, pruned);
        const limitation =
          trigger === "pretool-hook" && record.guarantee !== "exact"
            ? "The checkpoint store returned a boundary snapshot; it did not confirm it was taken right before the tool ran."
            : turnStartedDuringCapture
              ? "The turn started while the snapshot was being taken; this restore point is not the pre-prompt quiet point."
              : undefined;
        const retention: SnapshotRetentionState = {
          ...this.state.retention,
          retainedCount: knownIds.size,
          pinnedBaseline: storedRecord.pinned
            ? storedRecord.snapshotId
            : this.state.retention.pinnedBaseline,
          prunedSnapshotIds: [...pruned],
          error: null,
        };
        const view = captureView(storedRecord, captureTrigger, retention);
        const captured: SnapshotCaptured = {
          state: "captured",
          trigger: captureTrigger,
          quietPoint: turnStartedDuringCapture ? afterCaptureQuietPoint : currentQuietPoint,
          exactCapability,
          record: storedRecord,
          view,
          retention,
          guarantee: storedRecord.guarantee,
          ...(limitation === undefined ? {} : { limitation }),
        };
        this.publish({
          ...this.state,
          lastCapture: captured,
          retention,
          error: null,
        });
        return captured;
      } catch (error) {
        const failure = safeFailure(error, "Workspace snapshot failed");
        this.publish({ ...this.state, error: failure.appError });
        throw failure;
      }
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue.at(-1) ?? Promise.resolve();
    let resolve!: () => void;
    const marker = new Promise<void>((done) => {
      resolve = done;
    });
    this.queue.push(marker);
    this.publish({ ...this.state, activeOperations: this.queue.length });
    await previous;
    try {
      return await operation();
    } finally {
      resolve();
      if (this.queue[0] === marker) this.queue.shift();
      else {
        const index = this.queue.indexOf(marker);
        if (index >= 0) this.queue.splice(index, 1);
      }
      this.publish({ ...this.state, activeOperations: this.queue.length });
    }
  }

  private async refreshRetention(
    threadId: ConversationHead["threadId"],
    signal: PortCallOptions["signal"],
  ): Promise<{ records: readonly SnapshotRecord[]; retention: SnapshotRetentionState }> {
    const records: SnapshotRecord[] = [];
    let cursor: CheckpointListResult["nextCursor"] = null;
    let pages = 0;
    do {
      const rawResult = await this.store.list(
        {
          workspace: this.workspace,
          threadId,
          ...(cursor === null ? {} : { cursor }),
          limit: SNAPSHOT_RETENTION_LIMIT,
        },
        { signal },
      );
      const result = CheckpointListResultSchema.parse(rawResult);
      records.push(...result.snapshots.map((record) => SnapshotRecordSchema.parse(record)));
      cursor = result.nextCursor;
      pages += 1;
      if (pages > 1000) {
        throw new AppFailure({
          code: "internal",
          message: "Checkpoint retention returned too many pages",
          retryable: false,
        });
      }
    } while (cursor !== null);

    const currentIds = new Set(records.map((record) => record.snapshotId));
    const known = this.knownSnapshotIds.get(threadId) ?? new Set<SnapshotId>();
    const pruned = this.prunedSnapshotIds.get(threadId) ?? new Set<SnapshotId>();
    for (const snapshotId of known) {
      if (!currentIds.has(snapshotId)) pruned.add(snapshotId);
    }
    this.knownSnapshotIds.set(threadId, currentIds);
    this.captureOrder.set(
      threadId,
      records.map((record) => record.snapshotId),
    );
    this.pinnedSnapshotIds.set(
      threadId,
      new Set(records.filter((record) => record.pinned).map((record) => record.snapshotId)),
    );
    this.prunedSnapshotIds.set(threadId, pruned);
    const pinnedBaseline = records.find((record) => record.pinned)?.snapshotId ?? null;
    const retention: SnapshotRetentionState = {
      loadState: "ready",
      limit: SNAPSHOT_RETENTION_LIMIT,
      retainedCount: records.length,
      pinnedBaseline,
      prunedSnapshotIds: [...pruned],
      error: null,
    };
    return { records, retention };
  }

  private onRuntimeSnapshot(snapshot: QuietPointRuntimeSnapshot): void {
    if (this.disposed) return;
    const settled = snapshot.prompt.sessionSettled;
    if (snapshot.prompt.streaming || (snapshot.prompt.admitted && !settled)) {
      this.turnObserved = true;
    }
    if (!this.lastSessionSettled && settled && this.turnObserved) {
      this.postSettleGeneration += 1;
      this.turnObserved = false;
    }
    this.lastSessionSettled = settled;
    this.maybeSchedulePostSettle(snapshot);
  }

  private maybeSchedulePostSettle(snapshot: QuietPointRuntimeSnapshot): void {
    if (this.disposed) return;
    const generation = this.postSettleGeneration;
    if (
      generation <= this.capturedPostSettleGeneration ||
      generation <= this.failedPostSettleGeneration
    )
      return;
    if (this.scheduledPostSettleGenerations.has(generation)) return;
    if (!checkQuietPoint(snapshot).quiet) return;
    this.scheduledPostSettleGenerations.add(generation);
    void this.takePostSettleSnapshot()
      .then((result) => {
        this.scheduledPostSettleGenerations.delete(generation);
        if (result.state === "captured") {
          this.capturedPostSettleGeneration = Math.max(
            this.capturedPostSettleGeneration,
            generation,
          );
          return;
        }
        // A skipped result leaves the generation pending; recheck in case it became quiet meanwhile.
        this.maybeSchedulePostSettle(this.runtime.getSnapshot());
      })
      .catch((error: unknown) => {
        this.scheduledPostSettleGenerations.delete(generation);
        this.failedPostSettleGeneration = Math.max(this.failedPostSettleGeneration, generation);
        const failure = safeFailure(error, "Post-settle workspace snapshot failed");
        this.publish({ ...this.state, error: failure.appError });
      });
  }

  private publish(state: SnapshotCoordinatorState): void {
    this.state = {
      ...state,
      retention: copyRetention(state.retention),
    };
    for (const listener of this.listeners) listener(this.state);
  }
}

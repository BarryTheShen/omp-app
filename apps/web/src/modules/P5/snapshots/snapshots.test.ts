import type { SnapshotRecord } from "@omp-app/contracts";
import {
  CapabilityStatus,
  CheckpointListResult,
  FolderPath,
  SnapshotRecord as SnapshotRecordSchema,
  ThreadId,
  ToolCallId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  type CheckpointStorePort,
  checkQuietPoint,
  exactSnapshotCapabilityGate,
  type QuietPointReason,
  type QuietPointRuntime,
  type QuietPointRuntimeSnapshot,
  rawToolEventExactGate,
  SNAPSHOT_EXACT_CAPABILITY,
  SNAPSHOT_RETENTION_LIMIT,
  type SnapshotCaptureResult,
  SnapshotCoordinator,
} from ".";

const workspace = FolderPath.parse("/workspace");
const threadId = ThreadId.parse("snapshot-thread");
const conversation = {
  threadId,
  sessionFile: null,
  entryId: null,
};
const runningToolId = ToolCallId.parse("running");

function runtimeState(
  overrides: Partial<QuietPointRuntimeSnapshot> = {},
): QuietPointRuntimeSnapshot {
  return {
    needsRefetch: false,
    ...overrides,
    prompt: {
      admitted: true,
      streaming: false,
      promptResult: null,
      sessionSettled: true,
      promptResults: [],
      ...overrides.prompt,
    },
    queue: {
      steering: [],
      followUp: [],
      steeringMode: "all",
      followUpMode: "all",
      interruptMode: "immediate",
      liveSteered: 0,
      ...overrides.queue,
    },
    tools: { ...overrides.tools },
    pending: {
      extensionUi: {},
      hostTools: {},
      hostUris: {},
      ...overrides.pending,
    },
    process: {
      status: "ready",
      error: null,
      ...overrides.process,
    },
    session: {
      model: null,
      thinkingLevel: null,
      sessionName: null,
      contextUsage: null,
      isCompacting: false,
      autoCompactionEnabled: null,
      tokensPerSecond: null,
      goal: null,
      revision: 1,
      ...overrides.session,
    },
  };
}

class FakeRuntime implements QuietPointRuntime {
  private snapshot: QuietPointRuntimeSnapshot;
  private readonly listeners = new Set<(snapshot: QuietPointRuntimeSnapshot) => void>();

  constructor(snapshot = runtimeState()) {
    this.snapshot = snapshot;
  }

  getSnapshot(): QuietPointRuntimeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: QuietPointRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: QuietPointRuntimeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** Lets every promise the coordinator has already queued run (no wall-clock wait). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
}

function record(index: number, overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return SnapshotRecordSchema.parse({
    snapshotId: `snapshot-${index}`,
    workspaceKey: "workspace-key",
    ompSessionId: threadId,
    sessionFile: null,
    entryId: null,
    capturedAt: new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString(),
    parentSnapshotId: null,
    source: "prompt-boundary",
    includedPaths: [{ path: "src/app.ts", kind: "file", hash: `hash-${index}`, sizeBytes: 1 }],
    excludedPaths: [{ path: ".git", reason: "workspace metadata" }],
    shadowTreeId: `tree-${index}`,
    workspaceHash: `workspace-hash-${index}`,
    guarantee: "boundary",
    pinned: false,
    ...overrides,
  });
}

type SnapshotCallArgs = Parameters<CheckpointStorePort["snapshot"]>[0];

function fakeStore(
  snapshots: readonly SnapshotRecord[] = [record(1)],
  options: {
    readonly onSnapshot?: (args: SnapshotCallArgs) => SnapshotRecord;
    readonly list?: () => readonly SnapshotRecord[];
  } = {},
): Pick<CheckpointStorePort, "snapshot" | "list"> {
  let retained = [...snapshots];
  return {
    snapshot: async (args) => {
      const created = options.onSnapshot?.(args) ?? retained.at(-1) ?? record(1);
      if (!retained.some((item) => item.snapshotId === created.snapshotId)) {
        retained = [...retained, created];
      }
      return created;
    },
    list: async () => {
      const listed = options.list?.() ?? retained;
      return CheckpointListResult.parse({
        snapshots: listed,
        nextCursor: null,
        pinnedBaseline: listed.find((item) => item.pinned)?.snapshotId ?? null,
      });
    },
  };
}

async function waitForCapture(coordinator: SnapshotCoordinator): Promise<void> {
  if (coordinator.getSnapshot().lastCapture?.state === "captured") return;
  await new Promise<void>((resolve) => {
    const unsubscribe = coordinator.subscribe((state) => {
      if (state.lastCapture?.state !== "captured") return;
      unsubscribe();
      resolve();
    });
  });
}

describe("P5 quiet-point snapshot coordination", () => {
  test("accepts only a settled, idle runtime with no queued or pending work", () => {
    expect(checkQuietPoint(runtimeState())).toEqual({ quiet: true, reasons: [] });
    expect(
      checkQuietPoint(
        runtimeState({
          prompt: { ...runtimeState().prompt, sessionSettled: false, streaming: true },
          queue: { ...runtimeState().queue, followUp: ["later"] },
          pending: { ...runtimeState().pending, hostTools: { request: {} as never } },
          session: { ...runtimeState().session, isCompacting: true },
          process: { status: "exited", error: null },
        }),
      ),
    ).toEqual({
      quiet: false,
      reasons: [
        "session-not-settled",
        "turn-streaming",
        "queued-follow-up",
        "pending-host-tool",
        "compacting",
        "process-unavailable",
      ],
    });
  });

  test("blocks snapshots while R0 state needs a refetch", () => {
    expect(checkQuietPoint(runtimeState({ needsRefetch: true }))).toEqual({
      quiet: false,
      reasons: ["state-out-of-date"],
    });
  });

  test("rejects each R0 condition that is not a quiet point", () => {
    const base = runtimeState();
    const pendingRequest = {} as never;
    const blocked: readonly [QuietPointReason, QuietPointRuntimeSnapshot][] = [
      ["session-not-settled", runtimeState({ prompt: { ...base.prompt, sessionSettled: false } })],
      ["turn-streaming", runtimeState({ prompt: { ...base.prompt, streaming: true } })],
      [
        "tracked-tool-running",
        runtimeState({
          tools: {
            [runningToolId]: {
              toolCallId: runningToolId,
              toolName: "bash",
              status: "running",
            },
          },
        }),
      ],
      ["queued-steering", runtimeState({ queue: { ...base.queue, steering: ["later"] } })],
      ["queued-follow-up", runtimeState({ queue: { ...base.queue, followUp: ["later"] } })],
      [
        "pending-extension-ui",
        runtimeState({ pending: { ...base.pending, extensionUi: { request: pendingRequest } } }),
      ],
      [
        "pending-host-tool",
        runtimeState({ pending: { ...base.pending, hostTools: { request: pendingRequest } } }),
      ],
      [
        "pending-host-uri",
        runtimeState({ pending: { ...base.pending, hostUris: { request: pendingRequest } } }),
      ],
      ["compacting", runtimeState({ session: { ...base.session, isCompacting: true } })],
      ["process-unavailable", runtimeState({ process: { status: "starting", error: null } })],
    ];
    for (const [reason, snapshot] of blocked) {
      expect(checkQuietPoint(snapshot)).toEqual({ quiet: false, reasons: [reason] });
    }
  });

  test("takes prompt-boundary and manual snapshots through A1 only at quiet points", async () => {
    const runtime = new FakeRuntime(
      runtimeState({
        prompt: { ...runtimeState().prompt, sessionSettled: false, streaming: true },
      }),
    );
    const calls: SnapshotCallArgs[] = [];
    const store = fakeStore([], {
      onSnapshot: (args) => {
        calls.push(args);
        return record(calls.length, { source: args.source, pinned: args.pinned ?? false });
      },
    });
    const coordinator = new SnapshotCoordinator({
      store,
      runtime,
      workspace,
      conversation,
      autoStart: false,
    });

    const skippedBoundary = await coordinator.takePromptBoundarySnapshot();
    const skippedManual = await coordinator.takeManualSnapshot();
    expect(skippedBoundary).toMatchObject({
      state: "skipped",
      reason: expect.stringContaining("omp has not finished the session"),
    });
    expect(skippedManual.state).toBe("skipped");
    expect(calls).toHaveLength(0);
    runtime.emit(runtimeState());
    const boundary = await coordinator.takePromptBoundarySnapshot();
    const manual = await coordinator.takeManualSnapshot({ pinned: true });
    expect(boundary).toMatchObject({
      state: "captured",
      trigger: "prompt-boundary",
      guarantee: "boundary",
    });
    expect(manual).toMatchObject({ state: "captured", trigger: "manual", guarantee: "boundary" });
    expect(calls.map((call) => call.source)).toEqual(["prompt-boundary", "manual"]);
    expect(calls.at(-1)?.pinned).toBe(true);
    if (boundary.state === "captured") {
      expect(boundary.view.includedPaths).toEqual(boundary.record.includedPaths);
      expect(boundary.view.excludedPaths).toEqual(boundary.record.excludedPaths);
    }
  });

  test("captures one post-settle snapshot per settled turn and never on a raw tool update", async () => {
    const runtime = new FakeRuntime(
      runtimeState({ prompt: { ...runtimeState().prompt, sessionSettled: false } }),
    );
    const calls: SnapshotCallArgs[] = [];
    const coordinator = new SnapshotCoordinator({
      store: fakeStore([], {
        onSnapshot: (args) => {
          calls.push(args);
          return record(calls.length, { source: args.source });
        },
      }),
      runtime,
      workspace,
      conversation,
    });

    runtime.emit(
      runtimeState({
        tools: {
          [runningToolId]: {
            toolCallId: runningToolId,
            toolName: "bash",
            status: "running",
          },
        },
      }),
    );
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    runtime.emit(runtimeState());
    await waitForCapture(coordinator);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("prompt-boundary");

    runtime.emit(runtimeState());
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    coordinator.dispose();
  });

  test("keeps in-flight settled generations from duplicating a newer turn's snapshot", async () => {
    const active = runtimeState({
      prompt: { ...runtimeState().prompt, sessionSettled: false, streaming: true },
    });
    const runtime = new FakeRuntime(active);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstSnapshotStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondSnapshotStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const calls: SnapshotCallArgs[] = [];
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async (args) => {
          calls.push(args);
          const ordinal = calls.length;
          if (ordinal === 1) {
            firstStarted();
            await firstGate;
          } else if (ordinal === 2) {
            secondStarted();
            await secondGate;
          }
          return record(ordinal, { source: args.source });
        },
        list: async () =>
          CheckpointListResult.parse({ snapshots: [], nextCursor: null, pinnedBaseline: null }),
      },
      runtime,
      workspace,
      conversation,
    });

    runtime.emit(runtimeState());
    await firstSnapshotStarted;
    runtime.emit(active);
    runtime.emit(runtimeState());
    releaseFirst();
    await secondSnapshotStarted;
    await Promise.resolve();
    runtime.emit(runtimeState());

    const idle = new Promise<void>((resolve) => {
      const unsubscribe = coordinator.subscribe((state) => {
        if (state.activeOperations !== 0) return;
        unsubscribe();
        resolve();
      });
    });
    releaseSecond();
    await idle;
    expect(calls).toHaveLength(2);
    coordinator.dispose();
  });

  test("serializes overlapping captures and exposes retained paths, pinned baseline and pruned ids", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: SnapshotCallArgs[] = [];
    let listed = [record(1, { pinned: true }), record(2)];
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async (args) => {
          calls.push(args);
          if (calls.length === 1) await gate;
          return record(calls.length, { source: args.source });
        },
        list: async () =>
          CheckpointListResult.parse({
            snapshots: listed,
            nextCursor: null,
            pinnedBaseline: listed.find((item) => item.pinned)?.snapshotId ?? null,
          }),
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });

    const first = coordinator.takeManualSnapshot();
    const second = coordinator.takeManualSnapshot();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);

    listed = [record(2)];
    const listing = await coordinator.listSnapshots();
    expect(listing.retention.pinnedBaseline).toBe(null);
    expect(listing.retention.prunedSnapshotIds).toContain("snapshot-1");
    expect(listing.snapshots[0]?.includedPaths[0]?.path).toBe("src/app.ts");
  });

  test("reports the 100-snapshot retention cap plus a pinned baseline across pages", async () => {
    const snapshots = Array.from({ length: SNAPSHOT_RETENTION_LIMIT + 1 }, (_, index) =>
      record(index, { pinned: index === 0 }),
    );
    const listCalls: Array<{ cursor: string | undefined; limit: number | undefined }> = [];
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => record(999),
        list: async ({ cursor, limit }) => {
          listCalls.push({ cursor, limit });
          const start = cursor === undefined ? 0 : Number(cursor);
          const end = start + (limit ?? SNAPSHOT_RETENTION_LIMIT);
          const page = snapshots.slice(start, end);
          return CheckpointListResult.parse({
            snapshots: page,
            nextCursor: end < snapshots.length ? String(end) : null,
            pinnedBaseline: snapshots.find((item) => item.pinned)?.snapshotId ?? null,
          });
        },
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });

    const listing = await coordinator.listSnapshots();
    expect(listCalls).toEqual([
      { cursor: undefined, limit: SNAPSHOT_RETENTION_LIMIT },
      { cursor: "100", limit: SNAPSHOT_RETENTION_LIMIT },
    ]);
    expect(listing.snapshots).toHaveLength(SNAPSHOT_RETENTION_LIMIT + 1);
    expect(listing.retention).toMatchObject({
      limit: SNAPSHOT_RETENTION_LIMIT,
      retainedCount: SNAPSHOT_RETENTION_LIMIT + 1,
      pinnedBaseline: "snapshot-0",
    });
  });

  test("keeps the cap literal while retaining a pinned capture beyond it", async () => {
    let calls = 0;
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => {
          calls += 1;
          return record(calls - 1, { pinned: calls === SNAPSHOT_RETENTION_LIMIT + 1 });
        },
        list: async () =>
          CheckpointListResult.parse({ snapshots: [], nextCursor: null, pinnedBaseline: null }),
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });
    let result: SnapshotCaptureResult | undefined;
    for (let index = 0; index <= SNAPSHOT_RETENTION_LIMIT; index += 1) {
      result = await coordinator.takeManualSnapshot({ pinned: index === SNAPSHOT_RETENTION_LIMIT });
    }
    expect(result).toMatchObject({
      state: "captured",
      retention: {
        retainedCount: SNAPSHOT_RETENTION_LIMIT + 1,
        pinnedBaseline: "snapshot-100",
        prunedSnapshotIds: [],
      },
    });
  });

  test("reconciles ordinary retention before the next capture", async () => {
    const existing = Array.from({ length: SNAPSHOT_RETENTION_LIMIT }, (_, index) => record(index));
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => record(SNAPSHOT_RETENTION_LIMIT),
        list: async () =>
          CheckpointListResult.parse({
            snapshots: existing,
            nextCursor: null,
            pinnedBaseline: null,
          }),
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });
    await coordinator.listSnapshots();
    const result = await coordinator.takeManualSnapshot();
    expect(result).toMatchObject({
      state: "captured",
      retention: {
        retainedCount: SNAPSHOT_RETENTION_LIMIT,
        prunedSnapshotIds: ["snapshot-0"],
      },
    });
  });

  test("keeps a pinned record from a listing in addition to the cap when the next capture prunes", async () => {
    const existing = [
      record(0, { pinned: true }),
      ...Array.from({ length: SNAPSHOT_RETENTION_LIMIT }, (_, index) => record(index + 1)),
    ];
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => record(SNAPSHOT_RETENTION_LIMIT + 1),
        list: async () =>
          CheckpointListResult.parse({
            snapshots: existing,
            nextCursor: null,
            pinnedBaseline: "snapshot-0",
          }),
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });
    await coordinator.listSnapshots();
    const result = await coordinator.takeManualSnapshot();
    expect(result).toMatchObject({
      state: "captured",
      retention: {
        retainedCount: SNAPSHOT_RETENTION_LIMIT + 1,
        pinnedBaseline: "snapshot-0",
        prunedSnapshotIds: ["snapshot-1"],
      },
    });
  });

  test("gates exact pre-tool snapshots with the upstream capability and never upgrades raw events", async () => {
    const runtime = new FakeRuntime(
      runtimeState({ prompt: { ...runtimeState().prompt, streaming: true } }),
    );
    let calls = 0;
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => {
          calls += 1;
          return record(1, { source: "pretool-hook", guarantee: "exact" });
        },
        list: async () =>
          CheckpointListResult.parse({ snapshots: [], nextCursor: null, pinnedBaseline: null }),
      },
      runtime,
      workspace,
      conversation,
      capabilities: {},
      autoStart: false,
    });

    const gated = await coordinator.takePretoolHookSnapshot();
    expect(gated).toMatchObject({
      state: "gated",
      capability: SNAPSHOT_EXACT_CAPABILITY,
      reason:
        "Restore points taken right before each tool runs need a newer omp. This version only reports a tool after it has started.",
    });
    expect(calls).toBe(0);
    expect(rawToolEventExactGate()).toMatchObject({
      state: "unavailable",
      capability: SNAPSHOT_EXACT_CAPABILITY,
      reason: "A tool that has already started can't mark an exact restore point.",
    });
    expect(
      exactSnapshotCapabilityGate({
        [SNAPSHOT_EXACT_CAPABILITY]: CapabilityStatus.parse({
          state: "fallback",
          via: "upstream",
        }),
      }),
    ).toMatchObject({
      state: "unavailable",
      reason:
        "Restore points taken right before each tool runs need a newer omp. This version only reports a tool after it has started.",
    });
    expect(
      exactSnapshotCapabilityGate({
        [SNAPSHOT_EXACT_CAPABILITY]: CapabilityStatus.parse({
          state: "available",
          via: "host",
        }),
      }),
    ).toMatchObject({
      state: "unavailable",
      reason:
        "Restore points taken right before each tool runs need a newer omp. This version only reports a tool after it has started.",
    });
  });

  test("reads changing capabilities for each exact capture", async () => {
    let capabilities: Record<string, unknown> = {};
    const coordinator = new SnapshotCoordinator({
      store: fakeStore([], {
        onSnapshot: (args) => record(1, { source: args.source, guarantee: "exact" }),
      }),
      runtime: new FakeRuntime(
        runtimeState({ prompt: { ...runtimeState().prompt, streaming: true } }),
      ),
      workspace,
      conversation,
      capabilities: () => capabilities as never,
      autoStart: false,
    });
    expect((await coordinator.takePretoolHookSnapshot()).state).toBe("gated");
    capabilities = {
      [SNAPSHOT_EXACT_CAPABILITY]: CapabilityStatus.parse({ state: "available", via: "upstream" }),
    };
    expect(await coordinator.takePretoolHookSnapshot()).toMatchObject({
      state: "captured",
      guarantee: "exact",
    });
  });

  test("maps a pre-restore record to the pre-restore trigger", async () => {
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => record(1, { source: "pre-restore" }),
        list: async () =>
          CheckpointListResult.parse({
            snapshots: [record(1, { source: "pre-restore" })],
            nextCursor: null,
            pinnedBaseline: null,
          }),
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });
    const listing = await coordinator.listSnapshots();
    expect(listing.snapshots[0]?.trigger).toBe("pre-restore");
  });

  test("keeps a boundary guarantee visible if a future exact gate has a boundary-only store", async () => {
    const coordinator = new SnapshotCoordinator({
      store: fakeStore([], {
        onSnapshot: (args) => record(1, { source: args.source, guarantee: "boundary" }),
      }),
      runtime: new FakeRuntime(
        runtimeState({ prompt: { ...runtimeState().prompt, streaming: true } }),
      ),
      workspace,
      conversation,
      capabilities: {
        [SNAPSHOT_EXACT_CAPABILITY]: CapabilityStatus.parse({
          state: "available",
          via: "upstream",
        }),
      },
      autoStart: false,
    });

    const result = await coordinator.takePretoolHookSnapshot();
    expect(result).toMatchObject({ state: "captured", guarantee: "boundary" });
    if (result.state === "captured") {
      expect(result.limitation).toContain("right before the tool ran");
    }
  });

  test("accepts an exact store guarantee only on the available pre-tool path", async () => {
    const coordinator = new SnapshotCoordinator({
      store: fakeStore([], {
        onSnapshot: (args) => record(1, { source: args.source, guarantee: "exact" }),
      }),
      runtime: new FakeRuntime(
        runtimeState({
          prompt: { ...runtimeState().prompt, sessionSettled: false, streaming: true },
        }),
      ),
      workspace,
      conversation,
      capabilities: {
        [SNAPSHOT_EXACT_CAPABILITY]: CapabilityStatus.parse({
          state: "available",
          via: "upstream",
        }),
      },
      autoStart: false,
    });

    const result = await coordinator.takePretoolHookSnapshot();
    expect(result).toMatchObject({
      state: "captured",
      trigger: "pretool-hook",
      guarantee: "exact",
      exactCapability: { state: "available" },
    });
    expect(rawToolEventExactGate()).toMatchObject({
      state: "unavailable",
      capability: SNAPSHOT_EXACT_CAPABILITY,
    });
  });

  test("rejects an exact store guarantee for a boundary capture and surfaces the capability reason", async () => {
    const coordinator = new SnapshotCoordinator({
      store: fakeStore([], {
        onSnapshot: (args) => record(1, { source: args.source, guarantee: "exact" }),
      }),
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      capabilities: {
        [SNAPSHOT_EXACT_CAPABILITY]: CapabilityStatus.parse({
          state: "available",
          via: "upstream",
        }),
      },
      autoStart: false,
    });

    await expect(coordinator.takeManualSnapshot()).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        capability: SNAPSHOT_EXACT_CAPABILITY,
        message: expect.stringContaining("kept as a regular restore point"),
      },
    });
    expect(coordinator.getSnapshot().error).toMatchObject({
      code: "unavailable",
      capability: SNAPSHOT_EXACT_CAPABILITY,
      message: expect.stringContaining("kept as a regular restore point"),
    });
  });

  test("downgrades a prompt-boundary record when a turn starts during capture", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = new FakeRuntime();
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async (args) => {
          started.resolve();
          await release.promise;
          return record(1, { source: args.source });
        },
        list: async () =>
          CheckpointListResult.parse({
            snapshots: [record(1, { source: "prompt-boundary" })],
            nextCursor: null,
            pinnedBaseline: null,
          }),
      },
      runtime,
      workspace,
      conversation,
      autoStart: false,
    });
    const capture = coordinator.takePromptBoundarySnapshot();
    await started.promise;
    runtime.emit(runtimeState({ prompt: { ...runtimeState().prompt, streaming: true } }));
    release.resolve();
    const result = await capture;
    expect(result).toMatchObject({
      state: "captured",
      record: { source: "manual" },
      limitation: expect.stringContaining("not the pre-prompt quiet point"),
    });
    if (result.state !== "captured") throw new Error("the raced capture must be captured");
    expect(result.quietPoint.quiet).toBe(false);
    expect(result.quietPoint.reasons).toContain("turn-streaming");
    const listing = await coordinator.listSnapshots();
    expect(listing.snapshots[0]).toMatchObject({
      record: { source: "manual" },
      trigger: "manual",
    });
  });
  test("does not refresh full retention metadata after each capture", async () => {
    let listCalls = 0;
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => record(1),
        list: async () => {
          listCalls += 1;
          throw new Error("retention should load only when listing");
        },
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });

    const result = await coordinator.takeManualSnapshot();
    expect(result).toMatchObject({
      state: "captured",
      record: { snapshotId: "snapshot-1" },
      retention: { loadState: "ready", error: null, retainedCount: 1 },
    });
    expect(listCalls).toBe(0);
  });

  test("does not retry an automatic failure until a new settled generation", async () => {
    let calls = 0;
    const failed = Promise.withResolvers<void>();
    const runtime = new FakeRuntime(
      runtimeState({ prompt: { ...runtimeState().prompt, sessionSettled: false } }),
    );
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => {
          calls += 1;
          throw new Error("automatic failure");
        },
        list: async () =>
          CheckpointListResult.parse({ snapshots: [], nextCursor: null, pinnedBaseline: null }),
      },
      runtime,
      workspace,
      conversation,
    });
    coordinator.subscribe((state) => {
      if (state.error !== null) failed.resolve();
    });
    runtime.emit(runtimeState());
    await failed.promise;
    // The error is published before the coordinator has finished handling the failure: let it finish first.
    await settle();
    runtime.emit(runtimeState());
    runtime.emit(runtimeState());
    await settle();
    expect(calls).toBe(1);
    // A new settled turn is a new generation: exactly one more attempt.
    runtime.emit(
      runtimeState({
        prompt: { ...runtimeState().prompt, streaming: true, sessionSettled: false },
      }),
    );
    runtime.emit(runtimeState());
    await settle();
    expect(calls).toBe(2);
    coordinator.dispose();
  });
  test("records an automatic failure without an unhandled rejection and preserves the typed error", async () => {
    const failure = new Error("checkpoint unavailable");
    const coordinator = new SnapshotCoordinator({
      store: {
        snapshot: async () => {
          throw failure;
        },
        list: async () =>
          CheckpointListResult.parse({ snapshots: [], nextCursor: null, pinnedBaseline: null }),
      },
      runtime: new FakeRuntime(),
      workspace,
      conversation,
      autoStart: false,
    });
    await expect(coordinator.takeManualSnapshot()).rejects.toMatchObject({
      appError: { code: "internal", message: "Workspace snapshot failed" },
    });
    expect(coordinator.getSnapshot().error?.code).toBe("internal");
  });
});

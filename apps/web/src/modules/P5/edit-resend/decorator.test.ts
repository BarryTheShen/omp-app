import {
  CheckpointDiff as CheckpointDiffSchema,
  type ConversationHead,
  ConversationHead as ConversationHeadSchema,
  EntryId,
  FolderPath,
  RestorePlan as RestorePlanSchema,
  RestoreResult as RestoreResultSchema,
  type SnapshotRecord,
  SnapshotRecord as SnapshotRecordSchema,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { EditRequest } from "@/modules/P3/contract";
import type { CheckpointController } from "../contract/contract";
import {
  RestorePlanViewSchema,
  type WorkspaceRestoreResultView,
  WorkspaceRestoreResultViewSchema,
} from "../contract/contract";
import type { SnapshotListing, SnapshotRetentionState } from "../snapshots";
import { createEditResendDecorator, type EditResendConfirmation } from "./decorator";
import { evaluateEditResendGuard } from "./guard";

const threadId = ThreadId.parse("thread-edit");
const parentId = EntryId.parse("entry-parent");
const workspace = FolderPath.parse("/workspace");
const conversation = ConversationHeadSchema.parse({
  threadId,
  sessionFile: null,
  entryId: parentId,
});
type CheckpointMethods = Pick<CheckpointController, "diff" | "planRestore" | "restore">;

const retention: SnapshotRetentionState = {
  loadState: "ready",
  limit: 100,
  retainedCount: 1,
  pinnedBaseline: null,
  prunedSnapshotIds: [],
  error: null,
};

function snapshot(overrides: Record<string, unknown> = {}): SnapshotRecord {
  return SnapshotRecordSchema.parse({
    snapshotId: "snapshot-before-prompt",
    workspaceKey: "workspace-key",
    ompSessionId: threadId,
    sessionFile: null,
    entryId: parentId,
    capturedAt: "2026-10-18T00:00:00.000Z",
    parentSnapshotId: null,
    source: "prompt-boundary",
    includedPaths: [{ path: "src/app.ts", kind: "file", hash: "before", sizeBytes: 4 }],
    excludedPaths: [{ path: ".git", reason: "workspace metadata" }],
    shadowTreeId: "tree-before",
    workspaceHash: "hash-before",
    guarantee: "boundary",
    pinned: false,
    ...overrides,
  });
}

function request(signal?: AbortSignal): EditRequest {
  return {
    source: {
      threadId,
      entryId: EntryId.parse("entry-edited"),
      parentId,
      originalText: "old",
      originalImages: [],
      sourceHeadId: null,
    },
    replacementText: "new",
    replacementImages: [],
    ...(signal === undefined ? {} : { signal }),
  };
}

function listing(records: readonly SnapshotRecord[]): SnapshotListing {
  return {
    snapshots: records.map((record) => ({
      record,
      trigger: "prompt-boundary",
      guarantee: record.guarantee,
      includedPaths: record.includedPaths,
      excludedPaths: record.excludedPaths,
      retention,
    })),
    retention,
  };
}

function diff(overrides: Record<string, unknown> = {}) {
  return CheckpointDiffSchema.parse({
    snapshotId: "snapshot-before-prompt",
    workspace,
    entries: [],
    excludedPaths: [{ path: ".git", reason: "workspace metadata" }],
    externalChanges: [],
    currentWorkspaceHash: "hash-before",
    snapshotWorkspaceHash: "hash-before",
    ...overrides,
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return RestorePlanViewSchema.parse({
    ...RestorePlanSchema.parse({
      planId: "plan-edit-resend",
      workspace,
      operation: "edit-resend",
      snapshotId: "snapshot-before-prompt",
      currentConversation: conversation,
      targetConversation: null,
      currentWorkspaceHash: "hash-before",
      targetWorkspaceHash: "hash-before",
      includedPaths: [{ path: "src/app.ts", kind: "file", hash: "before", sizeBytes: 4 }],
      excludedPaths: [{ path: ".git", reason: "workspace metadata" }],
      externalChanges: [],
      capturedPathCount: 1,
      snapshotGuarantee: "boundary",
      destructive: true,
      requiresConfirmation: true,
    }),
    wording: "workspace restore",
    workspaceGuarantee: "boundary",
    confirmation: {
      operation: "edit-resend",
      confirmed: false,
      wording: "workspace restore",
      guarantee: "boundary",
    },
    noInventoryClaim: true,
    ...overrides,
  });
}

function restoreResult(overrides: Record<string, unknown> = {}): WorkspaceRestoreResultView {
  return WorkspaceRestoreResultViewSchema.parse({
    ...RestoreResultSchema.parse({
      planId: "plan-edit-resend",
      operation: "edit-resend",
      filesRestored: true,
      conversationRestored: false,
      capturedPathCount: 1,
      excludedPaths: [".git"],
      snapshotGuarantee: "boundary",
      externalChanges: [],
      partialFailure: null,
      previousConversation: conversation,
      currentConversation: conversation,
      undoSnapshotId: null,
      redoAvailable: false,
    }),
    wording: "workspace restore",
    workspaceGuarantee: "boundary",
    noInventoryClaim: true,
    ...overrides,
  });
}

function checkpoint(overrides: Partial<CheckpointMethods> = {}): CheckpointMethods {
  return {
    diff: async () => diff(),
    planRestore: async () => plan(),
    restore: async () => restoreResult(),
    ...overrides,
  };
}

function decorator(options: {
  readonly records?: readonly SnapshotRecord[];
  readonly checkpoint?: Partial<CheckpointMethods>;
  readonly confirm?: (input: EditResendConfirmation) => Promise<boolean> | boolean;
  readonly capabilities?: Parameters<typeof evaluateEditResendGuard>[0]["capabilities"];
  readonly conversation?: ConversationHead | (() => ConversationHead);
  readonly listSnapshots?: () => Promise<SnapshotListing>;
}) {
  return createEditResendDecorator({
    snapshots: {
      listSnapshots:
        options.listSnapshots ?? (async () => listing(options.records ?? [snapshot()])),
    },
    checkpoint: checkpoint(options.checkpoint),
    workspace,
    conversation: options.conversation ?? conversation,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  });
}

describe("edit-resend guard", () => {
  test("requires confirmation for boundary snapshots and detects hash drift", () => {
    expect(
      evaluateEditResendGuard({
        snapshot: snapshot(),
        currentWorkspaceHash: "hash-after",
        capabilities: {},
      }),
    ).toMatchObject({ allowed: true, requiresConfirmation: true, guarantee: "boundary" });
  });

  test("allows an unchanged exact snapshot only with the capability", () => {
    expect(
      evaluateEditResendGuard({
        snapshot: snapshot({ guarantee: "exact" }),
        currentWorkspaceHash: "hash-before",
        capabilities: { "upstream.tool-preflight": { state: "available", via: "upstream" } },
      }),
    ).toMatchObject({ allowed: true, requiresConfirmation: false, guarantee: "exact" });
  });
});

describe("edit-resend decorator", () => {
  test("selects the newest of multiple matching prompt-boundary snapshots", async () => {
    const older = snapshot({ snapshotId: "older", capturedAt: "2026-10-17T00:00:00.000Z" });
    const newest = snapshot({ snapshotId: "newest", capturedAt: "2026-10-18T01:00:00.000Z" });
    let selected = "";
    const run = decorator({
      records: [older, newest],
      checkpoint: {
        diff: async ({ snapshotId }) => {
          selected = snapshotId;
          return diff();
        },
      },
      confirm: () => true,
    });
    await run(request(), async () => ({ threadId, admitted: true, settled: false }));
    expect(selected).toBe("newest");
  });

  test("filters each newest wrong snapshot and keeps the older matching one", async () => {
    const older = snapshot({ snapshotId: "older", capturedAt: "2026-10-17T00:00:00.000Z" });
    const wrongSnapshots = [
      snapshot({
        snapshotId: "wrong-thread",
        capturedAt: "2026-10-18T09:00:00.000Z",
        ompSessionId: ThreadId.parse("other-thread"),
      }),
      snapshot({
        snapshotId: "wrong-parent",
        capturedAt: "2026-10-18T09:00:00.000Z",
        entryId: EntryId.parse("other-parent"),
      }),
      snapshot({
        snapshotId: "manual",
        capturedAt: "2026-10-18T09:00:00.000Z",
        source: "manual",
      }),
    ];
    for (const wrong of wrongSnapshots) {
      let selected = "";
      const run = decorator({
        records: [older, wrong],
        checkpoint: {
          diff: async ({ snapshotId }) => {
            selected = snapshotId;
            return diff();
          },
        },
        confirm: () => true,
      });
      await run(request(), async () => ({ threadId, admitted: true, settled: false }));
      expect(selected).toBe("older");
    }
  });

  test("passes restore arguments and returns the restored guarantee and external paths", async () => {
    const calls: string[] = [];
    let planArgs: Parameters<CheckpointMethods["planRestore"]>[0] | undefined;
    let restoreArgs: Parameters<CheckpointMethods["restore"]>[0] | undefined;
    const run = decorator({
      checkpoint: {
        diff: async () => diff({ currentWorkspaceHash: "hash-current" }),
        planRestore: async (args) => {
          planArgs = args;
          return plan({ currentWorkspaceHash: "hash-current", targetWorkspaceHash: "hash-before" });
        },
        restore: async (args) => {
          restoreArgs = args;
          calls.push("restore");
          return restoreResult({
            workspaceGuarantee: "exact",
            externalChanges: [
              {
                path: "src/app.ts",
                change: "modified",
                expectedHash: "before",
                actualHash: "after",
              },
            ],
          });
        },
      },
      confirm: () => true,
      conversation: () => conversation,
    });
    const result = await run(request(), async () => {
      calls.push("run");
      return { threadId, admitted: true, settled: false };
    });
    expect(planArgs).toMatchObject({
      operation: "edit-resend",
      snapshotId: "snapshot-before-prompt",
      targetConversation: null,
      expectedWorkspaceHash: "hash-current",
    });
    expect(planArgs?.currentConversation).toEqual(conversation);
    expect(restoreArgs).toEqual({ planId: "plan-edit-resend", confirmed: true });
    expect(calls).toEqual(["restore", "run"]);
    expect(result).toEqual({
      threadId,
      admitted: true,
      settled: false,
      workspaceGuarantee: "exact",
      externalChanges: ["src/app.ts"],
    });
  });

  test("returns the guarantee the restore reports, whichever it is", async () => {
    for (const guarantee of ["boundary", "exact"] as const) {
      const run = decorator({
        checkpoint: { restore: async () => restoreResult({ workspaceGuarantee: guarantee }) },
        confirm: () => true,
      });
      const result = await run(request(), async () => ({
        threadId,
        admitted: true,
        settled: false,
      }));
      expect(result.workspaceGuarantee).toBe(guarantee);
    }
  });

  test("does not send when restore reports partial failure or no files restored", async () => {
    for (const result of [
      restoreResult({
        partialFailure: {
          stage: "files",
          message: "permission denied",
          rollbackAttempted: true,
          rollbackSucceeded: true,
        },
      }),
      restoreResult({ filesRestored: false }),
    ]) {
      let sent = false;
      const run = decorator({ checkpoint: { restore: async () => result }, confirm: () => true });
      await expect(
        run(request(), async () => {
          sent = true;
          return { threadId, admitted: true, settled: false };
        }),
      ).rejects.toMatchObject({ appError: { code: "conflict" } });
      expect(sent).toBe(false);
    }
  });

  test("requires confirmation for changed files even when plan and guarantee do not", async () => {
    let confirmations = 0;
    const run = decorator({
      records: [snapshot({ guarantee: "exact" })],
      capabilities: { "upstream.tool-preflight": { state: "available", via: "upstream" } },
      checkpoint: {
        diff: async () =>
          diff({
            externalChanges: [
              {
                path: "src/app.ts",
                change: "modified",
                expectedHash: "before",
                actualHash: "after",
              },
            ],
            currentWorkspaceHash: "hash-before",
          }),
        planRestore: async () => plan({ requiresConfirmation: false, externalChanges: [] }),
      },
      confirm: ({ externalChanges }) => {
        confirmations += 1;
        expect(externalChanges.map((change) => change.path)).toEqual(["src/app.ts"]);
        return false;
      },
    });
    await expect(
      run(request(), async () => ({ threadId, admitted: true, settled: false })),
    ).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    expect(confirmations).toBe(1);
  });

  test("reports not-found, no-confirm, and exact-without-capability safely", async () => {
    await expect(
      decorator({ records: [snapshot({ entryId: EntryId.parse("other-parent") })] })(
        request(),
        async () => ({ threadId, admitted: true, settled: false }),
      ),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });

    await expect(
      decorator({})(request(), async () => ({ threadId, admitted: true, settled: false })),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });

    await expect(
      decorator({ records: [snapshot({ guarantee: "exact" })] })(request(), async () => ({
        threadId,
        admitted: true,
        settled: false,
      })),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
  });
  test("asks for confirmation for the boundary guard alone", async () => {
    let confirmed = 0;
    const run = decorator({
      checkpoint: { planRestore: async () => plan({ requiresConfirmation: false }) },
      confirm: () => {
        confirmed += 1;
        return true;
      },
    });
    await run(request(), async () => ({ threadId, admitted: true, settled: false }));
    expect(confirmed).toBe(1);
  });

  test("asks for confirmation for a plan that requires it", async () => {
    let confirmed = 0;
    const run = decorator({
      records: [snapshot({ guarantee: "exact" })],
      capabilities: { "upstream.tool-preflight": { state: "available", via: "upstream" } },
      confirm: () => {
        confirmed += 1;
        return true;
      },
    });
    await run(request(), async () => ({ threadId, admitted: true, settled: false }));
    expect(confirmed).toBe(1);
  });

  test("asks for confirmation for changes reported only by the plan", async () => {
    let confirmed = 0;
    const run = decorator({
      records: [snapshot({ guarantee: "exact" })],
      capabilities: { "upstream.tool-preflight": { state: "available", via: "upstream" } },
      checkpoint: {
        planRestore: async () =>
          plan({
            requiresConfirmation: false,
            externalChanges: [
              {
                path: "src/app.ts",
                change: "modified",
                expectedHash: "before",
                actualHash: "after",
              },
            ],
          }),
      },
      confirm: () => {
        confirmed += 1;
        return true;
      },
    });
    await run(request(), async () => ({ threadId, admitted: true, settled: false }));
    expect(confirmed).toBe(1);
  });

  test("checks cancellation at each boundary and reports post-restore cancellation exactly", async () => {
    const stages = ["list", "listing", "diff", "plan", "confirm", "restore", "run"] as const;
    for (const stage of stages) {
      const controller = new AbortController();
      const calls = { list: 0, diff: 0, plan: 0, confirm: 0, restore: 0, run: 0 };
      const abort = (): void => controller.abort();
      const run = decorator({
        listSnapshots: async () => {
          calls.list += 1;
          if (stage === "listing") abort();
          return listing([snapshot()]);
        },
        checkpoint: {
          diff: async () => {
            calls.diff += 1;
            if (stage === "diff") abort();
            return diff();
          },
          planRestore: async () => {
            calls.plan += 1;
            if (stage === "plan") abort();
            return plan();
          },
          restore: async () => {
            calls.restore += 1;
            if (stage === "restore") abort();
            return restoreResult();
          },
        },
        confirm: async () => {
          calls.confirm += 1;
          if (stage === "confirm") abort();
          return true;
        },
      });
      if (stage === "list") controller.abort();
      const error = await run(request(controller.signal), async () => {
        calls.run += 1;
        if (stage === "run") abort();
        return { threadId, admitted: true, settled: false };
      }).catch((value: unknown) => value);
      const stageIndex = stages.indexOf(stage);
      const reached = (name: (typeof stages)[number]): number =>
        stageIndex >= stages.indexOf(name) ? 1 : 0;
      expect(calls).toEqual({
        list: stage === "list" ? 0 : 1,
        diff: reached("diff"),
        plan: reached("plan"),
        confirm: reached("confirm"),
        restore: reached("restore"),
        run: stage === "run" ? 1 : 0,
      });
      expect(error).toMatchObject({
        appError: {
          code: "cancelled",
          message:
            stage === "restore" || stage === "run"
              ? "The workspace files were restored, but the edited message was not sent."
              : "The workspace restore was cancelled before the edit was sent.",
        },
      });
      if (stage === "restore" || stage === "run") {
        expect((error as Error).message).toBe(
          "The workspace files were restored, but the edited message was not sent.",
        );
      }
    }
  });

  test("reports restored files when P3 fails after restore", async () => {
    await expect(
      decorator({ confirm: () => true })(request(), async () => {
        throw new Error("omp stopped");
      }),
    ).rejects.toMatchObject({
      appError: {
        message:
          "The workspace files were restored, but the edited message was not sent. The edit could not be sent.",
      },
    });
  });
});

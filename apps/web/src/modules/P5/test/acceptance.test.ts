import {
  type CapabilityMap,
  EntryId,
  type ExternalChange,
  INVENTORY,
  NAMESPACE_OWNERSHIP,
  type SnapshotRecord,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { EditRequest } from "@/modules/P3/contract";
import { DESCRIPTORS } from "@/registry";
import { createRegistry } from "@/registry-core";
import {
  toRestorePlanView,
  toWorkspaceRestoreResultView,
  type WorkspaceRestoreResultView,
} from "../contract";
import { assertGuarantee } from "../contract/contract";
import { conversationForRestore, createConversationRestoreCoordinator } from "../conversation";
import { createDiffViewModel } from "../diff";
import { createEditResendDecorator, type EditResendConfirmation } from "../edit-resend/decorator";
import { createTemporaryWorkspace, type TemporaryWorkspace } from "../fixtures/temporary-workspace";
import { createRestorePlanViewModel } from "../restore";

function listing(record: SnapshotRecord) {
  const retention = {
    loadState: "ready" as const,
    limit: 100,
    retainedCount: 1,
    pinnedBaseline: null,
    prunedSnapshotIds: [],
    error: null,
  };
  return {
    snapshots: [
      {
        record,
        trigger: "prompt-boundary" as const,
        guarantee: record.guarantee,
        includedPaths: record.includedPaths,
        excludedPaths: record.excludedPaths,
        retention,
      },
    ],
    retention,
  };
}

/** Scripted test override: the fixture captures boundary snapshots, while policy tests need exact. */
function asExactSnapshot(snapshot: SnapshotRecord): SnapshotRecord {
  return { ...snapshot, guarantee: "exact" };
}

interface EditHarnessOptions {
  readonly capabilities?: CapabilityMap;
  readonly confirm?: (confirmation: EditResendConfirmation) => boolean | Promise<boolean>;
  /** Scripted override isolates the edit guard from A1.7's destructive plan policy. */
  readonly planRequiresConfirmation?: boolean;
  /** Scripted response override covers the decorator's incomplete-restore refusal branch. */
  readonly restoreResult?: (result: WorkspaceRestoreResultView) => WorkspaceRestoreResultView;
}

function createEditDecorator(
  workspace: TemporaryWorkspace,
  snapshot: SnapshotRecord,
  options: EditHarnessOptions = {},
) {
  return createEditResendDecorator({
    snapshots: { listSnapshots: async () => listing(snapshot) },
    checkpoint: {
      diff: (args) => workspace.store.diff(args),
      planRestore: async (args) => {
        const plan = await workspace.store.planRestore(args);
        return toRestorePlanView({
          ...plan,
          ...(options.planRequiresConfirmation === undefined
            ? {}
            : { requiresConfirmation: options.planRequiresConfirmation }),
        });
      },
      restore: async (args) => {
        const result = toWorkspaceRestoreResultView(await workspace.store.restore(args));
        return options.restoreResult?.(result) ?? result;
      },
    },
    workspace: workspace.folder,
    conversation: workspace.conversation,
    capabilities: options.capabilities ?? {},
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
}

function exactGuardOptions(
  confirm: (confirmation: EditResendConfirmation) => boolean | Promise<boolean>,
  planRequiresConfirmation = false,
): EditHarnessOptions {
  // These overrides isolate the exact guard from A1.7's boundary-only snapshots and destructive
  // plan policy.
  return {
    capabilities: { "upstream.tool-preflight": { state: "available", via: "upstream" } },
    confirm,
    planRequiresConfirmation,
  };
}

function editRequest(workspace: TemporaryWorkspace): EditRequest {
  return {
    source: {
      threadId: workspace.conversation.threadId,
      entryId: EntryId.parse("p5-edited-entry"),
      parentId: workspace.conversation.entryId,
      originalText: "Original",
      originalImages: [],
      sourceHeadId: null,
    },
    replacementText: "Replacement",
    replacementImages: [],
  };
}

describe("P5 W7 and CC9 acceptance", () => {
  test("the live central registry keeps T7 checkpoint/rewind rows and P5 claims no rows or namespaces", () => {
    const composed = createRegistry(DESCRIPTORS);
    const p5Descriptors = composed.descriptors.filter((descriptor) => descriptor.owner === "P5");
    const t7Rows = INVENTORY.filter((row) => row.group === "T7")
      .map((row) => row.id)
      .sort();
    const t7Claims = composed.descriptors
      .filter((descriptor) => descriptor.owner === "T7")
      .flatMap((descriptor) => descriptor.covers);
    const fallbackMatches = composed.descriptors.filter(
      (descriptor) =>
        descriptor.owner === "T7" &&
        descriptor.kind === "tool" &&
        descriptor.match.by === "fallback",
    );
    const expectedT7Rows = [
      "T7.checkpoint",
      "T7.goal",
      "T7.host-custom-mcp-tool-fallback",
      "T7.reject",
      "T7.resolve",
      "T7.rewind",
      "T7.security-scan",
      "T7.think",
    ];

    expect(p5Descriptors).toEqual([]);
    expect(t7Rows).toEqual([...expectedT7Rows].sort());
    expect(t7Rows.map((row) => t7Claims.filter((claim) => claim === row).length)).toEqual(
      t7Rows.map(() => 1),
    );
    expect(fallbackMatches.map((descriptor) => descriptor.id)).toEqual([
      "T7.host-custom-mcp-tool-fallback",
    ]);
    expect(
      NAMESPACE_OWNERSHIP.filter(
        (claim) =>
          (claim.status === "owned" && claim.owner === "P5") ||
          (claim.status === "contested" && claim.candidates.includes("P5")),
      ),
    ).toEqual([]);
  });

  test("exact restore requires upstream preflight", () => {
    expect(() => assertGuarantee("exact", {})).toThrowError(/upstream tool-preflight/);
    expect(() =>
      assertGuarantee("exact", {
        "upstream.tool-preflight": { state: "available", via: "upstream" },
      }),
    ).not.toThrow();
  });

  test("a real temporary workspace snapshot diffs, requires confirmation, restores files and exposes redo", async () => {
    const workspace = await createTemporaryWorkspace("restore");
    try {
      await workspace.write("src/app.ts", "before\n");
      const beforeHash = await workspace.hash("src/app.ts");
      const snapshot = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "manual",
      });
      expect(snapshot.includedPaths).toContainEqual(
        expect.objectContaining({ path: "src/app.ts", hash: beforeHash }),
      );

      await workspace.write("src/app.ts", "after\n");
      const onePathDiff = await workspace.store.diff({
        workspace: workspace.folder,
        snapshotId: snapshot.snapshotId,
      });
      expect(createDiffViewModel(onePathDiff).summary).toBe("1 changed path");
      await workspace.write("new.txt", "new file\n");
      const diff = await workspace.store.diff({
        workspace: workspace.folder,
        snapshotId: snapshot.snapshotId,
      });
      expect(diff.entries.map(({ path, change }) => [path, change])).toEqual([
        ["new.txt", "added"],
        ["src/app.ts", "modified"],
      ]);
      expect(createDiffViewModel(diff)).toMatchObject({ changedCount: 2 });
      expect(createDiffViewModel(diff).summary).toBe("2 changed paths");

      const plan = await workspace.store.planRestore({
        workspace: workspace.folder,
        operation: "files-only",
        snapshotId: snapshot.snapshotId,
        currentConversation: workspace.conversation,
        targetConversation: null,
        expectedWorkspaceHash: snapshot.workspaceHash,
      });
      const planView = toRestorePlanView(plan);
      expect(createRestorePlanViewModel(planView, {})).toMatchObject({
        operation: "files-only",
        requiresConfirmation: true,
        pathCount: 2,
      });
      expect((await workspace.read("src/app.ts")).toString()).toBe("after\n");
      await workspace.write("outside.txt", "external change\n");
      await expect(
        workspace.store.restore({ planId: plan.planId, confirmed: true }),
      ).rejects.toMatchObject({ appError: { code: "conflict" } });
      expect((await workspace.read("src/app.ts")).toString()).toBe("after\n");
      expect((await workspace.read("outside.txt")).toString()).toBe("external change\n");

      const retryPlan = await workspace.store.planRestore({
        workspace: workspace.folder,
        operation: "files-only",
        snapshotId: snapshot.snapshotId,
        currentConversation: workspace.conversation,
        targetConversation: null,
        expectedWorkspaceHash: snapshot.workspaceHash,
      });
      const restored = await workspace.store.restore({
        planId: retryPlan.planId,
        confirmed: true,
      });
      expect(restored).toMatchObject({
        filesRestored: true,
        conversationRestored: false,
        redoAvailable: true,
      });
      expect(restored.capturedPathCount).toBe(snapshot.includedPaths.length);
      expect((await workspace.read("src/app.ts")).toString()).toBe("before\n");
      await expect(workspace.read("new.txt")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(workspace.read("outside.txt")).rejects.toMatchObject({ code: "ENOENT" });
      expect(restored.undoSnapshotId).not.toBeNull();

      const redoPlan = await workspace.store.planRestore({
        workspace: workspace.folder,
        operation: "redo",
        snapshotId: restored.undoSnapshotId,
        currentConversation: workspace.conversation,
        targetConversation: null,
        expectedWorkspaceHash: snapshot.workspaceHash,
      });
      expect(redoPlan.requiresConfirmation).toBe(true);
      const redone = await workspace.store.restore({ planId: redoPlan.planId, confirmed: true });
      expect(redone.filesRestored).toBe(true);
      expect((await workspace.read("src/app.ts")).toString()).toBe("after\n");
      expect((await workspace.read("new.txt")).toString()).toBe("new file\n");
    } finally {
      await workspace.cleanup();
    }
  });

  test("a file restore without a snapshot leaves files unchanged and selects the requested conversation", async () => {
    const workspace = await createTemporaryWorkspace("missing-snapshot");
    try {
      await workspace.write("src/app.ts", "must stay\n");
      const target = {
        ...workspace.conversation,
        entryId: EntryId.parse("p5-missing-snapshot-target"),
      };
      const plan = await workspace.store.planRestore({
        workspace: workspace.folder,
        operation: "files-only",
        snapshotId: null,
        currentConversation: workspace.conversation,
        targetConversation: target,
        expectedWorkspaceHash: "",
      });
      expect(plan).toMatchObject({ capturedPathCount: 0, requiresConfirmation: false });

      const result = await workspace.store.restore({ planId: plan.planId, confirmed: true });
      expect(result).toMatchObject({
        filesRestored: false,
        capturedPathCount: 0,
        undoSnapshotId: null,
        redoAvailable: false,
        currentConversation: target,
      });
      expect((await workspace.read("src/app.ts")).toString()).toBe("must stay\n");
    } finally {
      await workspace.cleanup();
    }
  });

  test("conversation-only and both restore select the checkpoint head without conflating file-only restore", async () => {
    const workspace = await createTemporaryWorkspace("conversation");
    try {
      await workspace.write("state.txt", "checkpoint\n");
      const snapshot = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "manual",
      });
      await workspace.write("state.txt", "current\n");
      const target = {
        ...workspace.conversation,
        entryId: EntryId.parse("p5-target-entry"),
      };
      const conversationOnly = await workspace.store.planRestore({
        workspace: workspace.folder,
        operation: "conversation-only",
        snapshotId: snapshot.snapshotId,
        currentConversation: workspace.conversation,
        targetConversation: target,
        expectedWorkspaceHash: "",
      });
      const both = await workspace.store.planRestore({
        workspace: workspace.folder,
        operation: "both",
        snapshotId: snapshot.snapshotId,
        currentConversation: workspace.conversation,
        targetConversation: target,
        expectedWorkspaceHash: snapshot.workspaceHash,
      });
      expect(conversationOnly).toMatchObject({
        capturedPathCount: 1,
        destructive: false,
        requiresConfirmation: false,
      });
      expect(createRestorePlanViewModel(toRestorePlanView(conversationOnly), {})).toMatchObject({
        operation: "conversation-only",
        requiresConfirmation: false,
        pathCount: 1,
      });
      const conversationRestored = await workspace.store.restore({
        planId: conversationOnly.planId,
        confirmed: true,
      });
      expect(conversationRestored).toMatchObject({
        filesRestored: false,
        conversationRestored: true,
        currentConversation: target,
      });
      expect((await workspace.read("state.txt")).toString()).toBe("current\n");
      expect(both.requiresConfirmation).toBe(true);
      expect(conversationForRestore("files-only", workspace.conversation, target)).toEqual(
        workspace.conversation,
      );
      expect(conversationForRestore("conversation-only", workspace.conversation, target)).toEqual(
        target,
      );
      expect(conversationForRestore("both", workspace.conversation, target)).toEqual(target);
      expect(createRestorePlanViewModel(toRestorePlanView(both), {})).toMatchObject({
        operation: "both",
        requiresConfirmation: true,
        pathCount: 1,
      });
      const bothRestored = await workspace.store.restore({
        planId: both.planId,
        confirmed: true,
      });
      expect(bothRestored).toMatchObject({
        filesRestored: true,
        conversationRestored: false,
        currentConversation: workspace.conversation,
      });
      const branchCalls: Array<{ readonly entryId: typeof target.entryId }> = [];
      const coordinator = createConversationRestoreCoordinator({
        branch: async (request) => {
          branchCalls.push({ entryId: request.entryId });
          return {
            sourceThreadId: workspace.conversation.threadId,
            threadId: target.threadId,
            entryId: target.entryId,
            sessionFile: target.sessionFile,
            cancelled: false,
            reloaded: true,
            sourceRetained: true,
            wording: "conversation rewind" as const,
          };
        },
      });
      expect(() => conversationForRestore("both", workspace.conversation, null)).toThrow(
        /checkpoint conversation head/,
      );
      const rewound = await coordinator.restore({
        operation: "both",
        current: workspace.conversation,
        target,
      });
      expect(rewound).toMatchObject({
        restored: true,
        reloaded: true,
        current: target,
        wording: "conversation rewind",
      });
      expect(branchCalls).toEqual([{ entryId: target.entryId }]);
    } finally {
      await workspace.cleanup();
    }
  });

  test("edit-resend refuses an exact checkpoint when upstream preflight is unavailable", async () => {
    const workspace = await createTemporaryWorkspace("exact-unavailable");
    try {
      await workspace.write("src/app.ts", "unchanged\n");
      const saved = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      const exactSnapshot = asExactSnapshot(saved);
      const confirm = vi.fn(async () => true);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, exactSnapshot, { confirm });

      await expect(decorator(editRequest(workspace), send)).rejects.toMatchObject({
        appError: {
          code: "conflict",
          message: expect.stringMatching(/required pre-tool checkpoint/),
        },
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      await workspace.cleanup();
    }
  });

  test("exact unchanged checkpoint passes without prompting when upstream preflight is available", async () => {
    const workspace = await createTemporaryWorkspace("exact-unchanged");
    try {
      await workspace.write("src/app.ts", "unchanged\n");
      const saved = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      const exactSnapshot = asExactSnapshot(saved);
      const confirm = vi.fn(async () => false);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));

      const decorator = createEditDecorator(workspace, exactSnapshot, exactGuardOptions(confirm));
      await expect(decorator(editRequest(workspace), send)).resolves.toMatchObject({
        admitted: true,
        settled: true,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await workspace.cleanup();
    }
  });

  test("confirmed edit-resend restores changed files and sends exactly once", async () => {
    const workspace = await createTemporaryWorkspace("edit-resend-success");
    try {
      await workspace.write("src/app.ts", "before edit\n");
      const snapshot = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      await workspace.write("src/app.ts", "later change\n");
      const confirm = vi.fn(async () => true);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, snapshot, { confirm });

      await expect(decorator(editRequest(workspace), send)).resolves.toMatchObject({
        admitted: true,
        settled: true,
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await workspace.read("src/app.ts")).toString()).toBe("before edit\n");
    } finally {
      await workspace.cleanup();
    }
  });

  test("boundary checkpoints request confirmation even without workspace drift", async () => {
    const workspace = await createTemporaryWorkspace("boundary-confirmation");
    try {
      await workspace.write("src/app.ts", "unchanged\n");
      const snapshot = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      const confirm = vi.fn(async () => true);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, snapshot, {
        confirm,
        planRequiresConfirmation: false,
      });

      await expect(decorator(editRequest(workspace), send)).resolves.toMatchObject({
        admitted: true,
        settled: true,
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await workspace.cleanup();
    }
  });

  test("edit-resend honors the restore plan's confirmation requirement", async () => {
    const workspace = await createTemporaryWorkspace("plan-confirmation");
    try {
      await workspace.write("src/app.ts", "unchanged\n");
      const snapshot = asExactSnapshot(
        await workspace.store.snapshot({
          workspace: workspace.folder,
          conversation: workspace.conversation,
          source: "prompt-boundary",
        }),
      );
      const confirm = vi.fn(async () => false);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, snapshot, exactGuardOptions(confirm, true));

      await expect(decorator(editRequest(workspace), send)).rejects.toMatchObject({
        appError: {
          code: "conflict",
          message: expect.stringContaining("Workspace files were not restored"),
        },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await workspace.cleanup();
    }
  });

  test("edit-resend refuses an incomplete restore without a partial-failure result", async () => {
    const workspace = await createTemporaryWorkspace("incomplete-restore");
    try {
      await workspace.write("src/app.ts", "before edit\n");
      const snapshot = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      await workspace.write("src/app.ts", "later change\n");
      const confirm = vi.fn(async () => true);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, snapshot, {
        confirm,
        restoreResult: (result) => ({ ...result, filesRestored: false }),
      });

      await expect(decorator(editRequest(workspace), send)).rejects.toMatchObject({
        appError: {
          code: "conflict",
          message: expect.stringContaining("Workspace restore did not complete"),
        },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await workspace.cleanup();
    }
  });

  test("exact checkpoint hash drift prompts once and a declined confirmation prevents send", async () => {
    const workspace = await createTemporaryWorkspace("exact-drift");
    try {
      await workspace.write("src/app.ts", "before edit\n");
      const originalHash = await workspace.hash("src/app.ts");
      const saved = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      expect(saved.includedPaths).toContainEqual(
        expect.objectContaining({ path: "src/app.ts", hash: originalHash }),
      );
      const exactSnapshot = asExactSnapshot(saved);
      await workspace.write("src/app.ts", "later change\n");
      expect(await workspace.hash("src/app.ts")).not.toBe(originalHash);
      const confirm = vi.fn(async () => false);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, exactSnapshot, exactGuardOptions(confirm));

      await expect(decorator(editRequest(workspace), send)).rejects.toMatchObject({
        appError: { code: "conflict" },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect((await workspace.read("src/app.ts")).toString()).toBe("later change\n");
    } finally {
      await workspace.cleanup();
    }
  });

  test("external changes prompt even when the exact checkpoint files have not drifted", async () => {
    const workspace = await createTemporaryWorkspace("exact-external");
    try {
      await workspace.write("src/app.ts", "unchanged\n");
      const saved = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      const exactSnapshot = asExactSnapshot(saved);
      const externalChange: ExternalChange = {
        path: "config.local",
        change: "modified",
        expectedHash: "expected",
        actualHash: "observed",
      };
      workspace.setExternalChanges([externalChange]);
      const confirm = vi.fn(async () => false);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, exactSnapshot, exactGuardOptions(confirm));

      await expect(decorator(editRequest(workspace), send)).rejects.toMatchObject({
        appError: { code: "conflict" },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ externalChanges: [externalChange] }),
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      await workspace.cleanup();
    }
  });

  test("failed restore removes unwanted files, preserves changed files and refuses to send", async () => {
    const workspace = await createTemporaryWorkspace("edit-resend-failure");
    try {
      await workspace.write("src/app.ts", "before edit\n");
      const snapshot = await workspace.store.snapshot({
        workspace: workspace.folder,
        conversation: workspace.conversation,
        source: "prompt-boundary",
      });
      await workspace.write("src/app.ts", "later change\n");
      await workspace.write("new.txt", "unwanted file\n");
      const laterHash = await workspace.hash("src/app.ts");
      workspace.failNextRestoreAfterPathRemoval();
      const confirm = vi.fn(async () => true);
      const send = vi.fn(async () => ({
        threadId: ThreadId.parse("p5-temporary-workspace"),
        admitted: true,
        settled: true,
      }));
      const decorator = createEditDecorator(workspace, snapshot, { confirm });

      await expect(decorator(editRequest(workspace), send)).rejects.toMatchObject({
        appError: {
          code: "conflict",
          message: expect.stringContaining("shadow git failed: scripted read-tree failure"),
        },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(await workspace.hash("src/app.ts")).toBe(laterHash);
      expect((await workspace.read("src/app.ts")).toString()).toBe("later change\n");
      await expect(workspace.read("new.txt")).rejects.toMatchObject({ code: "ENOENT" });
      expect(workspace.lastRestoreResult()).toMatchObject({
        filesRestored: false,
        partialFailure: {
          message:
            "shadow git failed: scripted read-tree failure Changed paths: new.txt, src/app.ts.",
          rollbackAttempted: false,
          rollbackSucceeded: false,
        },
        undoSnapshotId: expect.any(String),
        redoAvailable: true,
        conversationRestored: false,
      });
    } finally {
      await workspace.cleanup();
    }
  });
});

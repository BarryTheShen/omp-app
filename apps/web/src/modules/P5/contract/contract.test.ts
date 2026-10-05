import { AppFailure, RestorePlan, RestoreResult, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  assertGuarantee,
  assertNoP5InventoryClaims,
  asWorkspaceRestoreFailure,
  CONVERSATION_REWIND_LABEL,
  canClaimExact,
  P5_INVENTORY_COVERS,
  RESTORE_OPERATION_MATRIX,
  toRestorePlanView,
  toWorkspaceRestoreResultView,
  WORKSPACE_EXACT_CAPABILITY,
  WORKSPACE_RESTORE_LABEL,
  WorkspaceRestoreGuaranteeSchema,
} from ".";

const conversation = {
  threadId: ThreadId.parse("p5-thread"),
  sessionFile: null,
  entryId: null,
};

function plan(operation: "files-only" | "conversation-only" | "both") {
  return RestorePlan.parse({
    planId: `restore-${operation}`,
    workspace: "/workspace",
    operation,
    snapshotId: null,
    currentConversation: conversation,
    targetConversation: null,
    currentWorkspaceHash: "hash-current",
    targetWorkspaceHash: null,
    includedPaths: [],
    excludedPaths: [],
    externalChanges: [],
    capturedPathCount: 0,
    snapshotGuarantee: "boundary",
    destructive: operation !== "conversation-only",
    requiresConfirmation: operation !== "conversation-only",
  });
}

describe("P5 workspace restore contract", () => {
  test("defines the operation matrix with explicit wording and undo axis", () => {
    expect(RESTORE_OPERATION_MATRIX["files-only"]).toMatchObject({
      wording: WORKSPACE_RESTORE_LABEL,
      axis: "workspace",
      confirmation: "conditional",
      undo: "pre-restore",
      restoresWorkspace: true,
    });
    expect(RESTORE_OPERATION_MATRIX["conversation-only"]).toMatchObject({
      wording: CONVERSATION_REWIND_LABEL,
      axis: "conversation",
      undo: "conversation-head",
      restoresWorkspace: false,
    });
    expect(RESTORE_OPERATION_MATRIX.both.undo).toBe("pre-restore");
    expect(RESTORE_OPERATION_MATRIX.redo.undo).toBe("pre-restore");
    expect(RESTORE_OPERATION_MATRIX["edit-resend"].confirmation).toBe("required");
  });

  test("wraps A1 plans/results without changing their authoritative fields", () => {
    const planView = toRestorePlanView(plan("files-only"));
    expect(planView).toMatchObject({
      wording: WORKSPACE_RESTORE_LABEL,
      workspaceGuarantee: "boundary",
      noInventoryClaim: true,
      confirmation: { operation: "files-only", confirmed: false },
    });
    const result = RestoreResult.parse({
      planId: planView.planId,
      operation: "files-only",
      filesRestored: true,
      conversationRestored: false,
      capturedPathCount: 0,
      excludedPaths: [".git"],
      snapshotGuarantee: "boundary",
      externalChanges: [],
      partialFailure: null,
      previousConversation: conversation,
      currentConversation: conversation,
      undoSnapshotId: "snapshot-undo",
      redoAvailable: true,
    });
    expect(toWorkspaceRestoreResultView(result)).toMatchObject({
      wording: WORKSPACE_RESTORE_LABEL,
      workspaceGuarantee: "boundary",
      undoSnapshotId: "snapshot-undo",
      noInventoryClaim: true,
    });
  });

  test("gates exact guarantees and proves P5 has no inventory rows", () => {
    expect(P5_INVENTORY_COVERS).toEqual([]);
    expect(assertNoP5InventoryClaims()).toBe(true);
    expect(() => assertNoP5InventoryClaims(["T7.checkpoint"])).toThrow(AppFailure);
    expect(canClaimExact({})).toBe(false);
    expect(
      canClaimExact({
        [WORKSPACE_EXACT_CAPABILITY]: { state: "available", via: "upstream" } as const,
      }),
    ).toBe(true);
    expect(() => assertGuarantee("exact", {})).toThrow(AppFailure);
    expect(() => WorkspaceRestoreGuaranteeSchema.parse("exact")).not.toThrow();
  });

  test("preserves typed AppFailure and wraps unknown failures safely", () => {
    const original = new AppFailure({ code: "conflict", message: "changed", retryable: true });
    expect(asWorkspaceRestoreFailure(original)).toBe(original);
    expect(asWorkspaceRestoreFailure(new Error("broken")).appError.code).toBe("internal");
  });
});

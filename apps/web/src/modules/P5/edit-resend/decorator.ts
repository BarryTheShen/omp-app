import type {
  CapabilityMap,
  CheckpointDiff,
  ConversationHead,
  ExternalChange,
  FolderPath,
  RestorePlan,
  SnapshotRecord,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { EditRequest, EditRunDecorator, EditRunResult } from "@/modules/P3/contract";
import { asWorkspaceRestoreFailure } from "../contract";
import type {
  CheckpointController,
  WorkspaceRestoreGuarantee,
  WorkspaceRestoreResultView,
} from "../contract/contract";
import type { SnapshotListing } from "../snapshots";
import { createEditResendGuard, editResendConflict, editResendSnapshotMatches } from "./guard";

export interface EditResendSnapshotSource {
  listSnapshots(options?: { readonly signal?: AbortSignal }): Promise<SnapshotListing>;
}

export interface EditResendConfirmation {
  readonly snapshot: SnapshotRecord;
  readonly diff: CheckpointDiff;
  readonly plan: RestorePlan;
  readonly externalChanges: readonly ExternalChange[];
  readonly guarantee: WorkspaceRestoreGuarantee;
}

export interface EditResendDecoratorOptions {
  readonly snapshots: EditResendSnapshotSource;
  readonly checkpoint: Pick<CheckpointController, "diff" | "planRestore" | "restore">;
  readonly workspace: FolderPath;
  readonly conversation: ConversationHead | (() => ConversationHead);
  readonly capabilities?: CapabilityMap;
  /** U4 supplies this callback. Returning false keeps the source branch and draft untouched. */
  readonly confirm?: (request: EditResendConfirmation) => Promise<boolean> | boolean;
}

function currentConversation(value: ConversationHead | (() => ConversationHead)): ConversationHead {
  return typeof value === "function" ? value() : value;
}

function cancelledBeforeSend(): AppFailure {
  return new AppFailure({
    code: "cancelled",
    message: "The workspace restore was cancelled before the edit was sent.",
    retryable: false,
  });
}

function cancelledAfterRestore(): AppFailure {
  return new AppFailure({
    code: "cancelled",
    message: "The workspace files were restored, but the edited message was not sent.",
    retryable: false,
  });
}

function checkCancelled(signal: AbortSignal | undefined, restored = false): void {
  if (!signal?.aborted) return;
  if (restored) throw cancelledAfterRestore();
  throw cancelledBeforeSend();
}

function runAfterRestoreFailure(error: unknown): AppFailure {
  const appError =
    error instanceof AppFailure
      ? error.appError
      : { code: "internal" as const, message: "The edit could not be sent.", retryable: true };
  return new AppFailure(
    {
      ...appError,
      message: `The workspace files were restored, but the edited message was not sent. ${appError.message}`,
    },
    { cause: error },
  );
}

function latestPrePromptSnapshot(
  listing: SnapshotListing,
  request: EditRequest,
): SnapshotRecord | null {
  const candidates = listing.snapshots
    .map((snapshot) => snapshot.record)
    .filter((snapshot) =>
      editResendSnapshotMatches(
        snapshot,
        String(request.source.threadId),
        request.source.parentId === null ? null : String(request.source.parentId),
      ),
    );
  candidates.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  return candidates[0] ?? null;
}

function externalPaths(changes: readonly ExternalChange[]): readonly string[] {
  return changes.map((change) => change.path);
}

function planExternalChanges(diff: CheckpointDiff, plan: RestorePlan): readonly ExternalChange[] {
  return plan.externalChanges.length > 0 ? plan.externalChanges : diff.externalChanges;
}

/**
 * P5's composition-time decorator. It performs a typed, server-owned workspace restore first;
 * only a successful restore allows P3/R0 to branch and submit the replacement once.
 */
export function createEditResendDecorator(options: EditResendDecoratorOptions): EditRunDecorator {
  const guard = createEditResendGuard();
  return async (request, run): Promise<EditRunResult> => {
    checkCancelled(request.signal);
    let snapshot: SnapshotRecord | null;
    try {
      snapshot = latestPrePromptSnapshot(
        await options.snapshots.listSnapshots({ signal: request.signal }),
        request,
      );
      checkCancelled(request.signal);
    } catch (error) {
      throw asWorkspaceRestoreFailure(
        error,
        "The pre-prompt workspace restore point could not be loaded",
      );
    }
    if (snapshot === null) {
      throw new AppFailure({
        code: "not_found",
        message:
          "No workspace restore point was captured before this message, so its files were left unchanged.",
        retryable: false,
      });
    }

    let diff: CheckpointDiff;
    try {
      diff = await options.checkpoint.diff({
        workspace: options.workspace,
        snapshotId: snapshot.snapshotId,
      });
      checkCancelled(request.signal);
    } catch (error) {
      throw asWorkspaceRestoreFailure(
        error,
        "The pre-prompt workspace changes could not be checked",
      );
    }

    const decision = guard.evaluate({
      snapshot,
      currentWorkspaceHash: diff.currentWorkspaceHash,
      capabilities: options.capabilities ?? {},
    });
    if (!decision.allowed) throw editResendConflict(decision.reason);

    let plan: RestorePlan;
    try {
      plan = await options.checkpoint.planRestore({
        workspace: options.workspace,
        operation: "edit-resend",
        snapshotId: snapshot.snapshotId,
        currentConversation: currentConversation(options.conversation),
        targetConversation: null,
        expectedWorkspaceHash: diff.currentWorkspaceHash,
      });
      checkCancelled(request.signal);
    } catch (error) {
      throw asWorkspaceRestoreFailure(
        error,
        "The edit-resend workspace restore could not be planned",
      );
    }

    const changes = planExternalChanges(diff, plan);
    const needsConfirmation =
      decision.requiresConfirmation || plan.requiresConfirmation || changes.length > 0;
    if (needsConfirmation) {
      if (options.confirm === undefined) {
        throw editResendConflict(
          changes.length > 0
            ? `These files changed after the message was sent: ${externalPaths(changes).join(", ")}. Restoring the workspace will replace those changes, so confirmation is required.`
            : "Restoring the workspace before sending this message needs confirmation.",
        );
      }
      const confirmed = await options.confirm({
        snapshot,
        diff,
        plan,
        externalChanges: changes,
        guarantee: decision.guarantee,
      });
      checkCancelled(request.signal);
      if (!confirmed)
        throw editResendConflict("Workspace files were not restored, so the message was not sent.");
    }

    let restored: WorkspaceRestoreResultView;
    try {
      restored = await options.checkpoint.restore({ planId: plan.planId, confirmed: true });
      checkCancelled(request.signal, true);
    } catch (error) {
      throw asWorkspaceRestoreFailure(error, "The pre-prompt workspace restore failed");
    }
    if (restored.partialFailure !== null) {
      throw editResendConflict(
        `Workspace restore was incomplete; the message was not sent: ${restored.partialFailure.message}`,
      );
    }
    if (!restored.filesRestored) {
      throw editResendConflict("Workspace restore did not complete, so the message was not sent.");
    }

    try {
      const result = await run(request);
      checkCancelled(request.signal, true);
      return {
        ...result,
        workspaceGuarantee: restored.workspaceGuarantee,
        externalChanges: externalPaths(restored.externalChanges),
      };
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "cancelled") {
        throw error;
      }
      throw runAfterRestoreFailure(error);
    }
  };
}

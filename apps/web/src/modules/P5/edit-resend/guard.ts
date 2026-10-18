import type { SnapshotRecord } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
/**
 * omp v18.9.1's checkpoint tool records in-memory message/session state, not workspace files
 * (`packages/coding-agent/src/tools/checkpoint.ts:14-23,53-97`); the app-owned checkpoint
 * capability is therefore the only source of workspace rollback semantics here.
 */
import {
  canClaimExact,
  type EditResendGuard,
  type EditResendGuardInput,
  type EditResendGuardResult,
} from "../contract";

/**
 * Checks whether the checkpoint can be used before P3 branches the conversation.
 * A boundary checkpoint always needs an explicit policy decision. An exact checkpoint
 * only needs one when the included workspace hash has changed since capture.
 */
export function evaluateEditResendGuard(input: EditResendGuardInput): EditResendGuardResult {
  const { snapshot, currentWorkspaceHash, capabilities } = input;
  if (snapshot.guarantee === "exact" && !canClaimExact(capabilities)) {
    return {
      allowed: false,
      reason:
        "This exact workspace restore point is unavailable because omp lacks the required pre-tool checkpoint.",
      externalChanges: [],
    };
  }
  const changed = snapshot.workspaceHash !== currentWorkspaceHash;
  return {
    allowed: true,
    requiresConfirmation: snapshot.guarantee === "boundary" || changed,
    guarantee: snapshot.guarantee,
    externalChanges: [],
  };
}

export function createEditResendGuard(): EditResendGuard {
  return { evaluate: evaluateEditResendGuard };
}

export function editResendConflict(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: true });
}

export function editResendSnapshotMatches(
  snapshot: SnapshotRecord,
  threadId: string,
  parentId: string | null,
): boolean {
  return (
    snapshot.source === "prompt-boundary" &&
    snapshot.ompSessionId === threadId &&
    snapshot.entryId === parentId
  );
}

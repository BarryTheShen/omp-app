import type {
  AppError,
  CapabilityKey,
  CapabilityMap,
  CheckpointDiff,
  CheckpointSnapshotArgs,
  ConversationHead,
  EntryId,
  ExternalChange,
  FolderPath,
  RestoreOperation,
  RestorePlan,
  RestoreResult,
  SnapshotId,
  SnapshotRecord,
} from "@omp-app/contracts";
import {
  AppFailure,
  type CheckpointSnapshotArgs as CheckpointSnapshotArgsSchema,
  RestoreOperation as RestoreOperationSchema,
  RestorePlan as RestorePlanSchema,
  RestoreResult as RestoreResultSchema,
} from "@omp-app/contracts";
import { z } from "zod";

/** P5 intentionally claims no inventory rows; T7 owns checkpoint/rewind presentation. */
export const P5_INVENTORY_COVERS = [] as const;
export type P5InventoryId = (typeof P5_INVENTORY_COVERS)[number];

export const WORKSPACE_RESTORE_LABEL = "workspace restore" as const;
export const CONVERSATION_REWIND_LABEL = "conversation rewind" as const;
export const WORKSPACE_EXACT_CAPABILITY: CapabilityKey = "upstream.tool-preflight";

export const WorkspaceRestoreGuaranteeSchema = z.enum(["not-managed", "boundary", "exact"]);
export type WorkspaceRestoreGuarantee = z.infer<typeof WorkspaceRestoreGuaranteeSchema>;

export const RestoreChoiceSchema = z.strictObject({
  operation: RestoreOperationSchema,
  confirmed: z.boolean(),
  wording: z.enum([WORKSPACE_RESTORE_LABEL, CONVERSATION_REWIND_LABEL]),
  guarantee: WorkspaceRestoreGuaranteeSchema,
});
export type RestoreChoice = z.infer<typeof RestoreChoiceSchema>;

export interface RestoreOperationRule {
  readonly axis: "workspace" | "conversation" | "both";
  readonly wording: typeof WORKSPACE_RESTORE_LABEL | typeof CONVERSATION_REWIND_LABEL;
  readonly confirmation: "conditional" | "required";
  readonly undo: "pre-restore" | "conversation-head";
  readonly restoresWorkspace: boolean;
}

export const RESTORE_OPERATION_MATRIX: Readonly<Record<RestoreOperation, RestoreOperationRule>> = {
  "files-only": {
    axis: "workspace",
    wording: WORKSPACE_RESTORE_LABEL,
    confirmation: "conditional",
    undo: "pre-restore",
    restoresWorkspace: true,
  },
  "conversation-only": {
    axis: "conversation",
    wording: CONVERSATION_REWIND_LABEL,
    confirmation: "required",
    undo: "conversation-head",
    restoresWorkspace: false,
  },
  both: {
    axis: "both",
    wording: WORKSPACE_RESTORE_LABEL,
    confirmation: "required",
    undo: "pre-restore",
    restoresWorkspace: true,
  },
  redo: {
    axis: "both",
    wording: WORKSPACE_RESTORE_LABEL,
    confirmation: "required",
    undo: "pre-restore",
    restoresWorkspace: true,
  },
  "edit-resend": {
    axis: "both",
    wording: WORKSPACE_RESTORE_LABEL,
    confirmation: "required",
    undo: "pre-restore",
    restoresWorkspace: true,
  },
};

export const RestorePlanViewSchema = RestorePlanSchema.extend({
  wording: z.enum([WORKSPACE_RESTORE_LABEL, CONVERSATION_REWIND_LABEL]),
  workspaceGuarantee: WorkspaceRestoreGuaranteeSchema,
  confirmation: RestoreChoiceSchema,
  noInventoryClaim: z.literal(true),
});
export type RestorePlanView = z.infer<typeof RestorePlanViewSchema>;

export const WorkspaceRestoreResultViewSchema = RestoreResultSchema.extend({
  wording: z.enum([WORKSPACE_RESTORE_LABEL, CONVERSATION_REWIND_LABEL]),
  workspaceGuarantee: WorkspaceRestoreGuaranteeSchema,
  noInventoryClaim: z.literal(true),
});
export type WorkspaceRestoreResultView = z.infer<typeof WorkspaceRestoreResultViewSchema>;

export interface DiffPort {
  diff(args: {
    readonly workspace: FolderPath;
    readonly snapshotId: SnapshotId;
  }): Promise<CheckpointDiff>;
}

export interface CheckpointController extends DiffPort {
  snapshot(args: z.infer<typeof CheckpointSnapshotArgsSchema>): Promise<SnapshotRecord>;
  planRestore(args: {
    readonly workspace: FolderPath;
    readonly operation: RestoreOperation;
    readonly snapshotId: SnapshotId | null;
    readonly currentConversation: ConversationHead;
    readonly targetConversation: ConversationHead | null;
    readonly expectedWorkspaceHash: string;
  }): Promise<RestorePlanView>;
  restore(args: {
    readonly planId: string;
    readonly confirmed: true;
  }): Promise<WorkspaceRestoreResultView>;
}

export interface EditResendGuardInput {
  readonly snapshot: SnapshotRecord;
  readonly currentWorkspaceHash: string;
  readonly capabilities: CapabilityMap;
}

export const EditResendGuardResultSchema = z.discriminatedUnion("allowed", [
  z.strictObject({
    allowed: z.literal(true),
    requiresConfirmation: z.boolean(),
    guarantee: WorkspaceRestoreGuaranteeSchema,
    externalChanges: z.array(z.unknown()),
  }),
  z.strictObject({
    allowed: z.literal(false),
    reason: z.string().min(1),
    externalChanges: z.array(z.unknown()),
  }),
]);
export type EditResendGuardResult = z.infer<typeof EditResendGuardResultSchema>;

export interface EditResendGuard {
  evaluate(input: EditResendGuardInput): EditResendGuardResult;
}

export function operationWording(
  operation: RestoreOperation,
): typeof WORKSPACE_RESTORE_LABEL | typeof CONVERSATION_REWIND_LABEL {
  return RESTORE_OPERATION_MATRIX[operation].wording;
}

export function toRestorePlanView(plan: RestorePlan): RestorePlanView {
  const rule = RESTORE_OPERATION_MATRIX[plan.operation];
  return RestorePlanViewSchema.parse({
    ...plan,
    wording: rule.wording,
    workspaceGuarantee: plan.snapshotGuarantee,
    confirmation: {
      operation: plan.operation,
      confirmed: false,
      wording: rule.wording,
      guarantee: plan.snapshotGuarantee,
    },
    noInventoryClaim: true,
  });
}

export function toWorkspaceRestoreResultView(result: RestoreResult): WorkspaceRestoreResultView {
  return WorkspaceRestoreResultViewSchema.parse({
    ...result,
    wording: operationWording(result.operation),
    workspaceGuarantee: result.snapshotGuarantee,
    noInventoryClaim: true,
  });
}

export function canClaimExact(capabilities: CapabilityMap): boolean {
  return capabilities[WORKSPACE_EXACT_CAPABILITY]?.state === "available";
}

export function assertGuarantee(
  guarantee: WorkspaceRestoreGuarantee,
  capabilities: CapabilityMap,
): void {
  if (guarantee === "exact" && !canClaimExact(capabilities)) {
    throw new AppFailure({
      code: "unavailable",
      message: "Exact workspace restore requires the upstream tool-preflight capability",
      retryable: false,
      capability: WORKSPACE_EXACT_CAPABILITY,
    });
  }
}

export function assertNoP5InventoryClaims(ids: readonly string[] = []): true {
  if (ids.length > 0) {
    throw new AppFailure({
      code: "invalid_args",
      message: "P5 does not own inventory rows; checkpoint and rewind presentation remain with T7",
      retryable: false,
    });
  }
  return true;
}

export function asWorkspaceRestoreFailure(
  error: unknown,
  fallback = "The workspace restore failed",
): AppFailure {
  if (error instanceof AppFailure) return error;
  const appError: AppError = {
    code: "internal",
    message: error instanceof Error ? error.message : fallback,
    retryable: true,
  };
  return new AppFailure(appError, { cause: error });
}

export type {
  CheckpointDiff,
  CheckpointSnapshotArgs,
  ConversationHead,
  EntryId,
  ExternalChange,
  RestoreOperation,
  RestorePlan,
  RestoreResult,
  SnapshotId,
  SnapshotRecord,
};

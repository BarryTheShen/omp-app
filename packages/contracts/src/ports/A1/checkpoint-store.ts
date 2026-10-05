import { z } from "zod";
import { definePort } from "../../core/envelope";
import { EntryId, FolderPath, SessionFilePath, ThreadId } from "../../core/ids";
import {
  ConversationHead,
  Cursor,
  PathText,
  RestoreOperation,
  Revision,
  SnapshotGuarantee,
  Timestamp,
} from "./shared";

export const SnapshotId = z.string().min(1).brand<"SnapshotId">();
export type SnapshotId = z.infer<typeof SnapshotId>;

export const RestorePlanId = z.string().min(1).brand<"RestorePlanId">();
export type RestorePlanId = z.infer<typeof RestorePlanId>;

export const SnapshotSource = z.enum(["prompt-boundary", "manual", "pretool-hook"]);
export type SnapshotSource = z.infer<typeof SnapshotSource>;

export const SnapshotPathKind = z.enum(["file", "directory", "symlink"]);
export type SnapshotPathKind = z.infer<typeof SnapshotPathKind>;

/** One included path in the shadow-git manifest. */
export const SnapshotPath = z.strictObject({
  path: PathText,
  kind: SnapshotPathKind,
  mode: z.int().min(0).optional(),
  hash: z.string().min(1).optional(),
  sizeBytes: z.int().nonnegative().optional(),
});
export type SnapshotPath = z.infer<typeof SnapshotPath>;

export const ExcludedPath = z.strictObject({
  path: PathText,
  reason: z.string().min(1),
});
export type ExcludedPath = z.infer<typeof ExcludedPath>;

/** A durable mapping between one shadow-git tree and one conversation point. */
export const SnapshotRecord = z.strictObject({
  snapshotId: SnapshotId,
  workspaceKey: z.string().min(1),
  ompSessionId: ThreadId,
  sessionFile: SessionFilePath.nullable(),
  entryId: EntryId.nullable(),
  capturedAt: Timestamp,
  parentSnapshotId: SnapshotId.nullable(),
  source: SnapshotSource,
  includedPaths: z.array(SnapshotPath),
  excludedPaths: z.array(ExcludedPath),
  shadowTreeId: z.string().min(1),
  workspaceHash: Revision,
  guarantee: SnapshotGuarantee,
  pinned: z.boolean(),
});
export type SnapshotRecord = z.infer<typeof SnapshotRecord>;

export const CheckpointSnapshotArgs = z.strictObject({
  workspace: FolderPath,
  conversation: ConversationHead,
  source: SnapshotSource,
  pinned: z.boolean().optional(),
});
export type CheckpointSnapshotArgs = z.infer<typeof CheckpointSnapshotArgs>;

export const CheckpointListArgs = z.strictObject({
  workspace: FolderPath,
  threadId: ThreadId.optional(),
  cursor: Cursor.optional(),
  limit: z.int().min(1).max(100).optional(),
});
export type CheckpointListArgs = z.infer<typeof CheckpointListArgs>;

export const CheckpointListResult = z.strictObject({
  snapshots: z.array(SnapshotRecord),
  nextCursor: Cursor.nullable(),
  pinnedBaseline: SnapshotId.nullable(),
});
export type CheckpointListResult = z.infer<typeof CheckpointListResult>;

export const DiffChange = z.enum(["added", "deleted", "modified", "mode-changed"]);
export type DiffChange = z.infer<typeof DiffChange>;

export const DiffEntry = z.strictObject({
  path: PathText,
  change: DiffChange,
  beforeHash: z.string().min(1).nullable(),
  afterHash: z.string().min(1).nullable(),
  beforeMode: z.int().min(0).nullable(),
  afterMode: z.int().min(0).nullable(),
});
export type DiffEntry = z.infer<typeof DiffEntry>;

export const ExternalChange = z.strictObject({
  path: PathText,
  change: z.enum(["added", "deleted", "modified", "mode-changed"]),
  expectedHash: z.string().min(1).nullable(),
  actualHash: z.string().min(1).nullable(),
});
export type ExternalChange = z.infer<typeof ExternalChange>;

export const CheckpointDiff = z.strictObject({
  snapshotId: SnapshotId,
  workspace: FolderPath,
  entries: z.array(DiffEntry),
  excludedPaths: z.array(ExcludedPath),
  externalChanges: z.array(ExternalChange),
  currentWorkspaceHash: Revision,
  snapshotWorkspaceHash: Revision,
});
export type CheckpointDiff = z.infer<typeof CheckpointDiff>;

export const RestorePlan = z.strictObject({
  planId: RestorePlanId,
  workspace: FolderPath,
  operation: RestoreOperation,
  snapshotId: SnapshotId.nullable(),
  currentConversation: ConversationHead,
  targetConversation: ConversationHead.nullable(),
  currentWorkspaceHash: Revision,
  targetWorkspaceHash: Revision.nullable(),
  includedPaths: z.array(SnapshotPath),
  excludedPaths: z.array(ExcludedPath),
  externalChanges: z.array(ExternalChange),
  capturedPathCount: z.int().nonnegative(),
  snapshotGuarantee: SnapshotGuarantee,
  destructive: z.boolean(),
  requiresConfirmation: z.boolean(),
});
export type RestorePlan = z.infer<typeof RestorePlan>;

export const PartialFailure = z.strictObject({
  stage: z.enum(["files", "conversation", "rollback"]),
  message: z.string().min(1),
  rollbackAttempted: z.boolean(),
  rollbackSucceeded: z.boolean(),
});
export type PartialFailure = z.infer<typeof PartialFailure>;

/** Transaction outcome; all divergence and rollback state is explicit for the UI. */
export const RestoreResult = z.strictObject({
  planId: RestorePlanId,
  operation: RestoreOperation,
  filesRestored: z.boolean(),
  conversationRestored: z.boolean(),
  capturedPathCount: z.int().nonnegative(),
  excludedPaths: z.array(PathText),
  snapshotGuarantee: SnapshotGuarantee,
  externalChanges: z.array(ExternalChange),
  partialFailure: PartialFailure.nullable(),
  previousConversation: ConversationHead,
  currentConversation: ConversationHead,
  undoSnapshotId: SnapshotId.nullable(),
  redoAvailable: z.boolean(),
});
export type RestoreResult = z.infer<typeof RestoreResult>;

export const RestoreArgs = z.strictObject({
  planId: RestorePlanId,
  /** Destructive restores cannot be dispatched without explicit confirmation. */
  confirmed: z.literal(true),
});
export type RestoreArgs = z.infer<typeof RestoreArgs>;

export const CheckpointChanged = z.strictObject({
  workspace: FolderPath,
  snapshotId: SnapshotId,
  kind: z.enum(["created", "removed", "restored"]),
});
export type CheckpointChanged = z.infer<typeof CheckpointChanged>;

export const CheckpointStore = definePort({
  name: "A1.checkpointStore",
  methods: {
    snapshot: {
      args: CheckpointSnapshotArgs,
      result: SnapshotRecord,
      capability: "host.checkpoints",
    },
    list: {
      args: CheckpointListArgs,
      result: CheckpointListResult,
      capability: "host.checkpoints",
    },
    diff: {
      args: z.strictObject({ workspace: FolderPath, snapshotId: SnapshotId }),
      result: CheckpointDiff,
      capability: "host.checkpoints",
    },
    planRestore: {
      args: z.strictObject({
        workspace: FolderPath,
        operation: RestoreOperation,
        snapshotId: SnapshotId.nullable(),
        currentConversation: ConversationHead,
        targetConversation: ConversationHead.nullable(),
        expectedWorkspaceHash: Revision,
      }),
      result: RestorePlan,
      capability: "host.checkpoints",
    },
    restore: {
      args: RestoreArgs,
      result: RestoreResult,
      capability: "host.checkpoints",
    },
  },
  events: {
    changed: {
      payload: CheckpointChanged,
      capability: "host.checkpoints",
    },
  },
});

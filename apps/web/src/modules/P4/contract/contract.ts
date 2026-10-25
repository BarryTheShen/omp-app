import type {
  AppError,
  CapabilityKey,
  EntryId,
  SessionEntryHead,
  SessionFilePath,
  ThreadId,
} from "@omp-app/contracts";
import {
  AppFailure,
  EntryId as EntryIdSchema,
  SessionEntryHead as SessionEntryHeadSchema,
  SessionFilePath as SessionFilePathSchema,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { z } from "zod";

/** The nine durable-tree inventory rows owned by P4; P3's two assistant-ui rows are excluded. */
export const P4_INVENTORY_COVERS = [
  "P3.branch",
  "P3.fork",
  "P3.get-entries",
  "P3.get-tree",
  "P3.tree",
  "P3.tree-selector",
  "P3.app-session-tree",
  "P3.app-tree-foldorup",
  "P3.app-tree-unfoldordown",
] as const;
export type P4InventoryId = (typeof P4_INVENTORY_COVERS)[number];

export interface EntryCursor {
  readonly threadId: ThreadId;
  readonly entries: readonly SessionEntryHead[];
  readonly leafId: EntryId | null;
  readonly nextSince?: EntryId;
}

export const EntryCursorSchema = z.strictObject({
  threadId: ThreadIdSchema,
  entries: z.array(SessionEntryHeadSchema),
  leafId: EntryIdSchema.nullable(),
  nextSince: EntryIdSchema.optional(),
});

/** Labels are display-only at omp v18.12.6, which has no RPC command that sets one; no mutation port exists. */
export interface ReadOnlyTreeLabel {
  readonly targetId: EntryId;
  readonly text: string | null;
  readonly editable: false;
  readonly disabledReason: string;
}

export const ReadOnlyTreeLabelSchema = z.strictObject({
  targetId: EntryIdSchema,
  text: z.string().nullable(),
  editable: z.literal(false),
  disabledReason: z.string().min(1),
});

export interface TreeNode {
  readonly entry: SessionEntryHead;
  readonly children: readonly TreeNode[];
  readonly label?: ReadOnlyTreeLabel;
  /** Open fields are retained so future entry kinds are not discarded. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.strictObject({
    entry: SessionEntryHeadSchema,
    children: z.array(TreeNodeSchema),
    label: ReadOnlyTreeLabelSchema.optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  }),
);

export interface TreeSnapshot {
  readonly threadId: ThreadId;
  readonly sessionFile: SessionFilePath | null;
  readonly tree: readonly TreeNode[];
  readonly leafId: EntryId | null;
  readonly labels: readonly ReadOnlyTreeLabel[];
  readonly labelsCapability: "available" | "unavailable";
}

export const TreeSnapshotSchema = z.strictObject({
  threadId: ThreadIdSchema,
  sessionFile: SessionFilePathSchema.nullable(),
  tree: z.array(TreeNodeSchema),
  leafId: EntryIdSchema.nullable(),
  labels: z.array(ReadOnlyTreeLabelSchema),
  labelsCapability: z.enum(["available", "unavailable"]),
});

export interface SessionTreePort {
  load(threadId: ThreadId, signal?: AbortSignal): Promise<EntryCursor>;
  loadAfter(threadId: ThreadId, since: EntryId, signal?: AbortSignal): Promise<EntryCursor>;
  readTree(threadId: ThreadId, signal?: AbortSignal): Promise<TreeSnapshot>;
  subscribe(threadId: ThreadId, listener: (snapshot: TreeSnapshot) => void): () => void;
}

export interface ForkRequest {
  readonly threadId: ThreadId;
  readonly entryId?: EntryId;
  readonly signal?: AbortSignal;
}

export interface BranchRequest {
  readonly threadId: ThreadId;
  readonly entryId: EntryId;
  readonly signal?: AbortSignal;
}

export interface ForkResult {
  readonly sourceThreadId: ThreadId;
  readonly threadId: ThreadId;
  readonly entryId: EntryId | null;
  readonly sessionFile: SessionFilePath | null;
  readonly cancelled: boolean;
  readonly reloaded: boolean;
  readonly sourceRetained: true;
}

export interface ConversationBranchResult extends ForkResult {
  readonly wording: "conversation rewind";
}

export interface ForkPort {
  fork(request: ForkRequest): Promise<ForkResult>;
  branch(request: BranchRequest): Promise<ConversationBranchResult>;
}

export const TreeSelectorFilterSchema = z.strictObject({
  query: z.string().max(512).default(""),
  showLabels: z.boolean().default(true),
});
export type TreeSelectorFilter = z.infer<typeof TreeSelectorFilterSchema>;

export interface TreeSelectorState {
  readonly threadId: ThreadId;
  readonly filter: TreeSelectorFilter;
  readonly selectedEntryId: EntryId | null;
  readonly leafId: EntryId | null;
  readonly isLoading: boolean;
  readonly error: AppError | null;
}

export const TREE_LABEL_CAPABILITY: CapabilityKey = "upstream.session-labels";
export const CONVERSATION_REWIND_LABEL = "conversation rewind" as const;
export const CONVERSATION_FORK_LABEL = "conversation fork" as const;

export function asTreeFailure(
  error: unknown,
  fallback = "The conversation tree operation failed",
): AppFailure {
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

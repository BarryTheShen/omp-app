import type { AppError, EntryId, ThreadId } from "@omp-app/contracts";
import {
  AppFailure,
  EntryId as EntryIdSchema,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { z } from "zod";

/** The only P3 inventory rows; durable omp tree rows belong to P4. */
export const P3_INVENTORY_COVERS = [
  "P3.branch-message-selector",
  "P3.branch-summary-divider",
] as const;
export type P3InventoryId = (typeof P3_INVENTORY_COVERS)[number];

export type BranchRepositoryItem<TMessage> = {
  readonly message: TMessage;
  readonly parentId: string | null;
  readonly runConfig?: unknown;
};

export type BranchRepositorySnapshot<TMessage> = {
  readonly threadId: ThreadId;
  /** assistant-ui's branch id, not an omp EntryId or a P5 SnapshotId. */
  readonly headId: string | null;
  /** Parents precede children; sibling items share a parentId. */
  readonly items: readonly BranchRepositoryItem<TMessage>[];
};

/**
 * Browser-owned assistant-ui branch repository. A head switch only swaps the visible repository;
 * it never calls omp branch/fork/prompt and never changes workspace files.
 */
export interface BranchRepositoryPort<TMessage> {
  snapshot(): BranchRepositorySnapshot<TMessage>;
  switchHead(headId: string): Promise<BranchRepositorySnapshot<TMessage>>;
  persistHead(headId: string | null): Promise<void>;
  refetch(): Promise<BranchRepositorySnapshot<TMessage>>;
}

/** Captured before edit/reload mutates the composer or selected branch. */
export interface EditSource {
  readonly threadId: ThreadId;
  readonly entryId: EntryId;
  readonly parentId: EntryId | null;
  readonly originalText: string;
  readonly originalImages: readonly unknown[];
  /** assistant-ui repository head at capture time; distinct from omp's session/entry ids. */
  readonly sourceHeadId: string | null;
}

export interface EditRequest {
  readonly source: EditSource;
  readonly replacementText: string;
  readonly replacementImages: readonly unknown[];
  readonly signal?: AbortSignal;
}

export type WorkspaceGuarantee = "not-managed" | "boundary" | "exact";

export interface EditRunResult {
  readonly threadId: ThreadId;
  readonly admitted: boolean;
  readonly settled: boolean;
  readonly workspaceGuarantee?: WorkspaceGuarantee;
  readonly externalChanges?: readonly string[];
  readonly partialFailure?: string;
}

export const EditSourceSchema = z.strictObject({
  threadId: ThreadIdSchema,
  entryId: EntryIdSchema,
  parentId: EntryIdSchema.nullable(),
  originalText: z.string(),
  originalImages: z.array(z.unknown()),
  sourceHeadId: z.string().nullable(),
});

export const EditRunResultSchema = z.strictObject({
  threadId: ThreadIdSchema,
  admitted: z.boolean(),
  settled: z.boolean(),
  workspaceGuarantee: z.enum(["not-managed", "boundary", "exact"]).optional(),
  externalChanges: z.array(z.string()).optional(),
  partialFailure: z.string().optional(),
});

export interface EditRunPort {
  edit(request: EditRequest): Promise<EditRunResult>;
}

export interface ReloadRequest {
  readonly source: EditSource;
  /** Opaque assistant-ui StartRunConfig; R0 chooses model/thinking and preserves it. */
  readonly runConfig: unknown;
  readonly signal?: AbortSignal;
}

export interface ReloadRunPort {
  reload(request: ReloadRequest): Promise<EditRunResult>;
}

/** The exact user-message rows returned by omp's get_branch_messages command. */
export const BranchMessageSchema = z.strictObject({
  entryId: EntryIdSchema,
  text: z.string(),
});
export type BranchMessage = z.infer<typeof BranchMessageSchema>;
export interface BranchMessageSelectorPort {
  list(threadId: ThreadId, signal?: AbortSignal): Promise<readonly BranchMessage[]>;
}

/** Optional P5 composition hook; P3 displays its result but does not import P5. */
export type EditRunDecorator = (
  request: EditRequest,
  run: (request: EditRequest) => Promise<EditRunResult>,
) => Promise<EditRunResult>;

/** Every cross-layer edit failure is an AppFailure, never an untyped object. */
export function asEditFailure(error: unknown, fallback = "The edit run failed"): AppFailure {
  if (error instanceof AppFailure) return error;
  const appError: AppError = {
    code: "internal",
    message: error instanceof Error ? error.message : fallback,
    retryable: true,
  };
  return new AppFailure(appError, { cause: error });
}

export function isSourceFailure(error: unknown): error is AppFailure {
  return error instanceof AppFailure;
}

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  AppFailure,
  CheckpointDiff,
  type CheckpointSnapshotArgs,
  ConversationHead,
  type ConversationHead as ConversationHeadType,
  EntryId,
  type ExternalChange,
  FolderPath,
  type FolderPath as FolderPathType,
  type RestoreOperation,
  RestorePlan,
  RestoreResult,
  type SnapshotId,
  SnapshotRecord,
  ThreadId,
} from "@omp-app/contracts";

/**
 * Scripted `CheckpointStoreService` copy from A1.7:
 * - Plan confirmation follows snapshot diff entries, and captured path counts include the diff size
 *   (`packages/server/src/modules/A1/checkpoints/store.ts:767,782,785-786`).
 * - A null-snapshot restore leaves files untouched and selects the target conversation when present
 *   (`:810-825`); conversation-only restores change only the conversation head (`:889-903`).
 * - Successful file restores report the prior conversation and included-path count, and create an
 *   undo snapshot; failed restores keep that snapshot, report changed paths, and do not roll back
 *   (`:889-903,908-927`).
 *
 * Deliberate differences from A1.7:
 * - `readFiles` captures regular files only, omitting empty directories, symlinks, and file modes;
 *   restore deletes unwanted paths then rewrites captured files with default modes rather than
 *   applying the shadow-git tree and refusing uncaptured-path conflicts (`:834-835,866-887`).
 * - The fixture uses regular-file hash differences for plan counts and the snapshot's included-file
 *   count for successful restore results; A1.7's manifest is directory-inclusive (`:782,894`).
 * - A null-snapshot plan internally compares against an empty map but reports zero changed paths;
 *   A1.7 has no diff and also reports zero (`:767,810-825`). Restore leaves files untouched here too.
 * - `excludedPaths` is always empty; `externalChanges` are injected by tests; snapshot guarantees
 *   are always `boundary` (`:686`).
 */
export interface TemporaryWorkspaceStore {
  snapshot(args: CheckpointSnapshotArgs): Promise<SnapshotRecord>;
  diff(args: {
    readonly workspace: FolderPathType;
    readonly snapshotId: SnapshotId;
  }): Promise<CheckpointDiff>;
  planRestore(args: {
    readonly workspace: FolderPathType;
    readonly operation: RestoreOperation;
    readonly snapshotId: SnapshotId | null;
    readonly currentConversation: ConversationHeadType;
    readonly targetConversation: ConversationHeadType | null;
    readonly expectedWorkspaceHash: string;
  }): Promise<RestorePlan>;
  restore(args: { readonly planId: string; readonly confirmed: true }): Promise<RestoreResult>;
}

export interface TemporaryWorkspace {
  readonly root: string;
  readonly folder: FolderPathType;
  readonly store: TemporaryWorkspaceStore;
  readonly conversation: ConversationHeadType;
  readonly setExternalChanges: (changes: readonly ExternalChange[]) => void;
  readonly lastRestoreResult: () => RestoreResult | null;
  readonly write: (path: string, contents: string) => Promise<void>;
  readonly failNextRestoreAfterPathRemoval: () => void;
  readonly read: (path: string) => Promise<Buffer>;
  readonly hash: (path: string) => Promise<string>;
  readonly cleanup: () => Promise<void>;
}

interface FileValue {
  readonly contents: Buffer;
  readonly hash: string;
}

interface StoredPlan {
  readonly plan: RestorePlan;
  readonly target: ReadonlyMap<string, FileValue>;
}
function fileHash(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function manifestHash(files: ReadonlyMap<string, FileValue>): string {
  return createHash("sha256")
    .update([...files].map(([path, file]) => `${path}\0${file.hash}\n`).join(""))
    .digest("hex");
}

async function readFiles(root: string): Promise<Map<string, FileValue>> {
  const files = new Map<string, FileValue>();
  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        await walk(absolute);
      } else if (child.isFile()) {
        const contents = await fs.readFile(absolute);
        const path = absolute
          .slice(root.length + 1)
          .split("\\")
          .join("/");
        files.set(path, { contents, hash: fileHash(contents) });
      }
    }
  }
  await walk(root);
  return files;
}

export async function createTemporaryWorkspace(name: string): Promise<TemporaryWorkspace> {
  const worktreeRoot = process.cwd().endsWith("/apps/web")
    ? join(process.cwd(), "..", "..")
    : process.cwd();
  const scratch = join(worktreeRoot, ".data", "scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(join(scratch, `p5-${name}-`));
  const folder = FolderPath.parse(root);
  const conversation = ConversationHead.parse({
    threadId: ThreadId.parse("p5-temporary-workspace"),
    sessionFile: null,
    entryId: EntryId.parse("p5-temporary-entry"),
  });
  const snapshots = new Map<
    string,
    { record: SnapshotRecord; files: ReadonlyMap<string, FileValue> }
  >();
  const plans = new Map<string, StoredPlan>();
  let previousSnapshotId: SnapshotId | null = null;
  let externalChanges: readonly ExternalChange[] = [];
  let restoreFailure = false;
  let lastRestore: RestoreResult | null = null;

  const snapshot = async (args: CheckpointSnapshotArgs): Promise<SnapshotRecord> => {
    const files = await readFiles(root);
    const snapshotId = `snapshot-${randomUUID()}` as SnapshotId;
    const record = SnapshotRecord.parse({
      snapshotId,
      workspaceKey: fileHash(new TextEncoder().encode(root)),
      ompSessionId: args.conversation.threadId,
      sessionFile: args.conversation.sessionFile,
      entryId: args.conversation.entryId,
      capturedAt: "2026-10-18T00:00:00.000Z",
      parentSnapshotId: previousSnapshotId,
      source: args.source,
      includedPaths: [...files].map(([path, file]) => ({
        path,
        kind: "file",
        hash: file.hash,
        sizeBytes: file.contents.byteLength,
      })),
      excludedPaths: [],
      shadowTreeId: `tree-${randomUUID()}`,
      workspaceHash: manifestHash(files),
      guarantee: "boundary",
      pinned: args.pinned ?? false,
    });
    snapshots.set(snapshotId, { record, files });
    previousSnapshotId = snapshotId;
    return record;
  };

  const store: TemporaryWorkspaceStore = {
    snapshot,
    diff: async ({ snapshotId }) => {
      const saved = snapshots.get(snapshotId);
      if (!saved)
        throw new AppFailure({
          code: "not_found",
          message: "Snapshot not found",
          retryable: false,
        });
      const current = await readFiles(root);
      const paths = new Set([...saved.files.keys(), ...current.keys()]);
      const entries = [...paths].sort().flatMap((path) => {
        const before = saved.files.get(path);
        const after = current.get(path);
        if (before?.hash === after?.hash) return [];
        return [
          {
            path,
            change:
              before === undefined
                ? ("added" as const)
                : after === undefined
                  ? ("deleted" as const)
                  : ("modified" as const),
            beforeHash: before?.hash ?? null,
            afterHash: after?.hash ?? null,
            beforeMode: before === undefined ? null : 0o644,
            afterMode: after === undefined ? null : 0o644,
          },
        ];
      });
      return CheckpointDiff.parse({
        snapshotId,
        workspace: folder,
        entries,
        excludedPaths: [],
        externalChanges,
        currentWorkspaceHash: manifestHash(current),
        snapshotWorkspaceHash: saved.record.workspaceHash,
      });
    },
    planRestore: async (args) => {
      const saved = args.snapshotId === null ? null : snapshots.get(args.snapshotId);
      if (args.snapshotId !== null && saved === undefined)
        throw new AppFailure({
          code: "not_found",
          message: "Snapshot not found",
          retryable: false,
        });
      const current = await readFiles(root);
      const target = saved?.files ?? new Map<string, FileValue>();
      const changedPaths = new Set([...current.keys(), ...target.keys()]);
      const changedCount = [...changedPaths].filter(
        (path) => current.get(path)?.hash !== target.get(path)?.hash,
      ).length;
      const plan = RestorePlan.parse({
        planId: `plan-${randomUUID()}`,
        workspace: args.workspace,
        operation: args.operation,
        snapshotId: args.snapshotId,
        currentConversation: args.currentConversation,
        targetConversation: args.targetConversation,
        currentWorkspaceHash: manifestHash(current),
        targetWorkspaceHash: saved?.record.workspaceHash ?? null,
        includedPaths: saved?.record.includedPaths ?? [],
        excludedPaths: saved?.record.excludedPaths ?? [],
        externalChanges: saved === null ? [] : externalChanges,
        snapshotGuarantee: saved?.record.guarantee ?? "boundary",
        destructive: args.operation !== "conversation-only",
        requiresConfirmation:
          saved !== null && args.operation !== "conversation-only" && changedCount > 0,
        capturedPathCount: saved === null ? 0 : changedCount,
      });
      plans.set(plan.planId, { plan, target });
      return plan;
    },
    restore: async ({ planId, confirmed }) => {
      const stored = plans.get(planId);
      if (!stored)
        throw new AppFailure({
          code: "not_found",
          message: "Restore plan not found",
          retryable: false,
        });
      const current = await readFiles(root);
      if (manifestHash(current) !== stored.plan.currentWorkspaceHash)
        throw new AppFailure({
          code: "conflict",
          message: "Workspace changed since the restore plan was created",
          retryable: true,
        });
      if (stored.plan.requiresConfirmation && confirmed !== true)
        throw new AppFailure({
          code: "invalid_args",
          message: "Restore requires confirmation",
          retryable: false,
        });

      const isConversationOnly = stored.plan.operation === "conversation-only";
      const hasSnapshot = stored.plan.snapshotId !== null;
      let undoSnapshotId: SnapshotId | null = null;
      let changedPaths: string[] = [];
      if (!isConversationOnly && hasSnapshot) {
        undoSnapshotId = (
          await snapshot({
            workspace: folder,
            conversation: stored.plan.currentConversation,
            source: "pre-restore",
          })
        ).snapshotId;
        const targetPaths = new Set(stored.target.keys());
        changedPaths = [...current.keys()].filter((path) => !targetPaths.has(path));
        for (const [path, target] of stored.target) {
          if (current.get(path)?.hash !== target.hash) changedPaths.push(path);
        }
        changedPaths = [...new Set(changedPaths)].sort();
        for (const path of current.keys()) {
          if (!targetPaths.has(path))
            await fs.rm(join(root, path), { recursive: true, force: true });
        }
        if (restoreFailure) {
          restoreFailure = false;
          const message = "shadow git failed: scripted read-tree failure";
          const result = RestoreResult.parse({
            planId: stored.plan.planId,
            operation: stored.plan.operation,
            filesRestored: false,
            conversationRestored: false,
            capturedPathCount: 0,
            excludedPaths: [],
            snapshotGuarantee: stored.plan.snapshotGuarantee,
            externalChanges,
            partialFailure: {
              stage: "files",
              message: `${message}${
                changedPaths.length > 0 ? ` Changed paths: ${changedPaths.join(", ")}.` : ""
              }`,
              rollbackAttempted: false,
              rollbackSucceeded: false,
            },
            previousConversation: stored.plan.currentConversation,
            currentConversation: stored.plan.currentConversation,
            undoSnapshotId,
            redoAvailable: undoSnapshotId !== null,
          });
          lastRestore = result;
          return result;
        }
        for (const [path, file] of stored.target) {
          const absolute = join(root, path);
          await fs.mkdir(dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, file.contents);
        }
      }

      const result = RestoreResult.parse({
        planId: stored.plan.planId,
        operation: stored.plan.operation,
        filesRestored: !isConversationOnly && hasSnapshot,
        conversationRestored: isConversationOnly,
        capturedPathCount: isConversationOnly || !hasSnapshot ? 0 : stored.target.size,
        excludedPaths: [],
        snapshotGuarantee: stored.plan.snapshotGuarantee,
        externalChanges: hasSnapshot ? externalChanges : [],
        partialFailure: null,
        previousConversation: stored.plan.currentConversation,
        currentConversation:
          !hasSnapshot || isConversationOnly
            ? (stored.plan.targetConversation ?? stored.plan.currentConversation)
            : stored.plan.currentConversation,
        undoSnapshotId,
        redoAvailable: undoSnapshotId !== null,
      });
      lastRestore = result;
      return result;
    },
  };

  return {
    root,
    folder,
    store,
    conversation,
    lastRestoreResult: () => lastRestore,
    write: async (path, contents) => {
      const absolute = join(root, path);
      await fs.mkdir(dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, contents);
    },
    setExternalChanges: (changes) => {
      externalChanges = changes;
    },
    read: (path) => fs.readFile(join(root, path)),
    hash: async (path) => fileHash(await fs.readFile(join(root, path))),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
    failNextRestoreAfterPathRemoval: () => {
      restoreFailure = true;
    },
  };
}

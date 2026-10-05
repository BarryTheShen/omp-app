import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  AppFailure,
  type CheckpointDiff,
  CheckpointListArgs,
  CheckpointListResult,
  CheckpointSnapshotArgs,
  type ConversationHead,
  type DiffEntry,
  type ExcludedPath,
  type FolderPath,
  RestoreArgs,
  type RestoreOperation,
  type RestorePlan,
  type RestorePlanId,
  RestorePlan as RestorePlanSchema,
  type RestoreResult,
  type SnapshotId,
  type SnapshotPath,
  type SnapshotRecord,
  SnapshotRecord as SnapshotRecordSchema,
} from "@omp-app/contracts";
import type { z } from "zod";
import { compareAndSwapFile, ensureAppDataDir, readFileHash, writeFileAtomic } from "../fs";

export interface CheckpointStoreOptions {
  readonly appDataDir?: string;
  readonly maxSnapshots?: number;
  readonly gitBinary?: string;
  readonly planTtlMs?: number;
}

interface ManifestEntry extends SnapshotPath {
  relativePath: string;
}
interface StoredPlan {
  readonly plan: RestorePlan;
  readonly snapshot: SnapshotRecord | null;
  readonly createdAt: number;
}
const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_PLANS_PER_WORKSPACE = 20;

function failure(
  code: "conflict" | "invalid_args" | "internal" | "not_found" | "permission",
  message: string,
  retryable = false,
): AppFailure {
  return new AppFailure({ code, message, retryable });
}

function workspaceKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex");
}

function manifestHash(manifest: readonly ManifestEntry[]): string {
  return createHash("sha256")
    .update(
      manifest
        .map(
          (entry) =>
            `${entry.relativePath}\0${entry.kind}\0${entry.mode ?? ""}\0${entry.hash ?? ""}\0${entry.sizeBytes ?? ""}\n`,
        )
        .join(""),
    )
    .digest("hex");
}

async function output(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (stream === null || stream === undefined || typeof stream === "number") return "";
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
async function runGit(
  binary: string,
  gitDir: string,
  workspace: string,
  args: readonly string[],
): Promise<string> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_DIR: gitDir } as Record<
    string,
    string | undefined
  >;
  if (args[0] !== "init") env.GIT_WORK_TREE = workspace;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [binary, ...args],
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch (error) {
    throw failure(
      "internal",
      `shadow git unavailable: ${error instanceof Error ? error.message : "unable to start git"}`,
    );
  }
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    output(child.stdout),
    output(child.stderr),
  ]);
  if (code !== 0)
    throw failure("internal", `shadow git failed: ${stderr.trim() || args[0] || "command"}`);
  return stdout;
}

async function scanWorkspace(
  workspace: string,
  excludedRoot: string,
): Promise<{ manifest: ManifestEntry[]; excluded: ExcludedPath[] }> {
  const manifest: ManifestEntry[] = [];
  const excluded: ExcludedPath[] = [];
  const skip = new Set([".git", "node_modules", ".omp", "dist", "build"]);
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(workspace, absolute).split("\\").join("/");
      if (
        skip.has(entry.name) ||
        (excludedRoot && (absolute === excludedRoot || absolute.startsWith(`${excludedRoot}/`)))
      ) {
        excluded.push({ path: rel || entry.name, reason: "excluded by checkpoint policy" });
        continue;
      }
      if (
        entry.name.startsWith(".env") ||
        entry.name.endsWith(".pem") ||
        entry.name.endsWith(".key")
      ) {
        excluded.push({ path: rel, reason: "secret-looking path" });
        continue;
      }
      const stat = await lstat(absolute);
      const mode = stat.mode & 0o7777;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isSymbolicLink())
        manifest.push({
          relativePath: rel,
          path: rel,
          kind: "symlink",
          mode,
          hash: createHash("sha256")
            .update(await readlink(absolute))
            .digest("hex"),
        });
      else if (entry.isFile())
        manifest.push({
          relativePath: rel,
          path: rel,
          kind: "file",
          mode,
          hash: createHash("sha256")
            .update(await readFile(absolute))
            .digest("hex"),
          sizeBytes: stat.size,
        });
    }
  }
  await walk(workspace);
  manifest.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { manifest, excluded };
}

async function ensureShadow(gitBinary: string, gitDir: string, workspace: string): Promise<void> {
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  try {
    await runGit(gitBinary, gitDir, workspace, ["rev-parse", "--git-dir"]);
  } catch {
    await runGit(gitBinary, gitDir, workspace, ["init", "--bare"]);
  }
}

async function captureTree(gitBinary: string, gitDir: string, workspace: string): Promise<string> {
  await runGit(gitBinary, gitDir, workspace, ["reset", "--mixed"]);
  await runGit(gitBinary, gitDir, workspace, [
    "add",
    "-A",
    "--",
    ".",
    ":!.git",
    ":!node_modules",
    ":!.omp",
    ":!dist",
    ":!build",
  ]);
  await runGit(gitBinary, gitDir, workspace, [
    "-c",
    "user.name=omp-app",
    "-c",
    "user.email=omp-app@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "checkpoint",
  ]);
  return (await runGit(gitBinary, gitDir, workspace, ["rev-parse", "HEAD^{tree}"])).trim();
}

async function readRecords(path: string): Promise<SnapshotRecord[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => SnapshotRecordSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
}
async function workspaceRecords(
  root: string,
  key: string,
  threadId?: string,
): Promise<SnapshotRecord[]> {
  const base = join(root, "checkpoints", key);
  try {
    const directories =
      threadId === undefined
        ? await readdir(base, { withFileTypes: true })
        : [{ name: threadId, isDirectory: () => true }];
    const records: SnapshotRecord[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      records.push(...(await readRecords(join(base, directory.name, "records.jsonl"))));
    }
    return records;
  } catch {
    return [];
  }
}

export class CheckpointStoreService {
  readonly #options: Required<
    Pick<CheckpointStoreOptions, "maxSnapshots" | "gitBinary" | "planTtlMs">
  > &
    Pick<CheckpointStoreOptions, "appDataDir">;
  readonly #plans = new Map<RestorePlanId, StoredPlan>();
  readonly #listeners = new Set<
    (
      record: SnapshotRecord,
      kind: "created" | "restored" | "removed",
      workspace: FolderPath,
    ) => void
  >();

  constructor(options: CheckpointStoreOptions = {}) {
    this.#options = {
      maxSnapshots: options.maxSnapshots ?? 100,
      gitBinary: options.gitBinary ?? "git",
      planTtlMs: options.planTtlMs ?? DEFAULT_PLAN_TTL_MS,
      appDataDir: options.appDataDir,
    };
  }

  onChanged(
    listener: (
      record: SnapshotRecord,
      kind: "created" | "restored" | "removed",
      workspace: FolderPath,
    ) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async snapshot(args: z.infer<typeof CheckpointSnapshotArgs>): Promise<SnapshotRecord> {
    const parsed = CheckpointSnapshotArgs.parse(args);
    const workspace = await realpath(parsed.workspace);
    const key = workspaceKey(workspace);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const sessionRoot = join(root, "checkpoints", key, parsed.conversation.threadId);
    const gitDir = join(sessionRoot, "shadow-git");
    const recordsPath = join(sessionRoot, "records.jsonl");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await ensureShadow(this.#options.gitBinary, gitDir, workspace);
    const { manifest, excluded } = await scanWorkspace(workspace, root);
    const shadowTreeId = await captureTree(this.#options.gitBinary, gitDir, workspace);
    const records = await readRecords(recordsPath);
    const record = SnapshotRecordSchema.parse({
      snapshotId: `snapshot-${randomUUID()}`,
      workspaceKey: key,
      ompSessionId: parsed.conversation.threadId,
      sessionFile: parsed.conversation.sessionFile,
      entryId: parsed.conversation.entryId,
      capturedAt: new Date().toISOString(),
      parentSnapshotId: records.at(-1)?.snapshotId ?? null,
      source: parsed.source,
      includedPaths: manifest.map(({ relativePath, path: _path, ...entry }) => ({
        path: relativePath,
        ...entry,
      })),
      excludedPaths: excluded,
      shadowTreeId,
      workspaceHash: manifestHash(manifest),
      guarantee: "boundary",
      pinned: parsed.pinned ?? false,
    });
    const content = `${[...records, record].map((item) => JSON.stringify(item)).join("\n")}\n`;
    const previousHash = await readFileHash(recordsPath);
    await compareAndSwapFile(recordsPath, content, previousHash);
    await this.#prune(recordsPath, records.concat(record));
    for (const listener of [...this.#listeners]) listener(record, "created", parsed.workspace);
    return record;
  }

  async list(
    args: z.infer<typeof CheckpointListArgs>,
  ): Promise<z.infer<typeof CheckpointListResult>> {
    const parsed = CheckpointListArgs.parse(args);
    const workspace = await realpath(parsed.workspace);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const records = await workspaceRecords(root, workspaceKey(workspace), parsed.threadId);
    const start = parsed.cursor === undefined ? 0 : Number.parseInt(parsed.cursor, 10);
    const page = records.slice(
      Number.isFinite(start) ? start : 0,
      (Number.isFinite(start) ? start : 0) + (parsed.limit ?? 100),
    );
    const next =
      (Number.isFinite(start) ? start : 0) + page.length < records.length
        ? String((Number.isFinite(start) ? start : 0) + page.length)
        : null;
    return CheckpointListResult.parse({
      snapshots: page,
      nextCursor: next,
      pinnedBaseline: records.find((record) => record.pinned)?.snapshotId ?? null,
    });
  }

  async diff(args: { workspace: FolderPath; snapshotId: SnapshotId }): Promise<CheckpointDiff> {
    const record = await this.#findRecord(args.workspace, args.snapshotId);
    const workspace = await realpath(args.workspace);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const current = await scanWorkspace(workspace, root);
    return this.#diff(record, args.workspace, current.manifest, current.excluded);
  }

  async planRestore(args: {
    workspace: FolderPath;
    operation: RestoreOperation;
    snapshotId: SnapshotId | null;
    currentConversation: ConversationHead;
    targetConversation: ConversationHead | null;
    expectedWorkspaceHash: string;
  }): Promise<RestorePlan> {
    const workspace = await realpath(args.workspace);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const record =
      args.snapshotId === null ? null : await this.#findRecord(args.workspace, args.snapshotId);
    const current = await scanWorkspace(workspace, root);
    const diff =
      record === null
        ? null
        : this.#diff(record, args.workspace, current.manifest, current.excluded);
    const plan = RestorePlanSchema.parse({
      planId: `restore-${randomUUID()}`,
      workspace: args.workspace,
      operation: args.operation,
      snapshotId: args.snapshotId,
      currentConversation: args.currentConversation,
      targetConversation: args.targetConversation,
      currentWorkspaceHash: manifestHash(current.manifest),
      targetWorkspaceHash: record?.workspaceHash ?? null,
      includedPaths: record?.includedPaths ?? [],
      excludedPaths: record?.excludedPaths ?? current.excluded,
      externalChanges: diff?.externalChanges ?? [],
      capturedPathCount: diff?.entries.length ?? 0,
      snapshotGuarantee: record?.guarantee ?? "boundary",
      destructive: args.operation !== "conversation-only",
      requiresConfirmation:
        args.operation !== "conversation-only" && (diff?.entries.length ?? 0) > 0,
    });
    this.#purgePlans(Date.now());
    this.#plans.set(plan.planId, { plan, snapshot: record, createdAt: Date.now() });
    this.#purgePlans(Date.now());
    return plan;
  }

  async restore(args: z.infer<typeof RestoreArgs>): Promise<RestoreResult> {
    const parsed = RestoreArgs.parse(args);
    this.#purgePlans(Date.now());
    const stored = this.#plans.get(parsed.planId);
    if (stored === undefined) throw failure("not_found", "Restore plan not found");
    const { plan, snapshot } = stored;
    const previousConversation = plan.currentConversation;
    const workspace = await realpath(plan.workspace);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const current = await scanWorkspace(workspace, root);
    if (manifestHash(current.manifest) !== plan.currentWorkspaceHash)
      throw failure("conflict", "Workspace changed since the restore plan was created.", true);
    if (snapshot !== null && snapshot.workspaceKey !== workspaceKey(workspace))
      throw failure("invalid_args", "Restore plan does not match its workspace.");
    if (plan.requiresConfirmation && parsed.confirmed !== true)
      throw failure("invalid_args", "This restore plan requires confirmation.");
    if (plan.operation === "conversation-only" || snapshot === null)
      return {
        planId: plan.planId,
        operation: plan.operation,
        filesRestored: false,
        conversationRestored: plan.operation === "conversation-only",
        capturedPathCount: 0,
        excludedPaths: plan.excludedPaths.map((item) => item.path),
        snapshotGuarantee: plan.snapshotGuarantee,
        externalChanges: plan.externalChanges,
        partialFailure: null,
        previousConversation,
        currentConversation: plan.targetConversation ?? previousConversation,
        undoSnapshotId: null,
        redoAvailable: false,
      };

    let undoSnapshot: SnapshotRecord | null = null;
    const changedPaths: string[] = [];
    try {
      undoSnapshot = await this.snapshot({
        workspace: plan.workspace,
        conversation: plan.currentConversation,
        source: "pre-restore",
        pinned: false,
      });
      const afterUndoSnapshot = await scanWorkspace(workspace, root);
      if (manifestHash(afterUndoSnapshot.manifest) !== plan.currentWorkspaceHash)
        throw failure("conflict", "Workspace changed since the restore plan was created.", true);
      const wanted = new Set(snapshot.includedPaths.map((item) => item.path));
      const before = new Map(current.manifest.map((item) => [item.relativePath, item]));
      for (const item of current.manifest) {
        if (!wanted.has(item.relativePath)) changedPaths.push(item.relativePath);
      }
      for (const item of snapshot.includedPaths) {
        const now = before.get(item.path);
        if (
          now === undefined ||
          now.hash !== item.hash ||
          now.mode !== item.mode ||
          now.kind !== item.kind
        )
          changedPaths.push(item.path);
      }
      for (const item of current.manifest) {
        if (!wanted.has(item.relativePath))
          await rm(join(workspace, item.relativePath), { recursive: true, force: true });
      }
      const gitDir = join(
        root,
        "checkpoints",
        snapshot.workspaceKey,
        snapshot.ompSessionId,
        "shadow-git",
      );
      await runGit(this.#options.gitBinary, gitDir, workspace, [
        "read-tree",
        "--reset",
        "-u",
        snapshot.shadowTreeId,
      ]);
      for (const listener of [...this.#listeners]) listener(snapshot, "restored", plan.workspace);
      return {
        planId: plan.planId,
        operation: plan.operation,
        filesRestored: true,
        conversationRestored: false,
        capturedPathCount: snapshot.includedPaths.length,
        excludedPaths: snapshot.excludedPaths.map((item) => item.path),
        snapshotGuarantee: snapshot.guarantee,
        externalChanges: plan.externalChanges,
        partialFailure: null,
        previousConversation,
        currentConversation: previousConversation,
        undoSnapshotId: undoSnapshot.snapshotId,
        redoAvailable: true,
      };
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict") throw error;
      const changed = [...new Set(changedPaths)].sort();
      const changedSuffix = changed.length > 0 ? ` Changed paths: ${changed.join(", ")}.` : "";
      return {
        planId: plan.planId,
        operation: plan.operation,
        filesRestored: false,
        conversationRestored: false,
        capturedPathCount: 0,
        excludedPaths: plan.excludedPaths.map((item) => item.path),
        snapshotGuarantee: plan.snapshotGuarantee,
        externalChanges: plan.externalChanges,
        partialFailure: {
          stage: "files",
          message: `${error instanceof Error ? error.message : "restore failed"}${changedSuffix}`,
          rollbackAttempted: false,
          rollbackSucceeded: false,
        },
        previousConversation,
        currentConversation: previousConversation,
        undoSnapshotId: undoSnapshot?.snapshotId ?? null,
        redoAvailable: undoSnapshot !== null,
      };
    }
  }

  #purgePlans(now: number): void {
    for (const [planId, stored] of this.#plans) {
      if (now - stored.createdAt >= this.#options.planTtlMs) this.#plans.delete(planId);
    }
    const byWorkspace = new Map<string, StoredPlan[]>();
    for (const stored of this.#plans.values()) {
      const key = resolve(stored.plan.workspace);
      const plans = byWorkspace.get(key) ?? [];
      plans.push(stored);
      byWorkspace.set(key, plans);
    }
    for (const plans of byWorkspace.values()) {
      if (plans.length <= MAX_PLANS_PER_WORKSPACE) continue;
      for (const stored of plans
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, plans.length - MAX_PLANS_PER_WORKSPACE)) {
        this.#plans.delete(stored.plan.planId);
      }
    }
  }

  async #findRecord(workspacePath: FolderPath, snapshotId: SnapshotId): Promise<SnapshotRecord> {
    const workspace = await realpath(workspacePath);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const records = await workspaceRecords(root, workspaceKey(workspace));
    const record = records.find((item) => item.snapshotId === snapshotId);
    if (record === undefined) throw failure("not_found", "Snapshot not found");
    return record;
  }

  #diff(
    record: SnapshotRecord,
    workspace: FolderPath,
    current: readonly ManifestEntry[],
    excludedPaths: readonly ExcludedPath[],
  ): CheckpointDiff {
    const before = new Map(record.includedPaths.map((item) => [item.path, item]));
    const after = new Map(current.map((item) => [item.relativePath, item]));
    const entries: DiffEntry[] = [];
    for (const [path, item] of before) {
      const now = after.get(path);
      if (now === undefined)
        entries.push({
          path,
          change: "deleted",
          beforeHash: item.hash ?? null,
          afterHash: null,
          beforeMode: item.mode ?? null,
          afterMode: null,
        });
      else if (item.hash !== now.hash)
        entries.push({
          path,
          change: "modified",
          beforeHash: item.hash ?? null,
          afterHash: now.hash ?? null,
          beforeMode: item.mode ?? null,
          afterMode: now.mode ?? null,
        });
      else if (item.mode !== now.mode)
        entries.push({
          path,
          change: "mode-changed",
          beforeHash: item.hash ?? null,
          afterHash: now.hash ?? null,
          beforeMode: item.mode ?? null,
          afterMode: now.mode ?? null,
        });
    }
    for (const [path, item] of after)
      if (!before.has(path))
        entries.push({
          path,
          change: "added",
          beforeHash: null,
          afterHash: item.hash ?? null,
          beforeMode: null,
          afterMode: item.mode ?? null,
        });
    return {
      snapshotId: record.snapshotId,
      workspace,
      entries,
      excludedPaths: [...record.excludedPaths, ...excludedPaths],
      externalChanges: [],
      currentWorkspaceHash: manifestHash(current),
      snapshotWorkspaceHash: record.workspaceHash,
    };
  }

  async #prune(recordsPath: string, records: SnapshotRecord[]): Promise<void> {
    const keep = records.filter(
      (record) =>
        record.pinned ||
        record.ompSessionId !== records.at(-1)?.ompSessionId ||
        records.indexOf(record) >= records.length - this.#options.maxSnapshots,
    );
    if (keep.length === records.length) return;
    await writeFileAtomic(recordsPath, `${keep.map((item) => JSON.stringify(item)).join("\n")}\n`);
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
import { compareAndSwapFile, ensureAppDataDir, readFileSnapshot } from "../fs";

export interface CheckpointStoreOptions {
  readonly appDataDir?: string;
  readonly maxSnapshots?: number;
  readonly gitBinary?: string;
  readonly planTtlMs?: number;
  /** Receives a records line or file that cannot be read; the line is skipped and kept in the file. */
  readonly onError?: (error: AppFailure) => void;
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
/** Extra git environment for one call: another index file, or other shadows' object stores. */
interface GitOptions {
  readonly indexFile?: string;
  readonly alternateObjectDirs?: readonly string[];
}
async function runGit(
  binary: string,
  gitDir: string,
  workspace: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: options.indexFile ?? join(gitDir, "index"),
  };
  if (options.alternateObjectDirs?.length)
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = options.alternateObjectDirs.join(":");
  else delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
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

/** Why a path is left out because git ignores it; shown to the person in excludedPaths. */
const GIT_IGNORED_REASON = "ignored by git; checkpoints and restores leave it alone";

/** Why a nested git repository is left out: checkpoints store only a reference to it. */
const NESTED_REPO_REASON = "inside another git repository; checkpoints and restores leave it alone";

/** Workspace paths no checkpoint holds: folders and files git ignores, and nested repositories. */
interface UncapturedPaths {
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
  /** Folders with an uncaptured file or folder somewhere below them. */
  readonly holding: ReadonlySet<string>;
}

/** The folders above a workspace path, outermost first: `a/b/c.ts` gives `a` and `a/b`. */
function ancestorsOf(path: string): string[] {
  const found: string[] = [];
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1))
    found.push(path.slice(0, index));
  return found;
}

function isUncaptured(paths: UncapturedPaths, relativePath: string): boolean {
  if (paths.files.has(relativePath) || paths.directories.has(relativePath)) return true;
  return ancestorsOf(relativePath).some((ancestor) => paths.directories.has(ancestor));
}

/**
 * Asks git which workspace paths its ignore rules exclude, under the rules `add -A` uses when it
 * builds a checkpoint tree. The probe index is empty, so an ignored file is judged by the rules
 * alone, never by what an earlier checkpoint tracked.
 */
async function gitIgnoredPaths(
  gitBinary: string,
  root: string,
  workspace: string,
): Promise<UncapturedPaths> {
  const probe = join(root, "ignore-probes", workspaceKey(workspace));
  await ensureShadow(gitBinary, probe, workspace);
  await syncProjectExclude(gitBinary, probe, workspace);
  const listing = await runGit(
    gitBinary,
    probe,
    workspace,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { indexFile: join(probe, "no-index") },
  );
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    if (entry.endsWith("/")) directories.add(entry.slice(0, -1));
    else files.add(entry);
  }
  const holding = new Set<string>();
  for (const entry of [...files, ...directories]) {
    for (const ancestor of ancestorsOf(entry)) holding.add(ancestor);
  }
  return { files, directories, holding };
}

/**
 * Adds paths no checkpoint holds to the uncaptured set: nested git repositories (a checkpoint stores one reference to each)
 * and what checkpoint policy leaves out (skipped and secret-looking names). A restore refuses to replace them.
 */
function withUncaptured(
  paths: UncapturedPaths,
  extra: { readonly files: readonly string[]; readonly directories: readonly string[] },
): UncapturedPaths {
  const files = new Set([...paths.files, ...extra.files]);
  const directories = new Set([...paths.directories, ...extra.directories]);
  const holding = new Set(paths.holding);
  for (const entry of [...extra.files, ...extra.directories]) {
    for (const ancestor of ancestorsOf(entry)) holding.add(ancestor);
  }
  return { files, directories, holding };
}

/**
 * Folder and file names no checkpoint captures, at any depth. scanWorkspace (the manifest) and captureTree (the stored
 * tree) both read this list, so the two hold the same paths.
 */
const SKIPPED_FOLDER_NAMES = [".git", "node_modules", ".omp", "dist", "build"] as const;

/** The same secret-looking names as `isSecretName`, as git pathspecs for captureTree, at any depth: the names and their folders. */
const SECRET_PATHSPECS = [
  ":(exclude,glob)**/.env*",
  ":(exclude,glob)**/.env*/**",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.pem/**",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/*.key/**",
] as const;

/** A secret-looking file name: `.env*`, `*.pem` or `*.key`. Such a file is never captured, at any depth. */
function isSecretName(name: string): boolean {
  return name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key");
}

/**
 * What a checkpoint can hold, and what it must leave alone: entries git ignores, and nested git
 * repositories (a checkpoint stores one reference to each, never its files).
 */
async function scanWorkspace(
  gitBinary: string,
  workspace: string,
  excludedRoot: string,
): Promise<{
  manifest: ManifestEntry[];
  excluded: ExcludedPath[];
  uncaptured: UncapturedPaths;
  nested: string[];
}> {
  const manifest: ManifestEntry[] = [];
  const excluded: ExcludedPath[] = [];
  const nested: string[] = [];
  // What policy leaves out, as the uncaptured set holds it: a restore must not replace it without an undo copy.
  const policyFiles: string[] = [];
  const policyDirectories: string[] = [];
  const gitIgnored = await gitIgnoredPaths(gitBinary, excludedRoot, workspace);
  const skip = new Set<string>(SKIPPED_FOLDER_NAMES);
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(workspace, absolute).split("\\").join("/");
      if (
        skip.has(entry.name) ||
        (excludedRoot && (absolute === excludedRoot || absolute.startsWith(`${excludedRoot}/`)))
      ) {
        excluded.push({ path: rel || entry.name, reason: "excluded by checkpoint policy" });
        (entry.isDirectory() ? policyDirectories : policyFiles).push(rel || entry.name);
        continue;
      }
      if (isSecretName(entry.name)) {
        excluded.push({ path: rel, reason: "secret-looking path" });
        (entry.isDirectory() ? policyDirectories : policyFiles).push(rel);
        continue;
      }
      if (isUncaptured(gitIgnored, rel)) {
        excluded.push({ path: rel, reason: GIT_IGNORED_REASON });
        continue;
      }
      if (entry.isDirectory() && (await entryAt(workspace, `${rel}/.git`)) !== null) {
        nested.push(rel);
        excluded.push({ path: rel, reason: NESTED_REPO_REASON });
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
  return {
    manifest,
    excluded,
    uncaptured: withUncaptured(gitIgnored, {
      files: policyFiles,
      directories: [...policyDirectories, ...nested],
    }),
    nested,
  };
}

function shadowGitDir(root: string, key: string, threadId: string): string {
  return join(root, "checkpoints", key, threadId, "shadow-git");
}

/**
 * Paths a shadow tree holds. A restore may only write or remove what the tree holds. A nested repository is a commit
 * entry (a gitlink): the tree holds one reference to it, never its files, so a restore does not hold its path.
 */
async function treePaths(
  gitBinary: string,
  gitDir: string,
  workspace: string,
  treeId: string,
): Promise<Set<string>> {
  const listing = await runGit(gitBinary, gitDir, workspace, ["ls-tree", "-r", "-z", treeId]);
  const paths = new Set<string>();
  for (const entry of listing.split("\0")) {
    // Each entry is "<mode> <type> <object>", a tab, then the path.
    const tab = entry.indexOf("\t");
    if (tab === -1 || entry.slice(0, tab).split(" ")[1] === "commit") continue;
    paths.add(entry.slice(tab + 1));
  }
  return paths;
}

function uniqueExcluded(items: readonly ExcludedPath[]): ExcludedPath[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

/** What is at a workspace path, or null. A symbolic link is reported as itself, not followed. */
async function entryAt(workspace: string, relativePath: string): Promise<Stats | null> {
  try {
    return await lstat(join(workspace, relativePath));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  }
}

/**
 * Uncaptured paths that restoring the target tree would replace or remove. No checkpoint holds
 * their content, so Undo could not bring one back. A path conflicts when the target holds a file
 * there and an uncaptured file or folder is in the way, or when the target holds a file where a
 * folder holds uncaptured content. Returns the paths at stake, sorted.
 */
async function uncapturedConflicts(
  workspace: string,
  held: ReadonlySet<string>,
  uncaptured: UncapturedPaths,
): Promise<string[]> {
  const conflicts = new Set<string>();
  for (const path of held) {
    if (isUncaptured(uncaptured, path) && (await entryAt(workspace, path)) !== null)
      conflicts.add(path);
    for (const ancestor of ancestorsOf(path)) {
      if (!isUncaptured(uncaptured, ancestor)) continue;
      const found = await entryAt(workspace, ancestor);
      if (found !== null && !found.isDirectory()) {
        conflicts.add(ancestor);
        break;
      }
    }
    if (uncaptured.holding.has(path)) conflicts.add(path);
  }
  return [...conflicts].sort();
}

function uncapturedConflictFailure(paths: readonly string[]): AppFailure {
  const shown = paths.slice(0, 5).join(", ");
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
  const what = paths.length === 1 ? "a file or folder" : `${paths.length} files or folders`;
  return failure(
    "conflict",
    `Restoring would replace ${what} that checkpoints leave alone (${shown}${more}). Undo cannot bring those back, so move or delete them, then plan the restore again.`,
  );
}

/** True for "no such file": the one error that means the project has no such rules. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The project's own exclude rules, `info/exclude` of its git directory, as text. Only a workspace with a `.git` of its
 * own has them: a folder inside another repository takes none of that repository's rules here. Undefined only when
 * there are none (no `.git`, or no `info/exclude`). Any other failure to read them is an error: a capture must never
 * go on without the rules the person set, or it would hold the files they excluded.
 */
async function projectExcludeText(
  gitBinary: string,
  workspace: string,
): Promise<string | undefined> {
  try {
    await lstat(join(workspace, ".git"));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const child = Bun.spawn({
    cmd: [gitBinary, "rev-parse", "--git-path", "info/exclude"],
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    output(child.stdout),
    output(child.stderr),
  ]);
  if (code !== 0)
    throw failure("internal", `shadow git failed: ${stderr.trim() || "rev-parse --git-path"}`);
  const found = stdout.trim();
  try {
    return await readFile(isAbsolute(found) ? found : join(workspace, found), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    const reason = error instanceof Error ? error.message : "unknown error";
    throw failure("internal", `the project's exclude file cannot be read: ${reason}`);
  }
}

/**
 * Gives a shadow or probe repository the project's exclude rules, so git applies them as the project does. The file is
 * written beside its place and renamed into it, so a git run never reads half of it.
 */
async function syncProjectExclude(
  gitBinary: string,
  gitDir: string,
  workspace: string,
): Promise<void> {
  const text = await projectExcludeText(gitBinary, workspace);
  const target = join(gitDir, "info", "exclude");
  if (text === undefined) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(join(gitDir, "info"), { recursive: true });
  const staged = `${target}.${randomUUID()}.tmp`;
  await writeFile(staged, text);
  await rename(staged, target);
}

async function ensureShadow(gitBinary: string, gitDir: string, workspace: string): Promise<void> {
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  try {
    await runGit(gitBinary, gitDir, workspace, ["rev-parse", "--git-dir"]);
  } catch {
    await runGit(gitBinary, gitDir, workspace, ["init", "--bare"]);
  }
}

async function captureTree(
  gitBinary: string,
  gitDir: string,
  workspace: string,
  nested: readonly string[],
): Promise<string> {
  await syncProjectExclude(gitBinary, gitDir, workspace);
  // Start from an empty index: a checkpoint holds what git would add now, not files that an
  // earlier checkpoint tracked and a later ignore rule covers.
  await runGit(gitBinary, gitDir, workspace, ["read-tree", "--empty"]);
  await runGit(gitBinary, gitDir, workspace, [
    "add",
    "-A",
    "--",
    ".",
    // The names scanWorkspace leaves out, at any depth: a folder or file of that name anywhere in the workspace.
    ...SKIPPED_FOLDER_NAMES.flatMap((name) => [
      `:(exclude,glob)**/${name}`,
      `:(exclude,glob)**/${name}/**`,
    ]),
    ...SECRET_PATHSPECS,
    // Git would store a nested repository as one commit reference: leave its contents out.
    ...nested.map((path) => `:(exclude,literal)${path}`),
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

/** A line of a records file: the record it holds, or null for a line that cannot be read. */
interface RecordLine {
  readonly raw: string;
  readonly record: SnapshotRecord | null;
}

function recordsOf(lines: readonly RecordLine[]): SnapshotRecord[] {
  return lines.flatMap((line) => (line.record === null ? [] : [line.record]));
}

/**
 * The lines of a records file in order, and the hash of the content they came from (null when there is no file). A
 * line that cannot be read is reported and kept as it is, so the next write keeps it. A file that cannot be read at
 * all is an error: an empty history would let the next write replace the file.
 */
async function readRecordLines(
  path: string,
  onError: ((error: AppFailure) => void) | undefined,
): Promise<{ readonly lines: RecordLine[]; readonly hash: string | null }> {
  const snapshot = await readFileSnapshot(path).catch(() => {
    onError?.(failure("internal", `Cannot read checkpoint records file ${path}.`));
    throw failure("internal", "Cannot read the checkpoints.");
  });
  if (!snapshot.exists || snapshot.content === null) return { lines: [], hash: null };
  const lines: RecordLine[] = [];
  snapshot.content.split("\n").forEach((raw, index) => {
    if (raw === "") return;
    try {
      lines.push({ raw, record: SnapshotRecordSchema.parse(JSON.parse(raw)) });
    } catch {
      onError?.(
        failure(
          "invalid_args",
          `Checkpoint record in ${path} on line ${index + 1} cannot be read. It is skipped and kept in the file.`,
        ),
      );
      lines.push({ raw, record: null });
    }
  });
  return { lines, hash: snapshot.hash };
}

/**
 * The lines a records file keeps after a new snapshot: the pinned records, the records of other chats and the newest
 * `maxSnapshots` records. A line that cannot be read is always kept.
 */
function keptLines(lines: readonly RecordLine[], maxSnapshots: number): RecordLine[] {
  const records = recordsOf(lines);
  const newest = records.at(-1)?.ompSessionId;
  return lines.filter(({ record }) => {
    if (record === null) return true;
    return (
      record.pinned ||
      record.ompSessionId !== newest ||
      records.indexOf(record) >= records.length - maxSnapshots
    );
  });
}

async function workspaceRecords(
  root: string,
  key: string,
  onError: ((error: AppFailure) => void) | undefined,
  threadId?: string,
): Promise<SnapshotRecord[]> {
  const base = join(root, "checkpoints", key);
  let threads: string[];
  if (threadId === undefined) {
    try {
      threads = (await readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      // A workspace with no checkpoints has no folder yet.
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      onError?.(failure("internal", `Cannot read checkpoint folder ${base}.`));
      throw failure("internal", "Cannot read the checkpoints.");
    }
  } else {
    threads = [threadId];
  }
  const records: SnapshotRecord[] = [];
  for (const thread of threads) {
    const file = await readRecordLines(join(base, thread, "records.jsonl"), onError);
    records.push(...recordsOf(file.lines));
  }
  return records;
}

export class CheckpointStoreService {
  readonly #options: Required<
    Pick<CheckpointStoreOptions, "maxSnapshots" | "gitBinary" | "planTtlMs">
  > &
    Pick<CheckpointStoreOptions, "appDataDir" | "onError">;
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
      onError: options.onError,
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
    const { manifest, excluded, nested } = await scanWorkspace(
      this.#options.gitBinary,
      workspace,
      root,
    );
    const shadowTreeId = await captureTree(this.#options.gitBinary, gitDir, workspace, nested);
    const current = await readRecordLines(recordsPath, this.#options.onError);
    const records = recordsOf(current.lines);
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
    const lines = keptLines(
      [...current.lines, { raw: JSON.stringify(record), record }],
      this.#options.maxSnapshots,
    );
    // The hash belongs to the content the new file is built from, so a write that raced this read
    // fails instead of replacing a record it did not see.
    const content = `${lines.map((line) => line.raw).join("\n")}\n`;
    await compareAndSwapFile(recordsPath, content, current.hash);
    for (const listener of [...this.#listeners]) listener(record, "created", parsed.workspace);
    return record;
  }

  async list(
    args: z.infer<typeof CheckpointListArgs>,
  ): Promise<z.infer<typeof CheckpointListResult>> {
    const parsed = CheckpointListArgs.parse(args);
    const workspace = await realpath(parsed.workspace);
    const root = await ensureAppDataDir(this.#options.appDataDir);
    const records = await workspaceRecords(
      root,
      workspaceKey(workspace),
      this.#options.onError,
      parsed.threadId,
    );
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
    const current = await scanWorkspace(this.#options.gitBinary, workspace, root);
    const held = await this.#heldPaths(record, root, workspace);
    return this.#diff(
      record,
      args.workspace,
      current.manifest,
      current.excluded,
      record.includedPaths.filter((item) => held.has(item.path)),
    );
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
    const current = await scanWorkspace(this.#options.gitBinary, workspace, root);
    let included: SnapshotPath[] = [];
    if (record !== null) {
      const held = await this.#heldPaths(record, root, workspace);
      if (args.operation !== "conversation-only") {
        const conflicts = await uncapturedConflicts(workspace, held, current.uncaptured);
        if (conflicts.length > 0) throw uncapturedConflictFailure(conflicts);
      }
      included = record.includedPaths.filter((item) => held.has(item.path));
    }
    const diff =
      record === null
        ? null
        : this.#diff(record, args.workspace, current.manifest, current.excluded, included);
    const plan = RestorePlanSchema.parse({
      planId: `restore-${randomUUID()}`,
      workspace: args.workspace,
      operation: args.operation,
      snapshotId: args.snapshotId,
      currentConversation: args.currentConversation,
      targetConversation: args.targetConversation,
      currentWorkspaceHash: manifestHash(current.manifest),
      targetWorkspaceHash: record?.workspaceHash ?? null,
      includedPaths: included,
      excludedPaths: uniqueExcluded([...(record?.excludedPaths ?? []), ...current.excluded]),
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
    const current = await scanWorkspace(this.#options.gitBinary, workspace, root);
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

    const targetGitDir = shadowGitDir(root, snapshot.workspaceKey, snapshot.ompSessionId);
    const held = await treePaths(
      this.#options.gitBinary,
      targetGitDir,
      workspace,
      snapshot.shadowTreeId,
    );
    const conflicts = await uncapturedConflicts(workspace, held, current.uncaptured);
    if (conflicts.length > 0) throw uncapturedConflictFailure(conflicts);
    const included = snapshot.includedPaths.filter((item) => held.has(item.path));

    let undoSnapshot: SnapshotRecord | null = null;
    const changedPaths: string[] = [];
    try {
      undoSnapshot = await this.snapshot({
        workspace: plan.workspace,
        conversation: plan.currentConversation,
        source: "pre-restore",
        pinned: false,
      });
      const afterUndoSnapshot = await scanWorkspace(this.#options.gitBinary, workspace, root);
      if (manifestHash(afterUndoSnapshot.manifest) !== plan.currentWorkspaceHash)
        throw failure("conflict", "Workspace changed since the restore plan was created.", true);
      const wanted = new Set(included.map((item) => item.path));
      const before = new Map(current.manifest.map((item) => [item.relativePath, item]));
      for (const item of current.manifest) {
        if (!wanted.has(item.relativePath)) changedPaths.push(item.relativePath);
      }
      for (const item of included) {
        const now = before.get(item.path);
        if (
          now === undefined ||
          now.hash !== item.hash ||
          now.mode !== item.mode ||
          now.kind !== item.kind
        )
          changedPaths.push(item.path);
      }
      // Each path removed here is in the undo snapshot captured above, so Undo can bring it back.
      for (const item of current.manifest) {
        if (!wanted.has(item.relativePath))
          await rm(join(workspace, item.relativePath), { recursive: true, force: true });
      }
      // Read the change from the index of the session that took the undo snapshot: it describes
      // this workspace now. The target session's index can list files that are ignored now, and
      // read-tree would delete them. The target's trees are read through its object store.
      const undoGitDir = shadowGitDir(
        root,
        workspaceKey(workspace),
        plan.currentConversation.threadId,
      );
      await runGit(
        this.#options.gitBinary,
        undoGitDir,
        workspace,
        ["read-tree", "--reset", "-u", snapshot.shadowTreeId],
        {
          alternateObjectDirs:
            resolve(undoGitDir) === resolve(targetGitDir) ? [] : [join(targetGitDir, "objects")],
        },
      );
      for (const listener of [...this.#listeners]) listener(snapshot, "restored", plan.workspace);
      return {
        planId: plan.planId,
        operation: plan.operation,
        filesRestored: true,
        conversationRestored: false,
        capturedPathCount: included.length,
        excludedPaths: plan.excludedPaths.map((item) => item.path),
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
    const records = await workspaceRecords(root, workspaceKey(workspace), this.#options.onError);
    const record = records.find((item) => item.snapshotId === snapshotId);
    if (record === undefined) throw failure("not_found", "Snapshot not found");
    return record;
  }

  /** Paths the snapshot's own tree holds; older records also listed ignored files their tree lacks. */
  async #heldPaths(record: SnapshotRecord, root: string, workspace: string): Promise<Set<string>> {
    return treePaths(
      this.#options.gitBinary,
      shadowGitDir(root, record.workspaceKey, record.ompSessionId),
      workspace,
      record.shadowTreeId,
    );
  }

  #diff(
    record: SnapshotRecord,
    workspace: FolderPath,
    current: readonly ManifestEntry[],
    excludedPaths: readonly ExcludedPath[],
    included: readonly SnapshotPath[],
  ): CheckpointDiff {
    const before = new Map(included.map((item) => [item.path, item]));
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
      excludedPaths: uniqueExcluded([...record.excludedPaths, ...excludedPaths]),
      externalChanges: [],
      currentWorkspaceHash: manifestHash(current),
      snapshotWorkspaceHash: record.workspaceHash,
    };
  }
}

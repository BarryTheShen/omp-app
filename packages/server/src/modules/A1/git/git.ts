import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { AppFailure } from "@omp-app/contracts";

export const DEFAULT_GIT_TIMEOUT_MS = 5_000;

export type WorkspaceStateStatus = "ready" | "not-repository" | "git-unavailable";

export type GitReadErrorCode = "not-repository" | "git-unavailable";

export interface GitReadError {
  readonly code: GitReadErrorCode;
  readonly message: string;
  /** The git operation that failed, without user-supplied paths or command output. */
  readonly operation: string;
}

export interface GitReadOptions {
  /** Maximum wall-clock time for the complete read, in milliseconds. */
  readonly timeoutMs?: number;
  /** Mostly useful for tests and packaged git installations. Defaults to `git`. */
  readonly gitBinary?: string;
  /** Environment overrides for the git child process. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface GitBranchState {
  readonly name: string | null;
  readonly detached: boolean;
  /** True when HEAD points at a branch that does not have a commit yet. */
  readonly unborn: boolean;
}

export type GitFileKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "untracked";

/** One tracked or untracked path from porcelain-v2 status. */
export interface GitFileState {
  readonly path: string;
  readonly originalPath?: string;
  readonly kind: GitFileKind;
  /** The index status character (`.` and space both mean unchanged). */
  readonly index: string;
  /** The worktree status character (`.` and space both mean unchanged). */
  readonly worktree: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
}

export interface GitStatusSummary {
  readonly tracked: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

export interface GitWorktreeState {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason?: string;
  readonly prunable: boolean;
  readonly pruneReason?: string;
}

export interface GitCommitState {
  readonly id: string;
  readonly shortId: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: string;
}

export interface GitState {
  /** The repository root, or the bare repository directory for a bare repository. */
  readonly root: string;
  readonly gitDir: string;
  readonly isBare: boolean;
  /** The current HEAD object id, or null for an unborn branch. */
  readonly head: string | null;
  readonly branch: GitBranchState;
  readonly upstream: string | null;
  /** Null means that no upstream is configured (or the repository has no commit). */
  readonly ahead: number | null;
  readonly behind: number | null;
  /** Null for a bare repository, which has no worktree to inspect. */
  readonly dirty: boolean | null;
  readonly files: readonly GitFileState[];
  readonly untracked: readonly string[];
  readonly summary: GitStatusSummary | null;
  readonly worktrees: readonly GitWorktreeState[];
  readonly lastCommit: GitCommitState | null;
}

export interface WorkspaceState {
  /** The resolved folder supplied to the reader. */
  readonly path: string;
  readonly status: WorkspaceStateStatus;
  readonly git: GitState | null;
  readonly error?: GitReadError;
}

type CommandResult =
  | {
      readonly kind: "ok";
      readonly exitCode: 0;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "exit";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "timeout";
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "spawn-error";
      readonly exitCode: null;
      readonly stdout: string;
      readonly stderr: string;
      readonly message: string;
      readonly missing: boolean;
      readonly cause: unknown;
    };

type ParsedStatus = {
  readonly branchOid: string | null;
  readonly unborn: boolean;
  readonly branchHead: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly files: readonly GitFileState[];
};

type ParsedWorktrees =
  | { readonly ok: true; readonly value: readonly GitWorktreeState[] }
  | { readonly ok: false; readonly message: string };

/**
 * Read the local workspace and git metadata without invoking a shell or mutating the repository.
 *
 * Git status runs with `GIT_OPTIONAL_LOCKS=0`; this is important because a normal `git status`
 * may refresh and write the index. Not-a-repository and missing-git conditions are typed states;
 * timeout and unexpected command failures are thrown as AppFailure.
 */
export async function readWorkspaceState(
  folder: string,
  options: GitReadOptions = {},
): Promise<WorkspaceState> {
  try {
    return await readWorkspaceStateInner(folder, options);
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw new AppFailure(
      {
        code: "internal",
        message: "Unable to read Git workspace state.",
        retryable: false,
      },
      { cause: error },
    );
  }
}

async function readWorkspaceStateInner(
  folder: string,
  options: GitReadOptions,
): Promise<WorkspaceState> {
  const path = resolve(folder);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;

  const run = (args: readonly string[]): Promise<CommandResult> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.resolve({
        kind: "timeout",
        exitCode: null,
        stdout: "",
        stderr: "",
      });
    }
    return runGit(path, args, options, remaining);
  };

  const probe = await run(["rev-parse", "--is-inside-work-tree", "--is-bare-repository"]);
  if (probe.kind !== "ok") {
    if (probe.kind === "exit" && isNotRepository(probe.stderr)) {
      return notRepository(path, "probe");
    }
    return failedState(path, "probe", probe);
  }

  const probeValues = probe.stdout.split(/\r?\n/).filter((value) => value.length > 0);
  const isWorkTree = probeValues[0] === "true";
  const isBare = probeValues[1] === "true";
  if ((!isWorkTree && !isBare) || probeValues.length < 2) {
    return failedState(path, "probe", {
      kind: "exit",
      exitCode: 1,
      stdout: probe.stdout,
      stderr: "git returned an invalid repository-kind response",
    });
  }

  const gitDirResult = await run(["rev-parse", "--git-dir"]);
  if (gitDirResult.kind !== "ok") {
    return failedState(path, "git-dir", gitDirResult);
  }
  const gitDirValue = stripTrailingLineFeed(gitDirResult.stdout);
  if (gitDirValue.length === 0) {
    return failedState(path, "git-dir", {
      kind: "exit",
      exitCode: 1,
      stdout: gitDirResult.stdout,
      stderr: "git returned an empty git directory",
    });
  }
  const gitDir = isAbsolute(gitDirValue) ? gitDirValue : resolve(path, gitDirValue);

  let root: string;
  if (isBare) {
    root = path;
  } else {
    const rootResult = await run(["rev-parse", "--show-toplevel"]);
    if (rootResult.kind !== "ok") {
      return failedState(path, "root", rootResult);
    }
    const rootValue = stripTrailingLineFeed(rootResult.stdout);
    if (rootValue.length === 0) {
      return failedState(path, "root", {
        kind: "exit",
        exitCode: 1,
        stdout: rootResult.stdout,
        stderr: "git returned an empty repository root",
      });
    }
    root = isAbsolute(rootValue) ? rootValue : resolve(path, rootValue);
  }

  const status = isBare ? null : await readStatus(run);
  if (status && !status.ok) {
    return failedState(path, "status", status.result);
  }

  const worktreesResult = await readWorktrees(run);
  if (!worktreesResult.ok) {
    return failedState(path, "worktrees", worktreesResult.result);
  }

  let head: string | null;
  let branch: GitBranchState;
  let upstream: string | null;
  let ahead: number | null;
  let behind: number | null;
  let unborn: boolean;

  if (status?.ok) {
    head = status.value.branchOid;
    unborn = status.value.unborn;
    branch = branchFromStatus(status.value);
    upstream = status.value.upstream;
    ahead = status.value.ahead;
    behind = status.value.behind;
  } else {
    const bareHead = await readBareHead(run);
    if (!bareHead.ok) {
      return failedState(path, "head", bareHead.result);
    }
    head = bareHead.value.head;
    branch = bareHead.value.branch;
    unborn = bareHead.value.unborn;
    upstream = null;
    ahead = null;
    behind = null;

    if (head !== null && branch.name !== null && !branch.detached) {
      const upstreamResult = await readUpstream(run);
      if (!upstreamResult.ok) {
        return failedState(path, "upstream", upstreamResult.result);
      }
      upstream = upstreamResult.value;
      if (upstream !== null) {
        const counts = await readAheadBehind(run);
        if (!counts.ok) {
          return failedState(path, "ahead-behind", counts.result);
        }
        ahead = counts.value.ahead;
        behind = counts.value.behind;
      }
    }
  }

  const commit = unborn || head === null ? null : await readLastCommit(run);
  if (commit && !commit.ok) {
    return failedState(path, "last-commit", commit.result);
  }

  const files = status?.ok ? status.value.files : [];
  const summary = status?.ok ? summarize(files) : null;
  const untracked = status?.ok
    ? files.filter((file) => file.kind === "untracked").map((file) => file.path)
    : [];

  return {
    path,
    status: "ready",
    git: {
      root,
      gitDir,
      isBare,
      head,
      branch: { ...branch, unborn },
      upstream,
      ahead,
      behind,
      dirty: isBare ? null : files.length > 0,
      files,
      untracked,
      summary,
      worktrees: worktreesResult.value,
      lastCommit: commit?.ok ? commit.value : null,
    },
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GIT_TIMEOUT_MS;
  return Math.max(1, Math.floor(value));
}

/** Settings that keep a folder's own git config from running programs while the app reads its state. */
export const GIT_SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitReadOptions,
  timeoutMs: number,
): Promise<CommandResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";

  const command = await resolveGitBinary(options.gitBinary ?? "git", env.PATH, cwd);
  if (command === null) {
    const cause = new Error("git executable was not found");
    return {
      kind: "spawn-error",
      exitCode: null,
      stdout: "",
      stderr: "",
      message: cause.message,
      missing: true,
      cause,
    };
  }

  let child: Bun.Subprocess;
  try {
    // A folder's own `.git/config` may name programs git runs (an fsmonitor, hooks): reading a folder never runs them.
    child = Bun.spawn([command, ...GIT_SAFE_CONFIG, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    return {
      kind: "spawn-error",
      exitCode: null,
      stdout: "",
      stderr: "",
      message,
      missing: code === "ENOENT" || /not found/i.test(message),
      cause: error,
    };
  }

  let timedOut = false;
  let killError: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch (error) {
      killError = error instanceof Error ? error.message : String(error);
    }
  }, timeoutMs);

  const stdoutPromise = streamText(child.stdout);
  const stderrPromise = streamText(child.stderr);
  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const outputError = killError ? `${stderr}${stderr.length > 0 ? "\n" : ""}${killError}` : stderr;

  if (timedOut) {
    return { kind: "timeout", exitCode, stdout, stderr: outputError };
  }
  if (exitCode === 0) return { kind: "ok", exitCode: 0, stdout, stderr: outputError };
  return { kind: "exit", exitCode, stdout, stderr: outputError };
}

async function resolveGitBinary(
  binary: string,
  pathValue: string | undefined,
  cwd: string,
): Promise<string | null> {
  const candidates =
    isAbsolute(binary) || binary.includes("/")
      ? [isAbsolute(binary) ? binary : resolve(cwd, binary)]
      : (pathValue ?? "")
          .split(delimiter)
          .filter((directory) => directory.length > 0)
          .map((directory) => resolve(directory, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Inaccessible PATH entries are not candidates; continue with the next one.
    }
  }
  return null;
}

async function streamText(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (stream === null || stream === undefined || typeof stream === "number") return "";
  return new Response(stream).text();
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function stripTrailingLineFeed(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function isNotRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

function notRepository(path: string, operation: string): WorkspaceState {
  return {
    path,
    status: "not-repository",
    git: null,
    error: {
      code: "not-repository",
      message: "The folder is not a Git repository.",
      operation,
    },
  };
}

function failedState(path: string, operation: string, result: CommandResult): WorkspaceState {
  if (result.kind === "spawn-error" && result.missing) {
    return {
      path,
      status: "git-unavailable",
      git: null,
      error: {
        code: "git-unavailable",
        message: "The git executable is not available on PATH.",
        operation,
      },
    };
  }
  if (result.kind === "timeout") {
    throw new AppFailure(
      { code: "timeout", message: "The git operation timed out.", retryable: true },
      { cause: commandCause(operation, result) },
    );
  }
  throw new AppFailure(
    { code: "internal", message: "Unable to read Git workspace state.", retryable: false },
    { cause: commandCause(operation, result) },
  );
}

function commandCause(operation: string, result: CommandResult): unknown {
  if (result.kind === "spawn-error") return result.cause;
  const detail = result.stderr.trim();
  return new Error(detail.length > 0 ? `${operation}: ${detail}` : `${operation} failed`);
}

async function readStatus(
  run: (args: readonly string[]) => Promise<CommandResult>,
): Promise<
  | { readonly ok: true; readonly value: ParsedStatus }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const result = await run(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]);
  if (result.kind !== "ok") return { ok: false, result };
  const parsed = parseStatus(result.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      result: {
        kind: "exit",
        exitCode: 1,
        stdout: result.stdout,
        stderr: parsed.message,
      },
    };
  }
  return parsed;
}

function parseStatus(
  output: string,
):
  | { readonly ok: true; readonly value: ParsedStatus }
  | { readonly ok: false; readonly message: string } {
  let branchOid: string | null = null;
  let unborn = false;
  let branchHead: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const files: GitFileState[] = [];

  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.startsWith("# ")) {
      const separator = record.indexOf(" ", 2);
      if (separator < 0) continue;
      const key = record.slice(2, separator);
      const value = record.slice(separator + 1);
      if (key === "branch.oid") {
        if (value === "(initial)") {
          branchOid = null;
          unborn = true;
        } else {
          branchOid = value;
        }
      } else if (key === "branch.head") {
        branchHead = value;
      } else if (key === "branch.upstream") {
        upstream = value;
      } else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    const type = record[0];
    if (type === "?" || type === "!") {
      const path = record.startsWith(`${type} `) ? record.slice(2) : record.slice(1);
      if (type === "?") {
        files.push({
          path,
          kind: "untracked",
          index: "?",
          worktree: "?",
          staged: false,
          unstaged: true,
        });
      }
      continue;
    }

    if (type === "1") {
      const fixed = takeFields(record, 8);
      if (!fixed) return { ok: false, message: "Malformed ordinary porcelain-v2 record." };
      const xy = fixed.fields[1];
      if (xy?.length !== 2) return { ok: false, message: "Malformed ordinary status code." };
      const indexStatus = xy[0] ?? ".";
      const worktreeStatus = xy[1] ?? ".";
      files.push(makeFileState(fixed.rest, indexStatus, worktreeStatus, undefined, "ordinary"));
      continue;
    }

    if (type === "2") {
      const fixed = takeFields(record, 9);
      const originalPath = records[index + 1];
      if (!fixed || originalPath === undefined) {
        return { ok: false, message: "Malformed rename/copy porcelain-v2 record." };
      }
      const xy = fixed.fields[1];
      if (xy?.length !== 2) return { ok: false, message: "Malformed rename status code." };
      index += 1;
      files.push(makeFileState(fixed.rest, xy[0] ?? ".", xy[1] ?? ".", originalPath, "rename"));
      continue;
    }

    if (type === "u") {
      const fixed = takeFields(record, 10);
      if (!fixed) return { ok: false, message: "Malformed unmerged porcelain-v2 record." };
      const xy = fixed.fields[1];
      if (xy?.length !== 2) return { ok: false, message: "Malformed unmerged status code." };
      files.push(makeFileState(fixed.rest, xy[0] ?? "U", xy[1] ?? "U", undefined, "unmerged"));
    }

    // Git may add a future record kind. Keep known data intact and do not turn it into a fake path.
  }

  return {
    ok: true,
    value: { branchOid, unborn, branchHead, upstream, ahead, behind, files },
  };
}

function takeFields(
  value: string,
  count: number,
): { readonly fields: readonly string[]; readonly rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const separator = value.indexOf(" ", start);
    if (separator < 0) return null;
    fields.push(value.slice(start, separator));
    start = separator + 1;
  }
  return { fields, rest: value.slice(start) };
}

function makeFileState(
  path: string,
  indexStatus: string,
  worktreeStatus: string,
  originalPath: string | undefined,
  recordKind: "ordinary" | "rename" | "unmerged",
): GitFileState {
  let kind: GitFileKind;
  if (recordKind === "unmerged") kind = "unmerged";
  else if (recordKind === "rename" && (indexStatus === "C" || worktreeStatus === "C"))
    kind = "copied";
  else if (recordKind === "rename") kind = "renamed";
  else if (indexStatus === "A" || worktreeStatus === "A") kind = "added";
  else if (indexStatus === "D" || worktreeStatus === "D") kind = "deleted";
  else kind = "modified";

  return {
    path,
    ...(originalPath === undefined ? {} : { originalPath }),
    kind,
    index: indexStatus,
    worktree: worktreeStatus,
    staged: indexStatus !== "." && indexStatus !== " " && indexStatus !== "?",
    unstaged: worktreeStatus !== "." && worktreeStatus !== " " && worktreeStatus !== "?",
  };
}

function branchFromStatus(status: ParsedStatus): GitBranchState {
  const detached =
    status.branchHead === null ||
    status.branchHead === "(detached)" ||
    status.branchHead === "(unknown)";
  return {
    name: detached ? null : status.branchHead,
    detached,
    unborn: status.unborn,
  };
}

function summarize(files: readonly GitFileState[]): GitStatusSummary {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const file of files) {
    if (file.kind === "untracked") untracked += 1;
    else {
      if (file.staged) staged += 1;
      if (file.unstaged) unstaged += 1;
    }
    if (file.kind === "unmerged") conflicted += 1;
  }
  return {
    tracked: files.length - untracked,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

async function readWorktrees(
  run: (args: readonly string[]) => Promise<CommandResult>,
): Promise<
  | { readonly ok: true; readonly value: readonly GitWorktreeState[] }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const nulResult = await run(["worktree", "list", "--porcelain", "-z"]);
  if (nulResult.kind === "ok") {
    const parsed = parseWorktrees(nulResult.stdout, true);
    return parsed.ok
      ? parsed
      : {
          ok: false,
          result: {
            kind: "exit",
            exitCode: 1,
            stdout: nulResult.stdout,
            stderr: parsed.message,
          },
        };
  }

  // Git versions predating worktree's -z option still support the porcelain format. The fallback
  // keeps old installations usable; status itself always remains NUL-delimited.
  if (nulResult.kind !== "exit" || !/unknown|invalid|usage|option/i.test(nulResult.stderr)) {
    return { ok: false, result: nulResult };
  }
  const textResult = await run(["worktree", "list", "--porcelain"]);
  if (textResult.kind !== "ok") return { ok: false, result: textResult };
  const parsed = parseWorktrees(textResult.stdout, false);
  return parsed.ok
    ? parsed
    : {
        ok: false,
        result: {
          kind: "exit",
          exitCode: 1,
          stdout: textResult.stdout,
          stderr: parsed.message,
        },
      };
}

function parseWorktrees(output: string, nulDelimited: boolean): ParsedWorktrees {
  const records = nulDelimited
    ? output.split("\0").filter((record) => record.length > 0)
    : output.split(/\r?\n/);
  const worktrees: GitWorktreeState[] = [];
  let current: MutableWorktree | null = null;

  const finish = () => {
    if (current === null) return;
    worktrees.push({
      path: current.path,
      head: current.head,
      branch: current.branch,
      detached: current.detached,
      bare: current.bare,
      locked: current.locked,
      ...(current.lockReason === undefined ? {} : { lockReason: current.lockReason }),
      prunable: current.prunable,
      ...(current.pruneReason === undefined ? {} : { pruneReason: current.pruneReason }),
    });
    current = null;
  };

  for (const record of records) {
    if (record.length === 0) continue;
    const separator = record.indexOf(" ");
    const key = separator < 0 ? record : record.slice(0, separator);
    const value = separator < 0 ? "" : record.slice(separator + 1);
    if (key === "worktree") {
      finish();
      if (value.length === 0) return { ok: false, message: "Malformed worktree path." };
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) continue;
    if (key === "HEAD") current.head = value || null;
    else if (key === "branch")
      current.branch = value.startsWith("refs/heads/") ? value.slice(11) : value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      current.lockReason = value || undefined;
    } else if (key === "prunable") {
      current.prunable = true;
      current.pruneReason = value || undefined;
    }
  }
  finish();
  return { ok: true, value: worktrees };
}

type MutableWorktree = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  pruneReason?: string;
};

async function readBareHead(run: (args: readonly string[]) => Promise<CommandResult>): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly head: string | null;
        readonly branch: GitBranchState;
        readonly unborn: boolean;
      };
    }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const branchResult = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let branchName: string | null = null;
  let detached = false;
  if (branchResult.kind === "ok") {
    branchName = stripTrailingLineFeed(branchResult.stdout);
    if (branchName.length === 0) branchName = null;
  } else if (branchResult.kind === "exit" && branchResult.exitCode === 1) {
    detached = true;
  } else {
    return { ok: false, result: branchResult };
  }

  const headResult = await run(["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (headResult.kind === "ok") {
    const head = stripTrailingLineFeed(headResult.stdout);
    return {
      ok: true,
      value: {
        head: head || null,
        branch: { name: detached ? null : branchName, detached, unborn: false },
        unborn: false,
      },
    };
  }
  if (headResult.kind === "exit") {
    return {
      ok: true,
      value: {
        head: null,
        branch: { name: detached ? null : branchName, detached, unborn: !detached },
        unborn: !detached,
      },
    };
  }
  return { ok: false, result: headResult };
}

async function readUpstream(
  run: (args: readonly string[]) => Promise<CommandResult>,
): Promise<
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const result = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (result.kind === "ok") {
    const value = stripTrailingLineFeed(result.stdout);
    return { ok: true, value: value || null };
  }
  if (result.kind === "exit" && isNoUpstream(result.stderr)) return { ok: true, value: null };
  return { ok: false, result };
}

async function readAheadBehind(
  run: (args: readonly string[]) => Promise<CommandResult>,
): Promise<
  | { readonly ok: true; readonly value: { readonly ahead: number; readonly behind: number } }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const result = await run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  if (result.kind !== "ok") return { ok: false, result };
  const values = stripTrailingLineFeed(result.stdout).trim().split(/\s+/);
  const ahead = Number(values[0]);
  const behind = Number(values[1]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || ahead < 0 || behind < 0) {
    return {
      ok: false,
      result: {
        kind: "exit",
        exitCode: 1,
        stdout: result.stdout,
        stderr: "git returned an invalid ahead/behind response",
      },
    };
  }
  return { ok: true, value: { ahead, behind } };
}

async function readLastCommit(
  run: (args: readonly string[]) => Promise<CommandResult>,
): Promise<
  | { readonly ok: true; readonly value: GitCommitState | null }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const result = await run([
    "log",
    "-1",
    "--format=%H%x00%h%x00%aI%x00%cI%x00%an%x00%ae%x00%cn%x00%ce%x00%s",
  ]);
  if (result.kind !== "ok") {
    if (result.kind === "exit" && isNoHead(result.stderr)) return { ok: true, value: null };
    return { ok: false, result };
  }
  const fields = stripTrailingLineFeed(result.stdout).split("\0");
  if (fields.length < 9 || fields.slice(0, 9).some((field) => field.length === 0)) {
    return {
      ok: false,
      result: {
        kind: "exit",
        exitCode: 1,
        stdout: result.stdout,
        stderr: "git returned an invalid last-commit response",
      },
    };
  }
  return {
    ok: true,
    value: {
      id: fields[0] ?? "",
      shortId: fields[1] ?? "",
      authoredAt: fields[2] ?? "",
      committedAt: fields[3] ?? "",
      authorName: fields[4] ?? "",
      authorEmail: fields[5] ?? "",
      committerName: fields[6] ?? "",
      committerEmail: fields[7] ?? "",
      subject: fields[8] ?? "",
    },
  };
}

function isNoHead(stderr: string): boolean {
  return /does not have any commits yet|bad default revision|ambiguous argument ['"]?HEAD|needed a single revision/i.test(
    stderr,
  );
}

function isNoUpstream(stderr: string): boolean {
  return /no upstream configured|does not have an upstream|no such ref/i.test(stderr);
}

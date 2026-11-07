import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AppFailure } from "@omp-app/contracts";
import { readWorkspaceState, type WorkspaceState } from "./git";

const dataRoot = resolve(import.meta.dir, "../../../../../../.data");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("readWorkspaceState", () => {
  test("returns a useful empty result for a folder that is not a repository", async () => {
    const folder = await temporaryDirectory();

    const state = await readWorkspaceState(folder, { env: { GIT_CEILING_DIRECTORIES: dataRoot } });

    expect(state.status).toBe("not-repository");
    expect(state.git).toBeNull();
    expect(state.error?.code).toBe("not-repository");
  });

  test("reports an unborn branch without treating it as an error", async () => {
    const folder = await temporaryDirectory();
    await git(folder, ["init", "-q", "-b", "trunk"]);

    const state = await readWorkspaceState(folder);

    expect(state.status).toBe("ready");
    expect(state.git).toMatchObject({
      root: folder,
      isBare: false,
      head: null,
      branch: { name: "trunk", detached: false, unborn: true },
      upstream: null,
      ahead: null,
      behind: null,
      dirty: false,
      files: [],
      untracked: [],
      lastCommit: null,
    });
  });

  test("reads a bare repository without trying worktree-only commands", async () => {
    const parent = await temporaryDirectory();
    const bare = join(parent, "bare.git");
    await git(parent, ["init", "-q", "--bare", "-b", "trunk", bare]);

    const state = await readWorkspaceState(bare);

    expect(state.status).toBe("ready");
    expect(state.git).toMatchObject({
      root: bare,
      gitDir: bare,
      isBare: true,
      head: null,
      branch: { name: "trunk", detached: false, unborn: true },
      dirty: null,
      files: [],
      untracked: [],
      summary: null,
      lastCommit: null,
    });
    expect(state.git?.worktrees).toEqual([
      expect.objectContaining({ path: bare, bare: true, head: null, branch: null }),
    ]);
  });

  test("reads branch, upstream, ahead/behind, worktrees, commit and NUL-safe paths", async () => {
    const parent = await temporaryDirectory();
    const folder = join(parent, "workspace");
    const remote = join(parent, "remote.git");
    const other = join(parent, "other");
    const linked = join(parent, "linked");
    await mkdir(folder);
    await git(folder, ["init", "-q", "-b", "main"]);
    await git(folder, ["config", "user.email", "test@example.com"]);
    await git(folder, ["config", "user.name", "Test User"]);
    await Bun.write(join(folder, "tracked.txt"), "base\n");
    await git(folder, ["add", "tracked.txt"]);
    await git(folder, ["commit", "-qm", "base commit"]);
    await git(parent, ["init", "-q", "--bare", "-b", "main", remote]);
    await git(folder, ["remote", "add", "origin", remote]);
    await git(folder, ["push", "-q", "-u", "origin", "main"]);

    await Bun.write(join(folder, "tracked.txt"), "local\n");
    await git(folder, ["add", "tracked.txt"]);
    await git(folder, ["commit", "-qm", "local commit"]);
    await git(parent, ["clone", "-q", remote, other]);
    await git(other, ["config", "user.email", "other@example.com"]);
    await git(other, ["config", "user.name", "Other User"]);
    await Bun.write(join(other, "remote.txt"), "remote\n");
    await git(other, ["add", "remote.txt"]);
    await git(other, ["commit", "-qm", "remote commit"]);
    await git(other, ["push", "-q", "origin", "HEAD:main"]);
    await git(folder, ["fetch", "-q", "origin"]);

    await git(folder, ["worktree", "add", "-q", "-b", "side", linked, "HEAD"]);
    await Bun.write(join(folder, "tracked.txt"), "working-tree change\n");
    const newlinePath = "odd\nname.txt";
    const spacePath = " leading and trailing .txt ";
    await Bun.write(join(folder, newlinePath), "newline\n");
    await Bun.write(join(folder, spacePath), "spaces\n");

    const state = await readWorkspaceState(folder);
    const commitId = await git(folder, ["rev-parse", "HEAD"]);
    const filePaths = state.git?.files.map((file) => file.path) ?? [];

    expect(state.status).toBe("ready");
    expect(state.git).toMatchObject({
      root: folder,
      isBare: false,
      head: commitId,
      branch: { name: "main", detached: false, unborn: false },
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
      dirty: true,
      summary: { tracked: 1, staged: 0, unstaged: 1, untracked: 2, conflicted: 0 },
      lastCommit: { id: commitId, subject: "local commit" },
    });
    expect(state.git?.untracked).toEqual(expect.arrayContaining([newlinePath, spacePath]));
    expect(filePaths).toEqual(expect.arrayContaining(["tracked.txt", newlinePath, spacePath]));
    expect(state.git?.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: folder, branch: "main", bare: false }),
        expect.objectContaining({ path: linked, branch: "side", bare: false }),
      ]),
    );
  });

  test("reports a detached HEAD and keeps the last commit", async () => {
    const folder = await committedRepository();
    await git(folder, ["checkout", "-q", "--detach", "HEAD"]);

    const state = await readWorkspaceState(folder);

    expect(state.status).toBe("ready");
    expect(state.git?.branch).toEqual({ name: null, detached: true, unborn: false });
    expect(state.git?.head).toBeTruthy();
    expect(state.git?.lastCommit?.subject).toBe("initial commit");
  });

  test("reports a missing git executable", async () => {
    const folder = await committedRepository();

    const state = await readWorkspaceState(folder, {
      gitBinary: "git-not-installed",
      env: { PATH: "" },
    });

    expect(state.status).toBe("git-unavailable");
    expect(state.git).toBeNull();
    expect(state.error?.code).toBe("git-unavailable");
  });

  test("times out and terminates a slow git executable", async () => {
    const folder = await temporaryDirectory();
    const slowGit = join(folder, "slow-git");
    await Bun.write(slowGit, "#!/bin/sh\nexec sleep 2\n");
    await chmod(slowGit, 0o755);
    const started = performance.now();
    let thrown: unknown;
    try {
      await readWorkspaceState(folder, { gitBinary: slowGit, timeoutMs: 40 });
    } catch (error) {
      thrown = error;
    }
    const elapsed = performance.now() - started;

    expect(thrown).toBeInstanceOf(AppFailure);
    expect(thrown).toMatchObject({
      appError: { code: "timeout", retryable: true },
    });
    expect(elapsed).toBeLessThan(1_000);
  });

  test("throws an internal AppFailure for an unexpected git error", async () => {
    const folder = await temporaryDirectory();
    const failingGit = join(folder, "failing-git");
    await Bun.write(failingGit, "#!/bin/sh\nprintf 'synthetic failure' >&2\nexit 42\n");
    await chmod(failingGit, 0o755);

    let thrown: unknown;
    try {
      await readWorkspaceState(folder, { gitBinary: failingGit });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppFailure);
    expect(thrown).toMatchObject({
      appError: { code: "internal", retryable: false },
    });
    expect((thrown as Error).message).toBe("Unable to read Git workspace state.");
    expect((thrown as Error).cause).toBeTruthy();
  });

  test("does not alter git metadata while reading", async () => {
    const folder = await committedRepository();
    const before = await snapshot(await readWorkspaceState(folder));

    const state = await readWorkspaceState(folder);
    const after = await snapshot(state);

    expect(state.status).toBe("ready");
    expect(after).toEqual(before);
  });

  test("runs no program a repository's own config names (an fsmonitor, hooks) while reading it", async () => {
    const folder = await committedRepository();
    const ran = join(folder, "..", `${folder.split("/").at(-1)}-ran`);
    temporaryRoots.push(ran);
    const program = join(folder, "monitor.sh");
    await Bun.write(program, `#!/bin/sh\ntouch '${ran}'\n`);
    await chmod(program, 0o755);
    await git(folder, ["config", "core.fsmonitor", program]);
    await Bun.write(join(folder, "tracked.txt"), "changed\n");

    const state = await readWorkspaceState(folder);

    expect(state.status).toBe("ready");
    expect(await Bun.file(ran).exists()).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = await mkdtemp(join(dataRoot, "a1-git-"));
  temporaryRoots.push(path);
  return path;
}

async function committedRepository(): Promise<string> {
  const folder = await temporaryDirectory();
  await git(folder, ["init", "-q", "-b", "main"]);
  await git(folder, ["config", "user.email", "test@example.com"]);
  await git(folder, ["config", "user.name", "Test User"]);
  await Bun.write(join(folder, "tracked.txt"), "initial\n");
  await git(folder, ["add", "tracked.txt"]);
  await git(folder, ["commit", "-qm", "initial commit"]);
  return folder;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout === null ? "" : new Response(child.stdout).text();
  const stderr = child.stderr === null ? "" : new Response(child.stderr).text();
  const [exitCode, output, error] = await Promise.all([child.exited, stdout, stderr]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${error}`);
  return output.trim();
}

type SnapshotEntry = {
  path: string;
  kind: "file" | "directory";
  bytes?: string;
  mtimeMs: number;
};

async function snapshot(state: WorkspaceState): Promise<SnapshotEntry[]> {
  const gitDir = state.git?.gitDir;
  if (gitDir === undefined) throw new Error("expected a repository");
  const entries: SnapshotEntry[] = [];
  await visit(gitDir, gitDir, entries);
  return entries;
}

async function visit(root: string, path: string, entries: SnapshotEntry[]): Promise<void> {
  const info = await stat(path);
  const relativePath = relative(root, path);
  if (info.isDirectory()) {
    entries.push({ path: relativePath, kind: "directory", mtimeMs: info.mtimeMs });
    const children = (await readdir(path)).sort();
    for (const child of children) await visit(root, join(path, child), entries);
    return;
  }
  entries.push({
    path: relativePath,
    kind: "file",
    bytes: Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64"),
    mtimeMs: info.mtimeMs,
  });
}

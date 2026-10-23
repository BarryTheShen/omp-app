import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppFailure, FileSearchResult } from "@omp-app/contracts";
import { searchWorkspaceFiles } from "./index";

const dataRoot = resolve(import.meta.dir, "../../../../../../.data");
const temporaryRoots: string[] = [];
const nonRepositoryOptions = {
  env: { GIT_CEILING_DIRECTORIES: dataRoot },
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("searchWorkspaceFiles", () => {
  test("uses Git's ignore rules and returns files and directories ranked by path", async () => {
    const folder = await temporaryDirectory();
    await mkdir(join(folder, "src"), { recursive: true });
    await mkdir(join(folder, "ignored"), { recursive: true });
    await write(join(folder, ".gitignore"), "ignored/\nnode_modules/\n");
    await write(join(folder, "src", "app.ts"), "export {}\n");
    await write(join(folder, "src", "apple.ts"), "export {}\n");
    await write(join(folder, "ignored", "app-secret.ts"), "secret\n");
    await git(folder, ["init", "-q", "-b", "main"]);
    await git(folder, ["config", "user.email", ["test", "example.invalid"].join("@")]);
    await git(folder, ["config", "user.name", "A1 Search Test"]);
    await git(folder, ["add", ".gitignore", "src"]);
    await git(folder, ["commit", "-qm", "seed"]);
    await write(join(folder, "src", "app-local.ts"), "export {}\n");

    const result = await searchWorkspaceFiles({ folder, query: "src/ap", limit: 20 });
    const paths = result.results.map((candidate) => candidate.path);

    expect(FileSearchResult.parse(result)).toEqual(result);
    expect(paths[0]).toBe("src/app.ts");
    expect(paths).toContain("src/apple.ts");
    expect(paths).toContain("src/app-local.ts");
    expect(paths).not.toContain("ignored/app-secret.ts");
    expect(paths.every((path) => !path.startsWith("/") && !path.includes(".."))).toBe(true);
    const directories = await searchWorkspaceFiles({ folder, query: "src", limit: 20 });
    expect(directories.results.map((candidate) => candidate.path)).toContain("src");
  });

  test("a folder that its own repository ignores is searched as a folder, not as an empty listing", async () => {
    const repository = await temporaryDirectory();
    await write(join(repository, ".gitignore"), "hidden/\n");
    await mkdir(join(repository, "hidden"), { recursive: true });
    await write(join(repository, "hidden", "README.md"), "# notes\n");
    await git(repository, ["init", "-q", "-b", "main"]);

    const result = await searchWorkspaceFiles({
      folder: join(repository, "hidden"),
      query: "readme",
      limit: 10,
    });
    expect(result.results.map((candidate) => candidate.path)).toContain("README.md");
  });

  test("ranks an exact basename ahead of longer fuzzy matches", async () => {
    const folder = await temporaryDirectory();
    await mkdir(join(folder, "src"), { recursive: true });
    await mkdir(join(folder, "docs"), { recursive: true });
    await write(join(folder, "alpha.ts"), "");
    await write(join(folder, "src", "alpha-helper.ts"), "");
    await write(join(folder, "docs", "alphabet.md"), "");

    const result = await searchWorkspaceFiles(
      { folder, query: "alpha", limit: 10 },
      nonRepositoryOptions,
    );

    expect(result.results[0]?.path).toBe("alpha.ts");
    expect(result.results.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining(["alpha.ts", "src/alpha-helper.ts", "docs/alphabet.md"]),
    );
    expect(result.results[0]?.score).toBeGreaterThan(result.results[1]?.score ?? 0);
  });

  test("enforces the result limit and rejects values over 200", async () => {
    const folder = await temporaryDirectory();
    for (let index = 0; index < 240; index += 1) {
      await write(join(folder, `entry-${String(index).padStart(3, "0")}.txt`), "");
    }

    const result = await searchWorkspaceFiles(
      { folder, query: "entry", limit: 200 },
      nonRepositoryOptions,
    );
    expect(result.results).toHaveLength(200);

    const error = await searchWorkspaceFiles({ folder, query: "entry", limit: 201 }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("invalid_args");
  });

  test("marks a bounded fallback walk as truncated", async () => {
    const folder = await temporaryDirectory();
    for (let index = 0; index < 10; index += 1) {
      await write(join(folder, `entry-${index}.txt`), "");
    }

    const result = await searchWorkspaceFiles(
      { folder, query: "entry", limit: 200 },
      { ...nonRepositoryOptions, scanLimit: 3 },
    );

    expect(result.truncated).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  test("uses the bounded non-repository walk and skips node_modules and .git", async () => {
    const folder = await temporaryDirectory();
    await mkdir(join(folder, "node_modules", "package"), { recursive: true });
    await mkdir(join(folder, ".git", "objects"), { recursive: true });
    await write(join(folder, "visible.ts"), "");
    await write(join(folder, "node_modules", "package", "hidden.ts"), "");
    await write(join(folder, ".git", "objects", "hidden.ts"), "");

    const result = await searchWorkspaceFiles(
      { folder, query: "", limit: 200 },
      nonRepositoryOptions,
    );
    const paths = result.results.map((candidate) => candidate.path);

    expect(paths).toContain("visible.ts");
    expect(paths.some((path) => path.startsWith("node_modules/") || path === "node_modules")).toBe(
      false,
    );
    expect(paths.some((path) => path.startsWith(".git/") || path === ".git")).toBe(false);
  });

  test("does not follow symlinks outside the workspace", async () => {
    const parent = await temporaryDirectory();
    const folder = join(parent, "workspace");
    const outside = join(parent, "outside");
    await mkdir(folder);
    await mkdir(outside);
    await write(join(outside, "secret.ts"), "");
    await symlink(outside, join(folder, "escape"));
    await write(join(folder, "safe.ts"), "");

    const result = await searchWorkspaceFiles(
      { folder, query: "secret", limit: 20 },
      nonRepositoryOptions,
    );

    expect(result.results).toEqual([]);
  });

  test("reports missing folders as not_found", async () => {
    const parent = await temporaryDirectory();
    const missing = join(parent, "missing");

    const error = await searchWorkspaceFiles({ folder: missing, query: "anything" }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("not_found");
  });

  test("cancels an in-flight git probe", async () => {
    const folder = await temporaryDirectory();
    const slowGit = join(folder, "slow-git");
    await write(slowGit, "#!/bin/sh\nsleep 2\n");
    await chmod(slowGit, 0o755);
    const controller = new AbortController();
    const pending = searchWorkspaceFiles(
      { folder, query: "anything" },
      { gitBinary: slowGit, signal: controller.signal, timeoutMs: 1_000 },
    );
    await Promise.resolve();
    controller.abort();

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("cancelled");
  });

  test("turns a slow git probe into a timeout AppFailure", async () => {
    const folder = await temporaryDirectory();
    const slowGit = join(folder, "slow-git");
    await write(slowGit, "#!/bin/sh\nsleep 2\n");
    await chmod(slowGit, 0o755);
    const started = performance.now();

    const error = await searchWorkspaceFiles(
      { folder, query: "anything" },
      { gitBinary: slowGit, timeoutMs: 30 },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a budget that expires while Git starts leaks no unhandled rejection", async () => {
    const folder = await temporaryDirectory();
    const slowGit = join(folder, "slow-git");
    await write(slowGit, "#!/bin/sh\nsleep 2\n");
    await chmod(slowGit, 0o755);
    const leaked: unknown[] = [];
    const recordLeak = (reason: unknown) => leaked.push(reason);
    process.on("unhandledRejection", recordLeak);
    try {
      // Deadlines of a few milliseconds run out while Git is still starting: its output readers
      // exist, but their first read has not been awaited yet.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const error = await searchWorkspaceFiles(
          { folder, query: "anything" },
          { gitBinary: slowGit, timeoutMs: 1 + (attempt % 6) },
        ).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(AppFailure);
      }
      await Bun.sleep(50);
    } finally {
      process.off("unhandledRejection", recordLeak);
    }
    expect(leaked).toEqual([]);
  });

  test("lists each depth before the next, so the scan limit reaches shallow files first", async () => {
    const folder = await temporaryDirectory();
    await mkdir(join(folder, "deep", "a", "b"), { recursive: true });
    await write(join(folder, "deep", "a", "b", "leaf.ts"), "");
    await write(join(folder, "top.ts"), "");

    const result = await searchWorkspaceFiles(
      { folder, query: "", limit: 200 },
      { ...nonRepositoryOptions, scanLimit: 4 },
    );
    const paths = pathsOf(result);

    expect(paths).toContain("top.ts");
    expect(paths).toContain("deep/a");
    expect(paths).not.toContain("deep/a/b/leaf.ts");
    expect(result.truncated).toBe(true);
  });

  test("skips dependency, cache and repository metadata folders by name", async () => {
    const folder = await temporaryDirectory();
    const skipped = [
      ".venv",
      "venv",
      "__pycache__",
      ".cache",
      ".mypy_cache",
      ".pytest_cache",
      ".tox",
      ".worktrees",
    ];
    for (const name of skipped) {
      await mkdir(join(folder, name), { recursive: true });
      await write(join(folder, name, "inside.ts"), "");
    }
    await write(join(folder, "visible.ts"), "");

    const result = await searchWorkspaceFiles(
      { folder, query: "", limit: 200 },
      nonRepositoryOptions,
    );

    expect(pathsOf(result)).toEqual(["visible.ts"]);
  });

  test("lists neither a symlinked folder nor the files it points to", async () => {
    const folder = await temporaryDirectory();
    await mkdir(join(folder, "real"), { recursive: true });
    await write(join(folder, "real", "target.ts"), "");
    await symlink(join(folder, "real"), join(folder, "alias"));

    const result = await searchWorkspaceFiles(
      { folder, query: "", limit: 200 },
      nonRepositoryOptions,
    );
    const paths = pathsOf(result);

    expect(paths).toContain("real/target.ts");
    expect(paths.some((path) => path === "alias" || path.startsWith("alias/"))).toBe(false);
  });

  test("answers a query within 30 seconds from the listing it cached, and lists again after", async () => {
    let now = 1_000_000;
    const options = { ...nonRepositoryOptions, now: () => now };
    const folder = await temporaryDirectory();
    await write(join(folder, "first.ts"), "");
    await searchWorkspaceFiles({ folder, query: "first" }, options);

    await write(join(folder, "second.ts"), "");
    now += 29_999;
    const within = await searchWorkspaceFiles({ folder, query: "second" }, options);
    expect(pathsOf(within)).not.toContain("second.ts");

    now += 1;
    const after = await searchWorkspaceFiles({ folder, query: "second" }, options);
    expect(pathsOf(after)).toContain("second.ts");
  });

  test("caches a git folder's listing for 30 seconds and keeps git's ignore rules", async () => {
    let now = 2_000_000;
    const options = { now: () => now };
    const repository = await temporaryDirectory();
    await write(join(repository, ".gitignore"), "ignored.ts\n");
    await write(join(repository, "tracked.ts"), "");
    await write(join(repository, "ignored.ts"), "");
    await git(repository, ["init", "-q", "-b", "main"]);

    const first = await searchWorkspaceFiles({ folder: repository, query: "" }, options);
    expect(pathsOf(first)).toContain("tracked.ts");

    await write(join(repository, "late.ts"), "");
    now += 1_000;
    const within = await searchWorkspaceFiles({ folder: repository, query: "" }, options);
    expect(pathsOf(within)).not.toContain("late.ts");
    expect(pathsOf(within)).not.toContain("ignored.ts");

    now += 29_000;
    const after = await searchWorkspaceFiles({ folder: repository, query: "" }, options);
    expect(pathsOf(after)).toContain("late.ts");
    expect(pathsOf(after)).not.toContain("ignored.ts");
  });

  test("keeps the eight most recent folders, so a ninth search drops the oldest listing", async () => {
    let now = 3_000_000;
    const options = { ...nonRepositoryOptions, now: () => now };
    const folders: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const folder = await temporaryDirectory();
      await write(join(folder, "seed.ts"), "");
      await searchWorkspaceFiles({ folder, query: "seed" }, options);
      folders.push(folder);
      now += 1;
    }
    const oldest = folders.at(0);
    const newest = folders.at(-1);
    if (oldest === undefined || newest === undefined) throw new Error("nine folders were searched");
    await write(join(oldest, "late-oldest.ts"), "");
    await write(join(newest, "late-newest.ts"), "");

    const evicted = await searchWorkspaceFiles({ folder: oldest, query: "late-oldest" }, options);
    const kept = await searchWorkspaceFiles({ folder: newest, query: "late-newest" }, options);

    expect(pathsOf(evicted)).toContain("late-oldest.ts");
    expect(pathsOf(kept)).not.toContain("late-newest.ts");
  });

  test("a bounded walk is not answered from an earlier unbounded listing of the same folder", async () => {
    const folder = await temporaryDirectory();
    for (let index = 0; index < 10; index += 1) {
      await write(join(folder, `entry-${index}.txt`), "");
    }
    await searchWorkspaceFiles({ folder, query: "entry", limit: 200 }, nonRepositoryOptions);

    const bounded = await searchWorkspaceFiles(
      { folder, query: "entry", limit: 200 },
      { ...nonRepositoryOptions, scanLimit: 3 },
    );

    expect(bounded.truncated).toBe(true);
    expect(bounded.results.length).toBeLessThanOrEqual(3);
  });
});

function pathsOf(result: FileSearchResult): string[] {
  return result.results.map((candidate) => candidate.path);
}

async function temporaryDirectory(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = await mkdtemp(join(dataRoot, "a1-file-search-"));
  temporaryRoots.push(path);
  return path;
}

async function write(path: string, contents: string): Promise<void> {
  await Bun.write(path, contents);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout =
    child.stdout === null || typeof child.stdout === "number"
      ? ""
      : new Response(child.stdout).text();
  const stderr =
    child.stderr === null || typeof child.stderr === "number"
      ? ""
      : new Response(child.stderr).text();
  const [exitCode, output, error] = await Promise.all([child.exited, stdout, stderr]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${error}`);
  return output.trim();
}

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
});

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

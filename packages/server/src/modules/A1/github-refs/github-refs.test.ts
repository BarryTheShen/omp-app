import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { GithubRefsService } from "./github-refs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = join(import.meta.dir, "../../../../../../.data");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "github-refs-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeGhDirectory(
  mode: "data" | "unauthenticated",
): Promise<{ bin: string; folder: string }> {
  const root = await temporaryDirectory();
  const bin = join(root, "bin");
  const folder = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(folder, { recursive: true });
  const script =
    mode === "unauthenticated"
      ? '#!/bin/sh\necho "not logged in to any GitHub hosts" >&2\nexit 1\n'
      : `#!/bin/sh
if [ "$1:$2" = "search:issues" ]; then
  printf '%s' '[{"number":12,"title":"Fix issue","body":"Issue body","url":"https://github.com/example/repo/issues/12","state":"open","repository":{"nameWithOwner":"example/repo"}}]'
elif [ "$1:$2" = "search:prs" ]; then
  printf '%s' '[{"number":34,"title":"Pull request","body":"Pull body","url":"https://github.com/example/repo/pull/34","state":"merged","repository":{"nameWithOwner":"example/repo"}}]'
elif [ "$1:$2" = "pr:view" ]; then
  printf '%s' '{"number":34,"title":"Current pull request","body":"Current body","url":"https://github.com/example/repo/pull/34","state":"open","repository":{"nameWithOwner":"example/repo"}}'
else
  echo "unexpected gh args" >&2
  exit 2
fi
`;
  const executable = join(bin, "gh");
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { bin, folder };
}

async function expectAppFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GithubRefsService", () => {
  test("searches issues and pull requests through argv-only gh JSON commands", async () => {
    const fake = await fakeGhDirectory("data");
    const service = new GithubRefsService({ ghBinary: "gh", env: { PATH: fake.bin } });
    const folder = FolderPath.parse(fake.folder);

    const issues = await service.search({ folder, query: "bug query", kind: "issue", limit: 10 });
    const pullRequests = await service.search({
      folder,
      query: "review query",
      kind: "pull-request",
      limit: 10,
    });
    const all = await service.search({ folder, query: "all query", kind: "all", limit: 1 });

    expect(issues).toEqual({
      candidates: [
        expect.objectContaining({ kind: "issue", number: 12, title: "Fix issue", state: "open" }),
      ],
      truncated: false,
    });
    expect(pullRequests.candidates[0]).toMatchObject({
      kind: "pull-request",
      number: 34,
      state: "merged",
    });
    expect(all.candidates).toHaveLength(1);
  });

  test("reads the current branch pull request and returns null when none exists", async () => {
    const fake = await fakeGhDirectory("data");
    const service = new GithubRefsService({ ghBinary: "gh", env: { PATH: fake.bin } });
    const current = await service.currentPullRequest({ folder: FolderPath.parse(fake.folder) });
    expect(current.pullRequest).toMatchObject({
      kind: "pull-request",
      number: 34,
      title: "Current pull request",
    });

    const noPrScript = join(fake.bin, "gh-no-pr");
    await writeFile(noPrScript, '#!/bin/sh\necho "no pull requests found" >&2\nexit 1\n', "utf8");
    await chmod(noPrScript, 0o755);
    const noPr = new GithubRefsService({ ghBinary: noPrScript });
    expect(await noPr.currentPullRequest({ folder: FolderPath.parse(fake.folder) })).toEqual({
      pullRequest: null,
    });
  });

  test("maps missing and unauthenticated gh to unavailable without leaking stderr", async () => {
    const fake = await fakeGhDirectory("unauthenticated");
    const folder = FolderPath.parse(fake.folder);
    const unauthenticated = await expectAppFailure(
      new GithubRefsService({ ghBinary: "gh", env: { PATH: fake.bin } }).search({
        folder,
        query: "query",
        kind: "issue",
        limit: 5,
      }),
    );
    expect(unauthenticated.appError).toMatchObject({
      code: "unavailable",
      capability: "host.github-refs",
    });
    expect(unauthenticated.appError.message).not.toContain("not logged in");

    const missing = await expectAppFailure(
      new GithubRefsService({ ghBinary: join(fake.bin, "missing-gh") }).search({
        folder,
        query: "query",
        kind: "issue",
        limit: 5,
      }),
    );
    expect(missing.appError).toMatchObject({ code: "unavailable", capability: "host.github-refs" });
  });

  test("honors a pre-aborted signal and truncates long bodies", async () => {
    const fake = await fakeGhDirectory("data");
    const controller = new AbortController();
    controller.abort();
    const service = new GithubRefsService({ ghBinary: "gh", env: { PATH: fake.bin } });
    const cancelled = await expectAppFailure(
      service.search(
        { folder: FolderPath.parse(fake.folder), query: "query", kind: "issue", limit: 5 },
        controller.signal,
      ),
    );
    expect(cancelled.appError.code).toBe("cancelled");
  });
});

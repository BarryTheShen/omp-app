import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { fakeProgramFile, fakeScriptFile } from "../../../test-fixtures/fake-program";
import { GithubRefsService } from "./github-refs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = join(import.meta.dir, "../../../../../../.data");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "github-refs-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A stand-in for gh in `bin` (a Bun script, so it runs on Windows too) and a workspace folder; `gh` is its path. */
async function fakeGhDirectory(
  mode: "data" | "unauthenticated",
): Promise<{ bin: string; folder: string; gh: string }> {
  const root = await temporaryDirectory();
  const bin = join(root, "bin");
  const folder = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(folder, { recursive: true });
  const answers = {
    "search:issues":
      '[{"number":12,"title":"Fix issue","body":"Issue body","url":"https://github.com/example/repo/issues/12","state":"open","repository":{"nameWithOwner":"example/repo"}}]',
    "search:prs":
      '[{"number":34,"title":"Pull request","body":"Pull body","url":"https://github.com/example/repo/pull/34","state":"merged","repository":{"nameWithOwner":"example/repo"}}]',
    "pr:view":
      '{"number":34,"title":"Current pull request","body":"Current body","url":"https://github.com/example/repo/pull/34","state":"open","repository":{"nameWithOwner":"example/repo"}}',
  };
  const gh =
    mode === "unauthenticated"
      ? await fakeProgramFile(bin, "gh", {
          stderr: "not logged in to any GitHub hosts",
          exitCode: 1,
        })
      : await fakeScriptFile(
          bin,
          "gh",
          `const answers: Record<string, string> = ${JSON.stringify(answers)};
const answer = answers[Bun.argv.slice(2, 4).join(":")];
if (answer === undefined) {
  process.stderr.write("unexpected gh args\\n");
  process.exit(2);
}
process.stdout.write(answer);`,
        );
  return { bin, folder, gh };
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
    const service = new GithubRefsService({ ghBinary: fake.gh });
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
    const service = new GithubRefsService({ ghBinary: fake.gh });
    const current = await service.currentPullRequest({ folder: FolderPath.parse(fake.folder) });
    expect(current.pullRequest).toMatchObject({
      kind: "pull-request",
      number: 34,
      title: "Current pull request",
    });

    const noPrScript = await fakeProgramFile(fake.bin, "gh-no-pr", {
      stderr: "no pull requests found",
      exitCode: 1,
    });
    const noPr = new GithubRefsService({ ghBinary: noPrScript });
    expect(await noPr.currentPullRequest({ folder: FolderPath.parse(fake.folder) })).toEqual({
      pullRequest: null,
    });
  });

  test("maps missing and unauthenticated gh to unavailable without leaking stderr", async () => {
    const fake = await fakeGhDirectory("unauthenticated");
    const folder = FolderPath.parse(fake.folder);
    const unauthenticated = await expectAppFailure(
      new GithubRefsService({ ghBinary: fake.gh }).search({
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
    const service = new GithubRefsService({ ghBinary: fake.gh });
    const cancelled = await expectAppFailure(
      service.search(
        { folder: FolderPath.parse(fake.folder), query: "query", kind: "issue", limit: 5 },
        controller.signal,
      ),
    );
    expect(cancelled.appError.code).toBe("cancelled");
  });
});

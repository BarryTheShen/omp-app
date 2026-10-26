import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  listUsableModels,
  OMP_PROBLEM,
  probeOmp,
  probeOmpPatiently,
  unhealthyAfterFailedChecks,
} from "./omp-version";

const dataRoot = resolve(import.meta.dir, "../../../../.data");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** An executable that stands in for omp: the shell script's body decides what `--version` does. */
async function fakeOmp(body: string): Promise<{ binary: string; cwd: string }> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, "omp-version-"));
  temporaryRoots.push(root);
  const binary = join(root, "fake-omp");
  await writeFile(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { binary, cwd: root };
}

const ENV = { PATH: Bun.env.PATH ?? "/usr/bin:/bin" };

describe("probeOmp", () => {
  test("reads the version of an omp that answers", async () => {
    const { binary, cwd } = await fakeOmp('echo "omp 18.7.0"');
    expect(await probeOmp([binary], ENV, cwd)).toEqual({
      version: "18.7.0",
      health: { status: "ok" },
    });
  });

  test("says omp was not found when there is nothing to run", async () => {
    const { cwd } = await fakeOmp("true");
    const result = await probeOmp([join(cwd, "no-such-omp")], ENV, cwd);
    expect(result).toEqual({
      version: null,
      health: { status: "unhealthy", detail: OMP_PROBLEM.notFound },
    });
  });

  test("says omp could not start when it exits with an error, even if it printed a version", async () => {
    const { binary, cwd } = await fakeOmp('echo "omp 18.7.0"; exit 3');
    const result = await probeOmp([binary], ENV, cwd);
    expect(result.health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.wouldNotStart });
  });

  test("says omp did not answer in time when it takes longer than it is given", async () => {
    const { binary, cwd } = await fakeOmp('sleep 5; echo "omp 18.7.0"');
    const result = await probeOmp([binary], ENV, cwd, 100);
    expect(result.health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.timedOut });
  });
});

describe("probeOmpPatiently", () => {
  test("an omp that answers at once is asked once", async () => {
    const { binary, cwd } = await fakeOmp('echo "omp 18.7.0"');
    const retries: number[] = [];
    const result = await probeOmpPatiently([binary], ENV, cwd, {
      onRetry: (waited) => retries.push(waited),
    });
    expect(result.health).toEqual({ status: "ok" });
    expect(retries).toEqual([]);
  });

  test("a slow start that ran out of the first wait is asked again with a longer one, and answers", async () => {
    // Takes about 0.4 s: more than the quick wait, well within the patient one.
    const { binary, cwd } = await fakeOmp('sleep 0.4; echo "omp 18.7.0"');
    const retries: number[] = [];
    const result = await probeOmpPatiently([binary], ENV, cwd, {
      quickMs: 100,
      patientMs: 5_000,
      onRetry: (waited) => retries.push(waited),
    });
    expect(result).toEqual({ version: "18.7.0", health: { status: "ok" } });
    expect(retries).toHaveLength(1);
    expect(retries[0]).toBeGreaterThanOrEqual(90);
  });

  test("an omp that does not answer even patiently is reported as not answering, after one retry", async () => {
    const { binary, cwd } = await fakeOmp("sleep 5");
    const retries: number[] = [];
    const result = await probeOmpPatiently([binary], ENV, cwd, {
      quickMs: 100,
      patientMs: 200,
      onRetry: (waited) => retries.push(waited),
    });
    expect(result.health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.timedOut });
    expect(retries).toHaveLength(1);
  });

  test("a missing omp is not retried: nothing a longer wait could fix", async () => {
    const { cwd } = await fakeOmp("true");
    const retries: number[] = [];
    const result = await probeOmpPatiently([join(cwd, "no-such-omp")], ENV, cwd, {
      onRetry: (waited) => retries.push(waited),
    });
    expect(result.health.detail).toBe(OMP_PROBLEM.notFound);
    expect(retries).toEqual([]);
  });
});

describe("unhealthyAfterFailedChecks", () => {
  test("says no model is set up when omp lists no usable model", async () => {
    const { binary, cwd } = await fakeOmp(`echo '{"models":[]}'`);
    expect(await unhealthyAfterFailedChecks([binary], ENV, cwd)).toEqual({
      status: "unhealthy",
      detail: OMP_PROBLEM.noModel,
      code: "no_model",
    });
  });

  test("keeps the checks message when omp lists a model", async () => {
    const { binary, cwd } = await fakeOmp(`echo '{"models":[{"id":"fake-model"}]}'`);
    expect(await unhealthyAfterFailedChecks([binary], ENV, cwd)).toEqual({
      status: "unhealthy",
      detail: OMP_PROBLEM.checksFailed,
    });
  });

  test("keeps the checks message when omp cannot list its models", async () => {
    const { binary, cwd } = await fakeOmp("exit 1");
    expect(await unhealthyAfterFailedChecks([binary], ENV, cwd)).toEqual({
      status: "unhealthy",
      detail: OMP_PROBLEM.checksFailed,
    });
  });
});

describe("listUsableModels", () => {
  test("lists the usable models from omp models --json, as provider, model id and name", async () => {
    const { binary, cwd } = await fakeOmp(
      `echo '{"models":[{"provider":"fake","kind":"chat","id":"fake-model","selector":"fake/fake-model","name":"Fake Model"}]}'`,
    );
    expect(await listUsableModels([binary], ENV, cwd)).toEqual([
      { provider: "fake", modelId: "fake-model", name: "Fake Model" },
    ]);
  });

  test("a listing omp cannot give is a plain failure, not an empty list", async () => {
    const { binary, cwd } = await fakeOmp("exit 1");
    await expect(listUsableModels([binary], ENV, cwd)).rejects.toMatchObject({
      appError: { code: "unavailable", retryable: true },
    });
  });
});

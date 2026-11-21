import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { removeTree } from "../modules/A1/fs";
import { type FakeProgram, writeFakeProgram } from "../test-fixtures/fake-program";
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
  // Windows refuses to remove a folder a killed stand-in still holds, a moment after it is told to end: removeTree waits.
  await Promise.all(temporaryRoots.splice(0).map((path) => removeTree(path)));
});

/** A stand-in for omp that does `does` whatever it is asked; the command that starts it, and its folder. */
async function fakeOmp(does: FakeProgram): Promise<{ command: string[]; cwd: string }> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, "omp-version-"));
  temporaryRoots.push(root);
  return { command: await writeFakeProgram(root, "fake-omp", does), cwd: root };
}

const ENV = { PATH: Bun.env.PATH ?? "/usr/bin:/bin" };

describe("probeOmp", () => {
  test("reads the version of an omp that answers", async () => {
    const { command, cwd } = await fakeOmp({ stdout: "omp 18.7.0" });
    expect(await probeOmp(command, ENV, cwd)).toEqual({
      version: "18.7.0",
      health: { status: "ok" },
    });
  });

  test("says omp was not found when there is nothing to run", async () => {
    const { cwd } = await fakeOmp({});
    const result = await probeOmp([join(cwd, "no-such-omp")], ENV, cwd);
    expect(result).toEqual({
      version: null,
      health: { status: "unhealthy", detail: OMP_PROBLEM.notFound },
    });
  });

  test("says omp could not start when it exits with an error, even if it printed a version", async () => {
    const { command, cwd } = await fakeOmp({ stdout: "omp 18.7.0", exitCode: 3 });
    const result = await probeOmp(command, ENV, cwd);
    expect(result.health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.wouldNotStart });
  });

  test("says omp did not answer in time when it takes longer than it is given", async () => {
    const { command, cwd } = await fakeOmp({ sleepMs: 5_000, stdout: "omp 18.7.0" });
    const result = await probeOmp(command, ENV, cwd, 100);
    expect(result.health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.timedOut });
  });
});

describe("probeOmpPatiently", () => {
  test("an omp that answers at once is asked once", async () => {
    const { command, cwd } = await fakeOmp({ stdout: "omp 18.7.0" });
    const retries: number[] = [];
    const result = await probeOmpPatiently(command, ENV, cwd, {
      onRetry: (waited) => retries.push(waited),
    });
    expect(result.health).toEqual({ status: "ok" });
    expect(retries).toEqual([]);
  });

  test("a slow start that ran out of the first wait is asked again with a longer one, and answers", async () => {
    // Takes about 0.4 s: more than the quick wait, well within the patient one.
    const { command, cwd } = await fakeOmp({ sleepMs: 400, stdout: "omp 18.7.0" });
    const retries: number[] = [];
    const result = await probeOmpPatiently(command, ENV, cwd, {
      quickMs: 100,
      patientMs: 5_000,
      onRetry: (waited) => retries.push(waited),
    });
    expect(result).toEqual({ version: "18.7.0", health: { status: "ok" } });
    expect(retries).toHaveLength(1);
    expect(retries[0]).toBeGreaterThanOrEqual(90);
  });

  test("an omp that does not answer even patiently is reported as not answering, after one retry", async () => {
    const { command, cwd } = await fakeOmp({ sleepMs: 5_000 });
    const retries: number[] = [];
    const result = await probeOmpPatiently(command, ENV, cwd, {
      quickMs: 100,
      patientMs: 200,
      onRetry: (waited) => retries.push(waited),
    });
    expect(result.health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.timedOut });
    expect(retries).toHaveLength(1);
  });

  test("a missing omp is not retried: nothing a longer wait could fix", async () => {
    const { cwd } = await fakeOmp({});
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
    const { command, cwd } = await fakeOmp({ stdout: '{"models":[]}' });
    expect(await unhealthyAfterFailedChecks(command, ENV, cwd)).toEqual({
      status: "unhealthy",
      detail: OMP_PROBLEM.noModel,
      code: "no_model",
    });
  });

  test("keeps the checks message when omp lists a model", async () => {
    const { command, cwd } = await fakeOmp({ stdout: '{"models":[{"id":"fake-model"}]}' });
    expect(await unhealthyAfterFailedChecks(command, ENV, cwd)).toEqual({
      status: "unhealthy",
      detail: OMP_PROBLEM.checksFailed,
    });
  });

  test("keeps the checks message when omp cannot list its models", async () => {
    const { command, cwd } = await fakeOmp({ exitCode: 1 });
    expect(await unhealthyAfterFailedChecks(command, ENV, cwd)).toEqual({
      status: "unhealthy",
      detail: OMP_PROBLEM.checksFailed,
    });
  });
});

describe("listUsableModels", () => {
  test("lists the usable models from omp models --json, as provider, model id and name", async () => {
    const { command, cwd } = await fakeOmp({
      stdout:
        '{"models":[{"provider":"fake","kind":"chat","id":"fake-model","selector":"fake/fake-model","name":"Fake Model"}]}',
    });
    expect(await listUsableModels(command, ENV, cwd)).toEqual([
      { provider: "fake", modelId: "fake-model", name: "Fake Model" },
    ]);
  });

  test("a first run that waits out omp's catalog fetch still lists the models, and a first start without one says so (issue 2690)", async () => {
    // omp fetches its model catalog on its first run and waits up to 10 s for it: behind a name server that does not
    // answer, its first `models --json` took 10.6 to 10.9 s.
    const withModel = await fakeOmp({
      sleepMs: 10_700,
      stdout:
        '{"models":[{"provider":"fake","kind":"chat","id":"fake-model","selector":"fake/fake-model","name":"Fake Model"}]}',
    });
    const withNone = await fakeOmp({ sleepMs: 10_700, stdout: '{"models":[]}' });
    const [models, health] = await Promise.all([
      listUsableModels(withModel.command, ENV, withModel.cwd),
      unhealthyAfterFailedChecks(withNone.command, ENV, withNone.cwd),
    ]);
    expect(models).toEqual([{ provider: "fake", modelId: "fake-model", name: "Fake Model" }]);
    expect(health).toEqual({ status: "unhealthy", detail: OMP_PROBLEM.noModel, code: "no_model" });
  }, 30_000);

  test("a listing omp cannot give is a plain failure, not an empty list", async () => {
    const { command, cwd } = await fakeOmp({ exitCode: 1 });
    await expect(listUsableModels(command, ENV, cwd)).rejects.toMatchObject({
      appError: { code: "unavailable", retryable: true },
    });
  });
});

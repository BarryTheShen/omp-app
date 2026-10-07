import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearInstance,
  instanceFile,
  ompSearchPath,
  parseLauncherArgs,
  readRunningInstance,
  recordInstance,
} from "./launcher";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-app-launcher-"));
  dirs.push(dir);
  return join(dir, "state", "instance.json");
}

describe("parseLauncherArgs", () => {
  test("defaults to running in the current folder and opening the browser", () => {
    expect(parseLauncherArgs([])).toEqual({
      ok: true,
      args: { command: "run", folder: undefined, port: undefined, open: true },
    });
  });

  test("reads a folder, a port in both spellings, and --no-open", () => {
    expect(parseLauncherArgs(["/work/app", "--port", "4400", "--no-open"])).toEqual({
      ok: true,
      args: { command: "run", folder: "/work/app", port: 4400, open: false },
    });
    expect(parseLauncherArgs(["--port=0"])).toMatchObject({ ok: true, args: { port: 0 } });
  });

  test("rejects a bad port, an unknown option and a second folder with a plain message", () => {
    expect(parseLauncherArgs(["--port", "http"])).toEqual({
      ok: false,
      message: '--port needs a number from 0 to 65535, not "http".',
    });
    expect(parseLauncherArgs(["--port", "70000"])).toMatchObject({ ok: false });
    expect(parseLauncherArgs(["--port"])).toMatchObject({ ok: false });
    expect(parseLauncherArgs(["--open"])).toEqual({ ok: false, message: "Unknown option --open." });
    expect(parseLauncherArgs(["a", "b"])).toEqual({
      ok: false,
      message: "Only one folder can be given.",
    });
  });

  test("help and version win over running", () => {
    expect(parseLauncherArgs(["--help"])).toMatchObject({ args: { command: "help" } });
    expect(parseLauncherArgs(["-v"])).toMatchObject({ args: { command: "version" } });
  });
});

describe("the one-instance record", () => {
  const instance = { pid: 4242, url: "http://127.0.0.1:4317/#token=abc", version: "0.1.9" };

  test("finds a live instance that answers, and ignores a dead or silent one", async () => {
    const path = await tempFile();
    await recordInstance(path, instance);
    const answers = async () => true;
    expect(await readRunningInstance(path, { alive: () => true, responds: answers })).toEqual(
      instance,
    );
    expect(await readRunningInstance(path, { alive: () => false, responds: answers })).toBeNull();
    expect(
      await readRunningInstance(path, { alive: () => true, responds: async () => false }),
    ).toBeNull();
  });

  test("treats a missing or corrupt record as nothing running", async () => {
    const path = await tempFile();
    const checks = { alive: () => true, responds: async () => true };
    expect(await readRunningInstance(path, checks)).toBeNull();
    await recordInstance(path, instance);
    await writeFile(path, "{not json");
    expect(await readRunningInstance(path, checks)).toBeNull();
    await writeFile(path, JSON.stringify({ pid: "x" }));
    expect(await readRunningInstance(path, checks)).toBeNull();
  });

  test("keeps the record private because its address holds the session token", async () => {
    const path = await tempFile();
    await recordInstance(path, instance);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("clears only its own record, so a newer instance's record survives", async () => {
    const path = await tempFile();
    await recordInstance(path, instance);
    await clearInstance(path, 1);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(instance);
    await clearInstance(path, instance.pid);
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await clearInstance(path, instance.pid);
  });

  test("keeps the record under the user's state folder", () => {
    expect(instanceFile({}, "/home/u")).toBe("/home/u/.local/state/omp-app/instance.json");
    expect(instanceFile({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe(
      "/state/omp-app/instance.json",
    );
    expect(instanceFile({ XDG_STATE_HOME: "relative" }, "/home/u")).toBe(
      "/home/u/.local/state/omp-app/instance.json",
    );
  });
});

describe("ompSearchPath", () => {
  test("adds the usual bun and local folders after the current path, only when they exist", () => {
    const exists = (path: string) => path === "/home/u/.bun/bin";
    expect(ompSearchPath("/home/u", "/usr/bin:/bin", exists)).toBe(
      "/usr/bin:/bin:/home/u/.bun/bin",
    );
    expect(ompSearchPath("/home/u", undefined, exists)).toBe("/home/u/.bun/bin");
  });

  test("does not repeat a folder that is already on the path", () => {
    expect(ompSearchPath("/home/u", "/home/u/.bun/bin:/usr/bin", () => true)).toBe(
      "/home/u/.bun/bin:/usr/bin:/home/u/.local/bin",
    );
  });
});

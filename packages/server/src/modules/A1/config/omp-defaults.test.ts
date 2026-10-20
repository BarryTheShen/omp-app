import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AppFailure, type ConfigChanged } from "@omp-app/contracts";
import type { ConfigStoreService } from "./config-store";
import { createConfigStoreWithOmpDefaults } from "./omp-defaults";

const dataRoot = resolve(import.meta.dir, "../../../../../../.data");
const temporaryDirectories: string[] = [];
const stores: ConfigStoreService[] = [];

async function temporaryRoot(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, "settings-defaults-"));
  temporaryDirectories.push(root);
  return root;
}

async function fakeOmp(root: string, body: string): Promise<string> {
  const binary = join(root, "fake-omp");
  await writeFile(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  return binary;
}

interface PatientDefaults {
  readonly patientTimeoutMs?: number;
  readonly patientDeadlineMs?: number;
  readonly onWarning?: (message: string) => void;
}

async function serverStore(
  root: string,
  binary: string,
  timeoutMs = 500,
  patient: PatientDefaults = {},
) {
  const warnings: string[] = [];
  const store = await createConfigStoreWithOmpDefaults(
    { agentDir: join(root, "agent"), appDataDir: join(root, "app-data") },
    {
      binary,
      launchDirectory: root,
      pathEnvironment: Bun.env.PATH ?? "",
      temporaryDirectoryBase: root,
      timeoutMs,
      ...patient,
      onWarning: (message) => {
        warnings.push(message);
        patient.onWarning?.(message);
      },
    },
  );
  stores.push(store);
  return { store, warnings };
}

async function expectNotFound(store: ConfigStoreService, key: string): Promise<void> {
  try {
    await store.read({ key, folder: null });
  } catch (error) {
    if (error instanceof AppFailure) {
      expect(error.appError.code).toBe("not_found");
      return;
    }
    throw error;
  }
  throw new Error(`Expected ${key} to be absent.`);
}

async function expectUnavailableDefaults(
  root: string,
  body: string,
  timeoutMs: number,
): Promise<void> {
  const binary = await fakeOmp(root, body);
  const { store, warnings } = await serverStore(root, binary, timeoutMs);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("defaults");
  await expectNotFound(store, "model");
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("omp ConfigStore defaults", () => {
  test("loads registered values as defaults while a user-set value wins", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "config.yml"), "model: user-value\n", "utf8");
    const payload = JSON.stringify({
      model: { type: "string", value: "omp-default" },
      "compaction.enabled": { type: "boolean", value: false },
      noDefault: { type: "string" },
    });
    const binary = await fakeOmp(
      root,
      [
        '[ "$1" = "config" ] && [ "$2" = "list" ] && [ "$3" = "--json" ] || exit 64',
        `printf '%s\\n' '${payload}'`,
      ].join("\n"),
    );
    const { store, warnings } = await serverStore(root, binary);

    expect(await store.read({ key: "compaction.enabled", folder: null })).toMatchObject({
      value: false,
      source: "default",
    });
    expect(await store.read({ key: "model", folder: null })).toMatchObject({
      value: "user-value",
      source: "global",
    });
    // A setting without a default is in omp's registry, so it is available, and it still has no entry.
    await expectNotFound(store, "noDefault");
    expect((await store.list({ folder: null })).availableKeys).toEqual([
      "model",
      "compaction.enabled",
      "noDefault",
    ]);
    expect(warnings).toEqual([]);
  });

  test("starts without defaults and warns once when omp exits unsuccessfully", async () => {
    const root = await temporaryRoot();
    await expectUnavailableDefaults(
      root,
      '[ "$1" = "config" ] && [ "$2" = "list" ] && [ "$3" = "--json" ] || exit 64\nexit 1',
      500,
    );
  });

  test("starts without defaults and warns once when omp times out", async () => {
    const root = await temporaryRoot();
    await expectUnavailableDefaults(
      root,
      '[ "$1" = "config" ] && [ "$2" = "list" ] && [ "$3" = "--json" ] || exit 64\nexec /bin/sleep 30',
      50,
    );
  });
});

const LIST_GUARD = '[ "$1" = "config" ] && [ "$2" = "list" ] && [ "$3" = "--json" ] || exit 64';

async function probeValue(store: ConfigStoreService, key: string): Promise<unknown> {
  const entry = await store.read({ key, folder: null });
  return "value" in entry ? entry.value : undefined;
}

async function leftoverDefaultsFolders(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith("omp-app-config-defaults-"));
}

async function warningFor(root: string, binary: string, timeoutMs?: number): Promise<string> {
  const { warnings } = await serverStore(root, binary, timeoutMs);
  expect(warnings).toHaveLength(1);
  return warnings[0] ?? "";
}

describe("omp ConfigStore defaults: wrappers, isolation, cleanup and causes", () => {
  test("a wrapper whose child keeps the output open cannot hold startup past the timeout", async () => {
    const root = await temporaryRoot();
    const binary = await fakeOmp(root, `${LIST_GUARD}\n/bin/sleep 3`);
    const started = Date.now();
    const { store, warnings } = await serverStore(root, binary, 200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warnings).toEqual([expect.stringContaining("timed out after 200 ms")]);
    await expectNotFound(store, "model");
  });

  test("omp runs in its own home, agent, temporary and working folders, with no inherited environment", async () => {
    const root = await temporaryRoot();
    const previous = process.env.OMP_APP_PROBE_SECRET;
    process.env.OMP_APP_PROBE_SECRET = "must-not-leak";
    try {
      const probe = String.raw`printf '{"probe.home":{"value":"%s"},"probe.agent":{"value":"%s"},"probe.temp":{"value":"%s"},"probe.cwd":{"value":"%s"},"probe.configDir":{"value":"%s"},"probe.leak":{"value":"%s"}}\n' "$HOME" "$PI_CODING_AGENT_DIR" "$TMPDIR" "$(pwd)" "$PI_CONFIG_DIR" "$OMP_APP_PROBE_SECRET"`;
      const binary = await fakeOmp(root, `${LIST_GUARD}\n${probe}`);
      const { store, warnings } = await serverStore(root, binary);
      expect(warnings).toEqual([]);
      const home = await probeValue(store, "probe.home");
      expect(typeof home).toBe("string");
      expect(home).not.toBe(process.env.HOME);
      expect(String(home).startsWith(root)).toBe(true);
      const base = dirname(String(home));
      expect(await probeValue(store, "probe.cwd")).toBe(base);
      expect(await probeValue(store, "probe.agent")).toBe(join(base, "agent"));
      expect(await probeValue(store, "probe.temp")).toBe(join(base, "tmp"));
      expect(await probeValue(store, "probe.configDir")).toBe(".omp");
      expect(await probeValue(store, "probe.leak")).toBe("");
    } finally {
      if (previous === undefined) delete process.env.OMP_APP_PROBE_SECRET;
      else process.env.OMP_APP_PROBE_SECRET = previous;
    }
  });

  test("removes its temporary folder after success, a failed run and a timeout", async () => {
    const root = await temporaryRoot();
    await serverStore(
      root,
      await fakeOmp(root, `${LIST_GUARD}\nprintf '{"model":{"value":"x"}}\\n'`),
    );
    await serverStore(root, await fakeOmp(root, `${LIST_GUARD}\nexit 1`));
    // A deadline of zero leaves no time for a retry, so this checks the folder of the one run.
    await serverStore(root, await fakeOmp(root, `${LIST_GUARD}\nexec /bin/sleep 3`), 100, {
      patientDeadlineMs: 0,
    });
    expect(await leftoverDefaultsFolders(root)).toEqual([]);
  });

  test("keeps the defaults that loaded when only the temporary folder cannot be removed", async () => {
    const root = await temporaryRoot();
    // omp makes its own folder read-only before it exits, so the folder's entries cannot be removed.
    const binary = await fakeOmp(
      root,
      `${LIST_GUARD}\nprintf '{"model":{"value":"omp-default"}}\\n'\nchmod 555 "$(pwd)"`,
    );
    try {
      const { store, warnings } = await serverStore(root, binary);
      expect(await probeValue(store, "model")).toBe("omp-default");
      expect(warnings).toEqual([expect.stringContaining("could not be removed")]);
    } finally {
      for (const name of await leftoverDefaultsFolders(root)) {
        await chmod(join(root, name), 0o755);
      }
    }
  });

  test("the warning says why the defaults did not load", async () => {
    const root = await temporaryRoot();
    expect(await warningFor(root, join(root, "no-such-omp"))).toContain("could not be started");
    expect(await warningFor(root, await fakeOmp(root, `${LIST_GUARD}\nexit 3`))).toContain(
      "exited with code 3",
    );
    expect(
      await warningFor(root, await fakeOmp(root, `${LIST_GUARD}\nexec /bin/sleep 3`), 200),
    ).toContain("timed out after 200 ms");
    expect(
      await warningFor(
        root,
        await fakeOmp(root, `${LIST_GUARD}\nprintf 'a banner line\\n{"model":{"value":"x"}}\\n'`),
      ),
    ).toContain("not valid JSON");
    expect(
      await warningFor(
        root,
        await fakeOmp(root, `${LIST_GUARD}\nprintf '{"model":"omp-default"}\\n'`),
      ),
    ).toContain("unexpected shape");
  });
});

async function fileLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for an operating-system event (a child process starting or ending) that no in-process signal reports,
 * so a bounded poll is the only way to observe it; the child is a real process, so real time is the subject.
 */
async function untilOsEvent(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("The operating system did not reach the state.");
    await Bun.sleep(10);
  }
}

describe("omp ConfigStore defaults: a slow first run", () => {
  test("a first run that runs out of time is asked again; the defaults reach the store and subscribers", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "config.yml"), "model: user-value\n", "utf8");
    const runs = join(root, "runs");
    // A cold first run is slow; the run after it answers at once.
    const binary = await fakeOmp(
      root,
      [
        LIST_GUARD,
        `echo run >> "${runs}"`,
        `if [ "$(wc -l < "${runs}")" -le 1 ]; then exec /bin/sleep 30; fi`,
        `printf '%s\\n' '{"model":{"value":"omp-default"},"compaction.enabled":{"value":false}}'`,
      ].join("\n"),
    );
    const { store, warnings } = await serverStore(root, binary, 50, { patientTimeoutMs: 5_000 });
    const changes: ConfigChanged[] = [];
    const firstChange = Promise.withResolvers<void>();
    store.subscribe(null, (change) => {
      changes.push(change);
      firstChange.resolve();
    });
    await firstChange.promise;
    expect(changes[0]).toMatchObject({
      key: "compaction.enabled",
      layer: "default",
      folder: null,
      entry: { key: "compaction.enabled", value: false, source: "default" },
    });
    expect(await store.read({ key: "compaction.enabled", folder: null })).toMatchObject({
      value: false,
      source: "default",
    });
    expect(await probeValue(store, "model")).toBe("user-value");
    expect(warnings).toEqual([expect.stringContaining("trying again in the background")]);
    expect(await fileLines(runs)).toHaveLength(2);
    expect(await leftoverDefaultsFolders(root)).toEqual([]);
  });
  test("an empty retry keeps the registry unavailable and is asked after the first timeout", async () => {
    const root = await temporaryRoot();
    const runs = join(root, "runs-empty");
    const binary = await fakeOmp(
      root,
      [
        LIST_GUARD,
        `echo run >> "${runs}"`,
        `if [ "$(wc -l < "${runs}")" -le 1 ]; then exec /bin/sleep 30; fi`,
        `printf '%s\\n' '{}'`,
      ].join("\n"),
    );
    const { store } = await serverStore(root, binary, 50, {
      patientTimeoutMs: 5_000,
      patientDeadlineMs: 20_000,
    });
    await untilOsEvent(async () => (await fileLines(runs)).length === 2);
    expect((await store.list({ folder: null })).availableKeys).toBeUndefined();
    await expectNotFound(store, "noDefault");
  });

  // The test waits for the give-up warning itself. The budget is a hang guard, not a wait: the retry runs on real timers,
  // and in a loaded full run this test once took 5.5 s, past bun's 5 s default for every test (issue #1538).
  test("a retry that also runs out of time gives up and says why", async () => {
    const root = await temporaryRoot();
    const binary = await fakeOmp(root, `${LIST_GUARD}\nexec /bin/sleep 30`);
    const gaveUp = Promise.withResolvers<string>();
    const { store, warnings } = await serverStore(root, binary, 50, {
      patientTimeoutMs: 100,
      patientDeadlineMs: 400,
      onWarning: (message) => {
        if (message.includes("continuing")) gaveUp.resolve(message);
      },
    });
    const finalWarning = await gaveUp.promise;
    expect(warnings).toEqual([
      expect.stringContaining("trying again in the background"),
      finalWarning,
    ]);
    expect(finalWarning).toContain("timed out after");
    await expectNotFound(store, "model");
  }, 30_000);

  test("disposing the store stops a retry that is still waiting for omp", async () => {
    const root = await temporaryRoot();
    const pids = join(root, "pids");
    // Every run records its process id, then waits far longer than this test.
    const binary = await fakeOmp(root, `${LIST_GUARD}\necho $$ >> "${pids}"\nexec /bin/sleep 60`);
    const { store } = await serverStore(root, binary, 50, {
      patientTimeoutMs: 60_000,
      patientDeadlineMs: 120_000,
    });
    await untilOsEvent(async () => (await fileLines(pids)).length === 2);
    const retryPid = Number((await fileLines(pids))[1]);
    store.dispose();
    await untilOsEvent(() => !processAlive(retryPid));
  });
});

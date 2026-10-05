import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure } from "@omp-app/contracts";
import {
  compareAndSwapFile,
  ensureAppDataDir,
  hashContent,
  mayConcernFile,
  NO_FILE,
  readFileSnapshot,
  resolveAppDataDir,
  watchFile,
  writeFileAtomic,
} from "./index";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-fs-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFilesystemEvents(): Promise<void> {
  // Real fs.watch delivery and debounce timers are the integration under test.
  await Bun.sleep(180);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("app data directory", () => {
  test("resolves the configured folder and defaults to ~/.omp/app", async () => {
    const home = await makeTemporaryDirectory();
    const configured = join(home, "configured");

    expect(resolveAppDataDir({ env: {}, homeDir: home })).toBe(join(home, ".omp", "app"));
    expect(resolveAppDataDir({ env: { OMP_APP_DATA_DIR: configured }, homeDir: home })).toBe(
      configured,
    );

    const directory = await ensureAppDataDir(configured);
    const directoryMode = (await stat(directory)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
  });
});

describe("atomic files", () => {
  test("writes complete contents with mode 0600 and returns the content hash", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "state.json");
    const result = await writeFileAtomic(path, '{"ok":true}');

    expect(result.path).toBe(path);
    expect(result.hash).toBe(hashContent('{"ok":true}'));
    expect(await readFile(path, "utf8")).toBe('{"ok":true}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("never interleaves concurrent writers", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "concurrent.txt");
    const values = ["a".repeat(20_000), "b".repeat(20_000), "c".repeat(20_000)];

    await Promise.all(values.map((value) => writeFileAtomic(path, value)));

    expect(values).toContain(await readFile(path, "utf8"));
  });

  test("detects stale and create-only compare-and-swap writes", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "cas.txt");
    const first = await compareAndSwapFile(path, "first", NO_FILE);
    expect(first.hash).toBe(hashContent("first"));

    const stale = await compareAndSwapFile(path, "stale", NO_FILE).catch((error) => error);
    expect(stale).toBeInstanceOf(AppFailure);
    expect((stale as AppFailure).appError.code).toBe("conflict");

    const second = await compareAndSwapFile(path, "second", first.hash);
    expect(second.hash).toBe(hashContent("second"));
    const snapshot = await readFileSnapshot(path);
    expect(snapshot.content).toBe("second");
    expect(snapshot.hash).toBe(second.hash);
  });

  test("allows one of two concurrent writers with the same expected hash", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "race.txt");
    await writeFileAtomic(path, "base");
    const base = (await readFileSnapshot(path)).hash;
    if (base === null) throw new Error("Expected the base file to exist");

    const results = await Promise.allSettled([
      compareAndSwapFile(path, "left", base),
      compareAndSwapFile(path, "right", base),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = rejected[0];
    if (error?.status !== "rejected") throw new Error("Expected one rejected CAS operation");
    expect(error.reason).toBeInstanceOf(AppFailure);
    expect((error.reason as AppFailure).appError.code).toBe("conflict");
  });

  test("serializes compare-and-swap writers in separate processes", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "process-race.txt");
    await writeFileAtomic(path, "base");
    const base = (await readFileSnapshot(path)).hash;
    if (base === null) throw new Error("Expected the base file to exist");
    const moduleUrl = new URL("./index.ts", import.meta.url).href;
    const children = ["left", "right"].map((value) => {
      const script = [
        `import { compareAndSwapFile } from ${JSON.stringify(moduleUrl)};`,
        `await compareAndSwapFile(${JSON.stringify(path)}, ${JSON.stringify(value)}, ${JSON.stringify(base)});`,
      ].join("\n");
      return Bun.spawn(["bun", "-e", script], { stderr: "pipe", stdout: "pipe" });
    });

    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits.sort((left, right) => left - right)).toEqual([0, 1]);
    expect(["left", "right"]).toContain(await readFile(path, "utf8"));
  });

  test("leaves the old file after a crash before rename and cleans the orphan on restart", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "crash.txt");
    await writeFile(path, "old");
    const moduleUrl = new URL("./index.ts", import.meta.url).href;
    const script = [
      `import { writeFileAtomic } from ${JSON.stringify(moduleUrl)};`,
      `await writeFileAtomic(${JSON.stringify(path)}, "new", { beforeRename: () => process.exit(17) });`,
    ].join("\n");

    const child = Bun.spawn(["bun", "-e", script], { stderr: "pipe", stdout: "pipe" });
    expect(await child.exited).toBe(17);
    expect(await readFile(path, "utf8")).toBe("old");
    expect(
      (await readdir(directory)).some(
        (name) => name.startsWith(".omp-atomic-") && name.endsWith(".tmp"),
      ),
    ).toBe(true);

    await ensureAppDataDir(directory);
    expect(
      (await readdir(directory)).some(
        (name) => name.startsWith(".omp-atomic-") && name.endsWith(".tmp"),
      ),
    ).toBe(false);
    expect(await readFile(path, "utf8")).toBe("old");
  });
});

describe("file watching", () => {
  test("debounces, deduplicates, suppresses self-writes, and disposes cleanly", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "watched.txt");
    await writeFile(path, "initial");
    const events: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchFile(
      path,
      (event) => {
        events.push(event.hash ?? "missing");
      },
      { debounceMs: 25, onError: (error) => errors.push(error) },
    );

    await writeFileAtomic(path, "self");
    await waitForFilesystemEvents();
    expect(events).toEqual([]);

    await writeFile(path, "external");
    await writeFile(path, "external");
    await waitForFilesystemEvents();
    expect(events).toEqual([hashContent("external")]);

    await writeFile(path, "external");
    await waitForFilesystemEvents();
    expect(events).toEqual([hashContent("external")]);

    watcher.dispose();
    await writeFile(path, "after-dispose");
    await waitForFilesystemEvents();
    expect(events).toEqual([hashContent("external")]);
    watcher.dispose();
  });

  test("does not create missing directories and reports a file when they appear", async () => {
    const root = await makeTemporaryDirectory();
    const path = join(root, "missing", "nested", "watched.txt");
    const events: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchFile(
      path,
      (event) => {
        events.push(event.hash ?? "missing");
      },
      { debounceMs: 25, onError: (error) => errors.push(error) },
    );

    expect(await readdir(root)).toEqual([]);
    await mkdir(join(root, "missing", "nested"), { recursive: true });
    await writeFile(path, "appeared");
    await waitForFilesystemEvents();

    expect(events).toEqual([hashContent("appeared")]);
    expect(errors).toEqual([]);
    watcher.dispose();
  });
});

describe("watch event filtering", () => {
  test("an event without a filename may concern the file; another file's event does not", () => {
    // Bun's fs.watch can report no filename at all; that once crashed the server.
    expect(mayConcernFile(undefined, "config.yml")).toBe(true);
    expect(mayConcernFile(null, "config.yml")).toBe(true);
    expect(mayConcernFile("config.yml", "config.yml")).toBe(true);
    expect(mayConcernFile(Buffer.from("config.yml"), "config.yml")).toBe(true);
    expect(mayConcernFile("other.yml", "config.yml")).toBe(false);
  });
});

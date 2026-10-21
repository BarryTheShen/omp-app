import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure } from "@omp-app/contracts";
import {
  compareAndSwapFile,
  ensureAppDataDir,
  ensureAppDataDirSync,
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

/** The atomic-write temp files in a directory, by name. */
async function temporaryFileNames(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => name.startsWith(".omp-atomic-") && name.endsWith(".tmp"));
}

async function setLastWrite(path: string, ageMs: number): Promise<void> {
  const modified = new Date(Date.now() - ageMs);
  await utimes(path, modified, modified);
}

/** Leaves a temp file of the kind an interrupted write leaves, last written `ageMs` ago; returns its name. */
async function leaveTemporaryFile(directory: string, ageMs: number): Promise<string> {
  const name = `.omp-atomic-${randomBytes(16).toString("hex")}.tmp`;
  await writeFile(join(directory, name), "partial");
  await setLastWrite(join(directory, name), ageMs);
  return name;
}

async function waitForFilesystemEvents(): Promise<void> {
  // Real fs.watch delivery and debounce timers are the integration under test.
  await Bun.sleep(180);
}

/** Replaces a file the way an editor or omp does: write a temporary file, then rename it over the target. */
async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
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

  test("leaves the old file after a crash before rename, and cleans the orphan once it is stale", async () => {
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
    expect(await temporaryFileNames(directory)).toHaveLength(1);

    // The orphan of the crash has not been written for far longer than any live write takes.
    for (const name of await temporaryFileNames(directory)) {
      await setLastWrite(join(directory, name), 60 * 60_000);
    }
    await ensureAppDataDir(directory);
    expect(await temporaryFileNames(directory)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("old");
  });

  test("a sweep leaves alone the temp file of a write that is still in progress", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "draft.json");
    await writeFileAtomic(path, "saved", {
      // Between the fsync of the temp file and its rename, another write into the folder runs its sweep.
      beforeRename: async () => {
        await ensureAppDataDir(directory);
        ensureAppDataDirSync(directory);
      },
    });
    expect(await readFile(path, "utf8")).toBe("saved");
    expect(await temporaryFileNames(directory)).toEqual([]);
  });

  test("a sweep leaves a temp file alone in the process writing it, however old its last write", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "draft.json");
    await writeFileAtomic(path, "saved", {
      beforeRename: async () => {
        for (const name of await temporaryFileNames(directory)) {
          await setLastWrite(join(directory, name), 60 * 60_000);
        }
        await ensureAppDataDir(directory);
        ensureAppDataDirSync(directory);
      },
    });
    expect(await readFile(path, "utf8")).toBe("saved");
  });

  test("a sweep removes only temp files last written over a minute ago", async () => {
    const directory = await makeTemporaryDirectory();
    const recent = await leaveTemporaryFile(directory, 0);
    await leaveTemporaryFile(directory, 60 * 60_000);
    await ensureAppDataDir(directory);
    expect(await temporaryFileNames(directory)).toEqual([recent]);

    await leaveTemporaryFile(directory, 60 * 60_000);
    ensureAppDataDirSync(directory);
    expect(await temporaryFileNames(directory)).toEqual([recent]);
  });

  test("a sweep skips a folder it cannot read, and still removes the stale temp files it can reach", async () => {
    const directory = await makeTemporaryDirectory();
    const locked = join(directory, "drafts");
    await mkdir(locked);
    await leaveTemporaryFile(locked, 60 * 60_000);
    await chmod(locked, 0o000);
    try {
      await leaveTemporaryFile(directory, 60 * 60_000);
      await ensureAppDataDir(directory);
      expect(await temporaryFileNames(directory)).toEqual([]);

      await leaveTemporaryFile(directory, 60 * 60_000);
      ensureAppDataDirSync(directory);
      expect(await temporaryFileNames(directory)).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
    }
    expect(await temporaryFileNames(locked)).toHaveLength(1);
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

  test("with no directory watch available, polls the file, reports the failure once, and watches again when one frees up", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "watched.txt");
    await writeFile(path, "initial");
    let slotsFree = false;
    const errors: unknown[] = [];
    const events: string[] = [];
    let announce: (() => void) | undefined;
    const watcher = watchFile(
      path,
      (event) => {
        events.push(event.hash ?? "missing");
        announce?.();
      },
      {
        debounceMs: 25,
        pollMs: 5,
        onError: (error) => errors.push(error),
        watchDirectory: (directoryToWatch, listener) => {
          if (!slotsFree) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
          return watch(directoryToWatch, { persistent: false }, listener);
        },
      },
    );
    try {
      const firstEvent = new Promise<void>((resolve) => {
        announce = resolve;
      });
      await replaceFile(path, "first");
      await firstEvent;
      expect(events).toEqual([hashContent("first")]);
      expect(errors).toMatchObject([{ code: "EMFILE" }]);

      slotsFree = true;
      const secondEvent = new Promise<void>((resolve) => {
        announce = resolve;
      });
      await replaceFile(path, "second");
      await secondEvent;
      expect(events).toEqual([hashContent("first"), hashContent("second")]);
      expect(errors).toHaveLength(1);
    } finally {
      watcher.dispose();
    }
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

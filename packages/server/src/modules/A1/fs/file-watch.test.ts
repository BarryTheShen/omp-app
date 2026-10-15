import { afterEach, describe, expect, test } from "bun:test";
import type { FSWatcher } from "node:fs";
import { mkdirSync, watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileWatchRegistry,
  fileWatchMessage,
  fileWatchReason,
  type WatchDirectory,
  watchFile,
} from "./index";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-watch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Real fs.watch delivery and the real polling timer are the integration under test, so these waits poll for the
// condition instead of guessing a duration. Fake timers would not exercise the kernel's watch events.
async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await Bun.sleep(10);
  }
}

/** Opens watches for real, except the first `failures` attempts, which fail with `code` as a full computer does. */
function flakyWatch(code: string, failures: number) {
  const opened: FSWatcher[] = [];
  let attempts = 0;
  const watchDirectory: WatchDirectory = (directory, listener) => {
    attempts += 1;
    if (attempts <= failures) {
      throw Object.assign(new Error(`${code}: cannot watch ${directory}`), { code });
    }
    const watcher = watch(directory, { persistent: false }, listener);
    opened.push(watcher);
    return watcher;
  };
  return { watchDirectory, attempts: () => attempts, last: () => opened.at(-1) };
}

describe("watchFile when the computer cannot open its directory watch", () => {
  test("records the failure, reports it once, reads a change made meanwhile by polling, and clears the record once the watch opens", async () => {
    const root = await makeTemporaryDirectory();
    const path = join(root, "config.yml");
    await writeFile(path, "model: old\n");
    const flaky = flakyWatch("ENOSPC", 2);
    const registry = new FileWatchRegistry({ watchDirectory: flaky.watchDirectory });
    const errors: unknown[] = [];
    const changes: (string | null)[] = [];
    const watcher = watchFile(
      path,
      (event) => {
        changes.push(event.hash);
      },
      {
        debounceMs: 10,
        pollMs: 20,
        onError: (error) => errors.push(error),
        registry,
      },
    );
    expect(registry.snapshot()).toEqual({ state: "limited", reason: "watcher-limit", failing: 1 });

    // The change is made while the directory watch is still down: the polling check reads it.
    await writeFile(path, "model: new\n");
    await waitUntil(() => changes.length > 0);
    await waitUntil(() => registry.snapshot().state === "ok");

    expect(flaky.attempts()).toBeGreaterThanOrEqual(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "ENOSPC" });
    expect(changes.at(-1)).not.toBeNull();
    watcher.dispose();
    expect(registry.snapshot()).toEqual({ state: "ok" });
  });

  test("a directory watch that dies while it runs is recorded, polled, and opened again", async () => {
    const root = await makeTemporaryDirectory();
    const path = join(root, "config.yml");
    await writeFile(path, "model: old\n");
    const flaky = flakyWatch("EMFILE", 0);
    const registry = new FileWatchRegistry({ watchDirectory: flaky.watchDirectory });
    const watcher = watchFile(path, () => undefined, {
      debounceMs: 10,
      pollMs: 20,
      onError: () => undefined,
      registry,
    });
    expect(registry.snapshot()).toEqual({ state: "ok" });

    flaky.last()?.emit("error", Object.assign(new Error("EMFILE: died"), { code: "EMFILE" }));
    expect(registry.snapshot()).toEqual({ state: "limited", reason: "watcher-limit", failing: 1 });
    expect(registry.failingPaths()).toEqual([path]);
    await waitUntil(() => registry.snapshot().state === "ok");
    watcher.dispose();
  });

  test("a directory watch that fails for another reason is recorded as one", async () => {
    const root = await makeTemporaryDirectory();
    const path = join(root, "config.yml");
    await writeFile(path, "model: old\n");
    const registry = new FileWatchRegistry({
      watchDirectory: () => {
        throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
      },
    });
    const watcher = watchFile(path, () => undefined, {
      debounceMs: 10,
      pollMs: 60_000,
      onError: () => undefined,
      registry,
    });
    expect(registry.snapshot()).toEqual({ state: "limited", reason: "watch-failed", failing: 1 });
    watcher.dispose();
    expect(registry.snapshot()).toEqual({ state: "ok" });
  });
});

describe("the watch registry", () => {
  test("is ok until a watch fails, and clears once the watch is open again", () => {
    const registry = new FileWatchRegistry();
    const token = {};
    expect(registry.snapshot()).toEqual({ state: "ok" });
    registry.fail(token, "/app/config.yml", { code: "EMFILE" });
    expect(registry.snapshot()).toEqual({ state: "limited", reason: "watcher-limit", failing: 1 });
    expect(registry.failingPaths()).toEqual(["/app/config.yml"]);
    registry.clear(token);
    expect(registry.snapshot()).toEqual({ state: "ok" });
  });

  test("counts the failing watches, and names a full computer over another failure", () => {
    const registry = new FileWatchRegistry();
    registry.fail({}, "/app/a.yml", { code: "EACCES" });
    registry.fail({}, "/app/b.yml", { code: "ENOSPC" });
    expect(registry.snapshot()).toEqual({ state: "limited", reason: "watcher-limit", failing: 2 });
  });

  test("reads the reason from the error code", () => {
    expect(fileWatchReason({ code: "ENOSPC" })).toBe("watcher-limit");
    expect(fileWatchReason({ code: "EMFILE" })).toBe("watcher-limit");
    expect(fileWatchReason({ code: "EACCES" })).toBe("watch-failed");
    expect(fileWatchReason(new Error("no code"))).toBe("watch-failed");
    expect(fileWatchReason(undefined)).toBe("watch-failed");
  });

  test("the message says what the person can see, in plain words", () => {
    const message = fileWatchMessage({ state: "limited", reason: "watcher-limit", failing: 2 });
    expect(message).toContain("omp app can't watch some of its files for changes");
    expect(message).toContain("this computer has no file watchers left");
    expect(message).toContain(
      "It checks them every second instead, so changes still show, a little later.",
    );
    expect(message).not.toMatch(/ENOSPC|EMFILE|inotify|FileWatch|registry|polling/i);
  });

  test("a watch that fails for another reason says what it did, with no cause clause", () => {
    expect(fileWatchMessage({ state: "limited", reason: "watch-failed", failing: 1 })).toBe(
      "omp app can't watch some of its files for changes. It checks them every second instead, so changes still show, a little later.",
    );
  });

  test("a full computer names its cause in the same message", () => {
    expect(fileWatchMessage({ state: "limited", reason: "watcher-limit", failing: 1 })).toBe(
      "omp app can't watch some of its files for changes, because this computer has no file watchers left. It checks them every second instead, so changes still show, a little later.",
    );
  });
});

describe("watchFile when a folder on its path is made while the watch opens", () => {
  test("watches the folder once it exists, so a change in it is reported", async () => {
    const root = await makeTemporaryDirectory();
    const folder = join(root, "made", "later");
    const path = join(folder, "config.yml");
    let made = false;
    const watchDirectory: WatchDirectory = (directory, listener) => {
      // The first watch opens on the nearest folder that exists, here `root`. The folder below it is made after that
      // choice and before the watch opens, so the watch raises no event for it.
      if (!made) {
        made = true;
        mkdirSync(folder, { recursive: true });
      }
      return watch(directory, { persistent: false }, listener);
    };
    const registry = new FileWatchRegistry({ watchDirectory });
    const changes: (string | null)[] = [];
    const watcher = watchFile(
      path,
      (event) => {
        changes.push(event.hash);
      },
      { debounceMs: 10, pollMs: 60_000, onError: () => undefined, registry },
    );
    try {
      await writeFile(path, "model: new\n");
      await waitUntil(() => changes.length > 0);
      expect(changes).toHaveLength(1);
      expect(changes[0]).not.toBeNull();
    } finally {
      watcher.dispose();
    }
  });
});

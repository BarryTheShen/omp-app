import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { FrameDecoder, type RpcSessionTimer } from "@omp-app/omp-rpc";
import {
  homeFolderArguments,
  type OmpProcess,
  type OmpProcessEvent,
  spawnOmpProcess,
} from "./omp-process";

const FAKE_OMP = resolve(import.meta.dir, "test-fixtures/fake-omp.ts");
const threadId = ThreadId.parse("thread-a0-5-process");

class ManualTimer implements RpcSessionTimer {
  #nextId = 0;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(handler: () => void, _delayMs: number): number {
    const id = ++this.#nextId;
    this.callbacks.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

const temporaryFolders: string[] = [];
const liveProcesses: OmpProcess[] = [];

afterEach(async () => {
  await Promise.all(
    liveProcesses.splice(0).map((process) => process.stop().catch(() => undefined)),
  );
  await Promise.all(
    temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function temporaryFolder(): Promise<FolderPath> {
  const folder = await mkdtemp(join(tmpdir(), "omp-app-a0-5-"));
  temporaryFolders.push(folder);
  return FolderPath.parse(folder);
}

function track(process: OmpProcess): OmpProcess {
  liveProcesses.push(process);
  return process;
}

interface WaitOptions {
  readonly timer?: ManualTimer;
  readonly pump?: () => void;
  readonly timeoutMs?: number;
}

/** Awaits a matching OmpProcess event; fake timers pump only when supplied by the test. */
function waitForEvent(
  process: OmpProcess,
  predicate: (event: OmpProcessEvent) => boolean,
  options: WaitOptions = {},
): Promise<OmpProcessEvent> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let pump: ReturnType<typeof setInterval> | undefined;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => undefined;
    const cleanup = () => {
      if (pump !== undefined) {
        clearInterval(pump);
        pump = undefined;
      }
      if (guard !== undefined) {
        clearTimeout(guard);
        guard = undefined;
      }
      unsubscribe();
    };
    const finish = (event: OmpProcessEvent): void => {
      if (settled || !predicate(event)) return;
      settled = true;
      cleanup();
      resolvePromise(event);
    };
    unsubscribe = process.onEvent(finish);
    if (settled) {
      cleanup();
      return;
    }
    if (options.timer !== undefined || options.pump !== undefined) {
      pump = setInterval(options.pump ?? (() => options.timer?.fireAll()), 5);
    }
    guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for an OmpProcess event"));
    }, options.timeoutMs ?? 2000);
  });
}

/** Awaits a decoded stdout frame matching the predicate, using the real FrameDecoder. */
function waitForFrame(
  process: OmpProcess,
  predicate: (frame: Record<string, unknown>) => boolean,
  options: WaitOptions = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let pump: ReturnType<typeof setInterval> | undefined;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => undefined;
    const decoder = new FrameDecoder();
    const cleanup = () => {
      if (pump !== undefined) {
        clearInterval(pump);
        pump = undefined;
      }
      if (guard !== undefined) {
        clearTimeout(guard);
        guard = undefined;
      }
      unsubscribe();
    };
    const onChunk = (chunk: Uint8Array): void => {
      if (settled) return;
      for (const event of decoder.push(chunk)) {
        if (event.type !== "frame" || !predicate(event.frame)) continue;
        settled = true;
        cleanup();
        resolvePromise(event.frame);
        return;
      }
    };
    unsubscribe = process.onChunk(onChunk);
    if (settled) {
      cleanup();
      return;
    }
    if (options.timer !== undefined || options.pump !== undefined) {
      pump = setInterval(options.pump ?? (() => options.timer?.fireAll()), 5);
    }
    guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for a frame"));
    }, options.timeoutMs ?? 2000);
  });
}

describe("OmpProcess spawn and stdio", () => {
  test("spawns argv-only in the thread's folder, delivers the ready frame, and assigns a processId", async () => {
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        env: { FAKE_OMP_PASSTHROUGH_CHECK: "isolated-value" },
      }),
    );

    const ready = process.start();
    const notice = await waitForFrame(process, (frame) => frame.type === "notice");
    await ready;

    expect(process.status).toBe("running");
    expect(process.pid).toBeGreaterThan(0);
    expect(process.processId).toBeDefined();
    expect(notice).toMatchObject({ cwd: folder, echoedEnv: "isolated-value" });
  });
  test("adds an app-owned usage-reset overlay after configured overlays", async () => {
    const folder = await temporaryFolder();
    const configured = join(folder, "existing.yml");
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        env: { PI_CONFIG_FILES: configured },
      }),
    );

    process.start();
    const notice = await waitForFrame(process, (frame) => frame.type === "notice");
    const configFiles = String(notice.configFiles).split(":");
    const policy = configFiles.at(-1);
    expect(configFiles[0]).toBe(configured);
    expect(policy).toMatch(/omp-app-usage-reset-policy\.yml$/);
    expect(await readFile(policy as string, "utf8")).toBe(
      "codexResets:\n  autoRedeem: no\nclaudeResets:\n  autoRedeem: no\n",
    );
    const expectedPolicy = join(folder, ".omp", "app", "omp-app-usage-reset-policy.yml");
    expect(policy).toBe(expectedPolicy);
  });
  test("does not rewrite an unchanged policy when a second process starts", async () => {
    const folder = await temporaryFolder();
    const policy = join(folder, ".omp", "app", "omp-app-usage-reset-policy.yml");
    const startProcess = async (): Promise<void> => {
      const process = track(
        spawnOmpProcess({ threadId, folder, homeDir: folder, ompBin: FAKE_OMP }),
      );
      await process.start();
      await waitForFrame(process, (frame) => frame.type === "ready");
      await process.stop();
    };
    await startProcess();
    const before = await stat(policy);
    await startProcess();
    const after = await stat(policy);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("replaces a stale policy on the next process start", async () => {
    const folder = await temporaryFolder();
    const policy = join(folder, ".omp", "app", "omp-app-usage-reset-policy.yml");
    await mkdir(join(folder, ".omp", "app"), { recursive: true });
    await writeFile(policy, "codexResets:\n  autoRedeem: yes\n");
    const process = track(spawnOmpProcess({ threadId, folder, homeDir: folder, ompBin: FAKE_OMP }));
    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");
    await process.stop();
    expect(await readFile(policy, "utf8")).toBe(
      "codexResets:\n  autoRedeem: no\nclaudeResets:\n  autoRedeem: no\n",
    );
  });
  test("reports a typed startup failure when the app data path is a regular file", async () => {
    const folder = await temporaryFolder();
    const appData = join(folder, "app-data");
    await writeFile(appData, "not a directory");
    const events: OmpProcessEvent[] = [];
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        env: { OMP_APP_DATA_DIR: appData },
      }),
    );
    process.onEvent((event) => events.push(event));

    await expect(process.start()).rejects.toMatchObject({
      appError: { code: "omp_exited", retryable: true },
    });
    expect(process.status).toBe("error");
    expect(events.at(-1)).toMatchObject({ status: "error", error: { code: "omp_exited" } });
  });

  test("starts omp although a folder in the app data cannot be read", async () => {
    const folder = await temporaryFolder();
    const appData = join(folder, "app-data");
    const drafts = join(appData, "drafts");
    await mkdir(drafts, { recursive: true });
    await chmod(drafts, 0o000);
    try {
      const process = track(
        spawnOmpProcess({
          threadId,
          folder,
          homeDir: folder,
          ompBin: FAKE_OMP,
          env: { OMP_APP_DATA_DIR: appData },
        }),
      );
      await process.start();
      await waitForFrame(process, (frame) => frame.type === "ready");
      expect(process.status).toBe("running");
    } finally {
      await chmod(drafts, 0o755);
    }
  });

  test("round-trips a written command as the fake's echoed response", async () => {
    const folder = await temporaryFolder();
    const process = track(spawnOmpProcess({ threadId, folder, homeDir: folder, ompBin: FAKE_OMP }));
    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");

    await process.writeLine('{"id":"cmd-1","type":"get_state"}\n');
    const response = await waitForFrame(process, (frame) => frame.type === "response");

    expect(response).toMatchObject({ id: "cmd-1", command: "get_state", success: true });
  });

  test("rejects start() once stopped, and stop() is idempotent", async () => {
    const folder = await temporaryFolder();
    const process = track(spawnOmpProcess({ threadId, folder, homeDir: folder, ompBin: FAKE_OMP }));
    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");

    await process.stop();
    expect(process.status).toBe("stopped");
    await process.stop(); // idempotent, no throw

    await expect(process.start()).rejects.toBeInstanceOf(AppFailure);
  });
});

/**
 * `Bun.spawn`, except that the first stop's wait for the child fails, as a wait the system cannot complete does. The
 * child runs as usual, so a later stop can end it. Reads of `exited`: 1 is the spawn's own exit watch, 2 is the first
 * stop's wait, and the rest pass through.
 */
function spawnWhoseFirstStopWaitFails(): typeof Bun.spawn {
  const spawn = (command: string[], options: object) => {
    const child = Bun.spawn(command, options as never);
    let exitedReads = 0;
    return new Proxy(child, {
      get(target, property) {
        if (property === "exited") {
          exitedReads += 1;
          if (exitedReads === 2)
            return Promise.reject(new Error("the child could not be waited for"));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return spawn as unknown as typeof Bun.spawn;
}

describe("OmpProcess shutdown", () => {
  test("stop() sends SIGTERM and resolves without secrets leaking into any event", async () => {
    const folder = await temporaryFolder();
    const events: OmpProcessEvent[] = [];
    const process = track(spawnOmpProcess({ threadId, folder, homeDir: folder, ompBin: FAKE_OMP }));
    process.onEvent((event) => events.push(event));
    let closedWith: unknown;
    process.onClose((cause) => {
      closedWith = cause;
    });

    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");
    await process.stop();

    expect(process.status).toBe("stopped");
    expect(closedWith).toBeUndefined();
    expect(events.map((event) => event.status)).toEqual(["starting", "running", "stopped"]);
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const timer = new ManualTimer();
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        env: { FAKE_OMP_IGNORE_SIGTERM: "1" },
        terminationGraceMs: 25,
        timer,
      }),
    );

    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");

    const stopPromise = process.stop();
    const pump = setInterval(() => timer.fireAll(), 5);
    try {
      await stopPromise;
    } finally {
      clearInterval(pump);
    }
    expect(process.status).toBe("stopped");
  });

  test("a stop whose wait fails is reported, and the next stop tries again and stops the child", async () => {
    const timer = new ManualTimer();
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        terminationGraceMs: 25,
        timer,
        spawn: spawnWhoseFirstStopWaitFails(),
      }),
    );

    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");

    await expect(process.stop()).rejects.toThrow("could not be waited for");
    expect(process.status).not.toBe("stopped");

    const pump = setInterval(() => timer.fireAll(), 5);
    try {
      await process.stop();
    } finally {
      clearInterval(pump);
    }
    expect(process.status).toBe("stopped");
  });
});

describe("OmpProcess crash handling", () => {
  test("a spontaneous exit becomes AppFailure omp_exited, bounded by the stderr tail", async () => {
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        env: { FAKE_OMP_EXIT_CODE: "9", FAKE_OMP_STDERR: "diagnostic: fixture crash" },
      }),
    );
    let closeCause: unknown;
    process.onClose((cause) => {
      closeCause = cause;
    });

    await process.start();
    const exited = await waitForEvent(process, (event) => event.status === "exited");

    expect(process.status).toBe("exited");
    const error = exited.error;
    if (error === undefined) throw new Error("expected an exit AppError");
    expect(error).toMatchObject({ code: "omp_exited", retryable: true });
    expect(error.message).toContain("diagnostic: fixture crash");
    expect(closeCause).toBeInstanceOf(AppFailure);
    expect((closeCause as AppFailure).appError).toEqual(error);
  });

  test("a crash message never carries a credential or private path from stderr", async () => {
    const folder = await temporaryFolder();
    // Assembled at runtime so no source line looks like a real key (the PR gate rejects those).
    const key = ["sk", "ant", "k".repeat(30)].join("-");
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        env: { FAKE_OMP_EXIT_CODE: "3", FAKE_OMP_STDERR: `error: provider rejected key ${key}` },
      }),
    );
    await process.start();
    const exited = await waitForEvent(process, (event) => event.status === "exited");
    expect(exited.error?.message).toBe("omp exited (exit code 3)");
    expect(process.stderrTail).toContain(key);
  });

  test("bounds the retained stderr tail and keeps the most recent bytes", async () => {
    const folder = await temporaryFolder();
    const head = "A".repeat(2000);
    const tail = "B".repeat(2000);
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        homeDir: folder,
        ompBin: FAKE_OMP,
        maxStderrBytes: 2500,
        env: { FAKE_OMP_EXIT_CODE: "1", FAKE_OMP_STDERR: head + tail },
      }),
    );

    await process.start();
    await waitForEvent(process, (event) => event.status === "exited");

    expect(process.stderrTail.length).toBeLessThanOrEqual(2500);
    expect(process.stderrTail).toContain("B");
    expect(process.stderrTail.endsWith("B")).toBe(true);
  });
});

describe("the arguments for the chat's folder (issue 1143)", () => {
  test("only the home folder itself gets --allow-home; a subfolder or another folder does not", async () => {
    const root = await temporaryFolder();
    const home = join(root, "home");
    const project = join(home, "project");
    const other = join(root, "other");
    await mkdir(project, { recursive: true });
    await mkdir(other, { recursive: true });

    expect(await homeFolderArguments(home, home)).toEqual(["--allow-home"]);
    expect(await homeFolderArguments(project, home)).toEqual([]);
    expect(await homeFolderArguments(other, home)).toEqual([]);
  });

  test("the home folder is compared by its real path, so a link to it counts, and a missing folder does not", async () => {
    const root = await temporaryFolder();
    const home = join(root, "home");
    const link = join(root, "home-link");
    await mkdir(home, { recursive: true });
    await symlink(home, link);

    expect(await homeFolderArguments(link, home)).toEqual(["--allow-home"]);
    expect(await homeFolderArguments(join(root, "missing"), home)).toEqual([]);
  });
});

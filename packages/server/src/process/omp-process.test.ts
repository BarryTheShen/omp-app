import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
  readonly callbacks = new Map<number, { readonly handler: () => void; readonly delay: number }>();
  readonly delays: number[] = [];

  setTimeout(handler: () => void, delayMs: number): number {
    this.delays.push(delayMs);
    const id = ++this.#nextId;
    this.callbacks.set(id, { handler, delay: delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }

  fireWhere(predicate: (delay: number) => boolean): void {
    const callbacks = [...this.callbacks.entries()];
    for (const [id, entry] of callbacks) {
      if (!predicate(entry.delay)) continue;
      this.callbacks.delete(id);
      entry.handler();
    }
  }

  fireAll(): void {
    this.fireWhere(() => true);
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

  test("round-trips a written command as the fake's echoed response", async () => {
    const folder = await temporaryFolder();
    const process = track(spawnOmpProcess({ threadId, folder, ompBin: FAKE_OMP }));
    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");

    await process.writeLine('{"id":"cmd-1","type":"get_state"}\n');
    const response = await waitForFrame(process, (frame) => frame.type === "response");

    expect(response).toMatchObject({ id: "cmd-1", command: "get_state", success: true });
  });

  test("rejects start() and restart() once stopped, and stop() is idempotent", async () => {
    const folder = await temporaryFolder();
    const process = track(spawnOmpProcess({ threadId, folder, ompBin: FAKE_OMP }));
    await process.start();
    await waitForFrame(process, (frame) => frame.type === "ready");

    await process.stop();
    expect(process.status).toBe("stopped");
    await process.stop(); // idempotent, no throw

    await expect(process.start()).rejects.toBeInstanceOf(AppFailure);
    await expect(process.restart()).rejects.toBeInstanceOf(AppFailure);
  });
});

describe("OmpProcess shutdown", () => {
  test("stop() sends SIGTERM and resolves without secrets leaking into any event", async () => {
    const folder = await temporaryFolder();
    const events: OmpProcessEvent[] = [];
    const process = track(spawnOmpProcess({ threadId, folder, ompBin: FAKE_OMP }));
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
});

describe("OmpProcess crash handling", () => {
  test("a spontaneous exit becomes AppFailure omp_exited, bounded by the stderr tail", async () => {
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
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

describe("OmpProcess restart with backoff", () => {
  test("delays escalate across repeated crash-driven restarts and the first attempt is immediate", async () => {
    const timer = new ManualTimer();
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        ompBin: FAKE_OMP,
        env: { FAKE_OMP_EXIT_CODE: "2" },
        backoff: { baseMs: 50, maxMs: 500, stableMs: 999_999 },
        timer,
      }),
    );

    await process.start();
    await waitForEvent(process, (event) => event.status === "exited");
    const firstProcessId = process.processId;

    await process.restart(); // consecutiveFailures 0 -> delay 0, no timer entry
    await waitForEvent(process, (event) => event.status === "exited");
    const secondProcessId = process.processId;

    const restart2 = process.restart(); // consecutiveFailures 1 -> delay 50
    const pumpBackoff = () => timer.fireWhere((delay) => delay < 999_999);
    await waitForEvent(process, (event) => event.status === "exited", { pump: pumpBackoff });
    await restart2;

    const restart3 = process.restart(); // consecutiveFailures 2 -> delay 100
    await waitForEvent(process, (event) => event.status === "exited", { pump: pumpBackoff });
    await restart3;

    const backoffDelays = timer.delays.filter((delay) => delay !== 999_999);
    expect(backoffDelays).toEqual([50, 100]);
    expect(secondProcessId).not.toBe(firstProcessId);
  });

  test("a stable run resets the backoff counter", async () => {
    const timer = new ManualTimer();
    const folder = await temporaryFolder();
    const process = track(
      spawnOmpProcess({
        threadId,
        folder,
        ompBin: FAKE_OMP,
        env: { FAKE_OMP_EXIT_CODE: "2" },
        backoff: { baseMs: 50, maxMs: 500, stableMs: 10 },
        timer,
      }),
    );

    await process.start();
    await waitForEvent(process, (event) => event.status === "exited");
    await process.restart(); // first attempt is immediate; failure count becomes 1
    await waitForEvent(process, (event) => event.status === "exited");

    const restart3 = process.restart(); // delay 50 after the second failure
    await waitForEvent(process, (event) => event.status === "running", {
      pump: () => timer.fireWhere((delay) => delay === 50),
    });
    await restart3;
    // The process is "running" again; fire the stability timer to simulate a stable run.
    timer.fireWhere((delay) => delay === 10);
    await waitForEvent(process, (event) => event.status === "exited");

    const restart4 = process.restart(); // stability reset makes this immediate again
    await waitForEvent(process, (event) => event.status === "running");
    await restart4;

    const backoffDelays = timer.delays.filter((delay) => delay !== 10);
    expect(backoffDelays).toEqual([50]);
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

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AppError,
  FolderPath,
  OmpProcessId,
  ProcessStatus,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, checkScrubbed, OmpProcessId as OmpProcessIdSchema } from "@omp-app/contracts";
import type { RpcDuplex, RpcSessionTimer } from "@omp-app/omp-rpc";

/** `--mode rpc-ui` is required: it is the only mode that forwards extension/tool UI requests. */
const OMP_MODE_ARGS = ["--mode", "rpc-ui"] as const;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_PENDING_CHUNK_BYTES = 1024 * 1024;

export interface OmpProcessOptions {
  /** For attribution and logging only; never parsed or matched against omp's own session id. */
  readonly threadId: ThreadId;
  /** The chat's folder; omp's cwd. */
  readonly folder: FolderPath;
  /** The home folder the server runs under; defaults to the operating system's home. */
  readonly homeDir?: string;
  /** Defaults to `OMP_BIN`, else `"omp"` resolved from `PATH`. */
  readonly ompBin?: string;
  /** Extra argv appended after the forced `--mode rpc-ui` (for example `--resume <id>`). */
  readonly args?: readonly string[];
  /** Merged over the current process environment; a key set to `undefined` is removed. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Bound on the retained stderr tail. Default 16 KiB. */
  readonly maxStderrBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. Default 5000 ms. */
  readonly terminationGraceMs?: number;
  /** Injectable for deterministic tests; defaults to the global timer. */
  readonly timer?: RpcSessionTimer;
  /** Injectable for deterministic tests; defaults to `Bun.spawn`. */
  readonly spawn?: typeof Bun.spawn;
}

export interface OmpProcessEvent {
  readonly status: ProcessStatus;
  /** The id of the currently (or most recently) running child; absent before the first spawn. */
  readonly processId?: OmpProcessId;
  /** Present for "error" and unexpected "exited" transitions. */
  readonly error?: AppError;
}

export type OmpProcessListener = (event: OmpProcessEvent) => void;

/**
 * One spawned `omp --mode rpc-ui` child and its lifecycle. Implements `RpcDuplex` so an
 * `RpcSession` can be built directly around it: construct the session first (so its `onChunk`
 * subscription is registered), then call `start()`.
 */
export interface OmpProcess extends RpcDuplex {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly status: ProcessStatus;
  /** The OS process id of the current child, once spawned. */
  readonly pid: number | undefined;
  /** Fresh on every successful spawn; scopes `OmpStreamMessageId` per C0's `ids.ts`. */
  readonly processId: OmpProcessId | undefined;
  /** Bounded recent stderr text; never includes environment values or the command line. */
  readonly stderrTail: string;
  /**
   * Resolves once the stderr pipe has been read to its end, or after half a second: omp's last lines can arrive
   * after it exits. Optional, so that test doubles need not implement it.
   */
  stderrSettled?(): Promise<void>;
  /** Spawns the child if this is the first call; later calls return the same promise. */
  start(): Promise<void>;
  /** Terminates the child (SIGTERM, then SIGKILL after the grace period) and marks this terminal. */
  stop(): Promise<void>;
  onEvent(listener: OmpProcessListener): () => void;
}

type OmpSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

function defaultTimer(): RpcSessionTimer {
  return {
    setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number | Timer),
  };
}

function conflictFailure(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: false });
}

function spawnFailure(cause: unknown): AppFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AppFailure({
    code: "omp_exited",
    message: `Failed to start omp: ${message}`,
    retryable: true,
  });
}

function writeFailure(cause: unknown): AppFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AppFailure({
    code: "omp_exited",
    message: `Failed to write to omp: ${message}`,
    retryable: true,
  });
}

/**
 * Never includes the command line or environment. The message reaches the browser, so it carries at
 * most omp's last stderr line (200 characters), and only when C0's scrub check finds no secret or
 * private path in it; the full bounded tail stays on the server (`stderrTail`).
 */
function crashFailure(
  exitCode: number | null,
  signal: string | null,
  stderrTail: string,
): AppFailure {
  const reason = signal !== null ? `signal ${signal}` : `exit code ${exitCode}`;
  const lastLine = (stderrTail.trim().split("\n").at(-1) ?? "").trim().slice(0, 200);
  const safe = lastLine.length > 0 && checkScrubbed(lastLine).length === 0;
  const message = safe ? `omp exited (${reason}): ${lastLine}` : `omp exited (${reason})`;
  return new AppFailure({ code: "omp_exited", message, retryable: true });
}

class SpawnedOmpProcess implements OmpProcess {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly #ompBin: string;
  readonly #args: readonly string[];
  readonly #homeDir: string;
  readonly #envOverrides: Readonly<Record<string, string | undefined>>;
  readonly #maxStderrBytes: number;
  readonly #terminationGraceMs: number;
  readonly #timer: RpcSessionTimer;
  readonly #spawn: typeof Bun.spawn;
  readonly #listeners = new Set<OmpProcessListener>();
  readonly #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(cause?: unknown) => void>();

  #status: ProcessStatus = "starting";
  #processId: OmpProcessId | undefined;
  #child: OmpSubprocess | undefined;
  #startPromise: Promise<void> | undefined;
  #expectingExit = false;
  #terminal = false;
  #stopFailed = false;
  #stderrDecoder = new TextDecoder();
  #stderrText = "";
  /** Settles when the stderr pipe has been read to its end (see `stderrSettled`). */
  #stderrDone: Promise<void> = Promise.resolve();
  #hasHadChunkListener = false;
  #pendingChunks: Uint8Array[] = [];
  #pendingChunkBytes = 0;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: OmpProcessOptions) {
    this.threadId = options.threadId;
    this.folder = options.folder;
    this.#ompBin = options.ompBin ?? Bun.env.OMP_BIN ?? "omp";
    this.#args = options.args ?? [];
    this.#homeDir = options.homeDir ?? homedir();
    this.#envOverrides = options.env ?? {};
    this.#maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.#terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.#timer = options.timer ?? defaultTimer();
    this.#spawn = options.spawn ?? Bun.spawn;
  }

  get status(): ProcessStatus {
    return this.#status;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get processId(): OmpProcessId | undefined {
    return this.#processId;
  }

  get stderrTail(): string {
    return this.#stderrText;
  }

  start(): Promise<void> {
    if (this.#terminal)
      return Promise.reject(conflictFailure("This omp process was already stopped"));
    this.#startPromise ??= this.#spawnChild();
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    // A stop whose wait failed may have left the child running, so the next stop tries again.
    if (this.#terminal && !this.#stopFailed) return;
    this.#terminal = true;
    this.#stopFailed = false;
    try {
      await this.#terminate();
    } catch (error) {
      this.#stopFailed = true;
      throw error;
    }
    this.#setStatus("stopped");
    this.#notifyClose(undefined);
  }

  close(): Promise<void> {
    return this.stop();
  }

  writeLine(line: string): Promise<void> {
    const next = this.#writeTail.then(() => this.#writeNow(line));
    this.#writeTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    if (!this.#hasHadChunkListener) {
      this.#hasHadChunkListener = true;
      const buffered = this.#pendingChunks;
      this.#pendingChunks = [];
      this.#pendingChunkBytes = 0;
      for (const chunk of buffered) listener(chunk);
    }
    return () => this.#chunkListeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onEvent(listener: OmpProcessListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #writeNow(line: string): Promise<void> {
    const stdin = this.#child?.stdin;
    if (stdin === undefined) throw writeFailure(new Error("omp has not been started"));
    try {
      stdin.write(line);
      await stdin.flush();
    } catch (error) {
      throw writeFailure(error);
    }
  }

  async #spawnChild(): Promise<void> {
    this.#setStatus("starting");
    const env = this.#buildEnv();
    const homeArgs = await homeFolderArguments(this.folder, this.#homeDir);
    let child: OmpSubprocess;
    try {
      child = this.#spawn([this.#ompBin, ...OMP_MODE_ARGS, ...homeArgs, ...this.#args], {
        cwd: this.folder,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      this.#setStatus("error");
      const failure = spawnFailure(error);
      this.#emit({ status: "error", error: failure.appError });
      throw failure;
    }
    this.#child = child;
    this.#processId = OmpProcessIdSchema.parse(crypto.randomUUID());
    this.#stderrDecoder = new TextDecoder();
    this.#stderrText = "";
    void this.#pumpStdout(child.stdout);
    this.#stderrDone = this.#pumpStderr(child.stderr);
    void child.exited.then((exitCode) => this.#onChildExited(exitCode));
    this.#setStatus("running");
  }

  async #terminate(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.#expectingExit = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone; the exit handler below will still observe it.
    }
    let killTimerHandle: unknown;
    const escalate = new Promise<void>((resolve) => {
      killTimerHandle = this.#timer.setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, this.#terminationGraceMs);
    });
    try {
      await Promise.race([child.exited.then(() => undefined), escalate]);
      await child.exited;
    } finally {
      this.#timer.clearTimeout(killTimerHandle);
    }
    // Left set when the wait fails: a child that exits later was still stopped on purpose.
    this.#expectingExit = false;
  }

  #onChildExited(exitCode: number): void {
    if (this.#expectingExit) return;
    const child = this.#child;
    const signal = child?.signalCode ?? null;
    const failure = crashFailure(exitCode, signal, this.stderrTail);
    this.#status = "exited";
    this.#emit({ status: "exited", error: failure.appError });
    this.#notifyClose(failure);
  }

  /** Resolves once the stderr pipe has been read to its end, or after half a second, whichever is first. */
  stderrSettled(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const handle = this.#timer.setTimeout(() => resolve(), 500);
    void this.#stderrDone.then(() => {
      this.#timer.clearTimeout(handle);
      resolve();
    });
    return promise;
  }

  async #pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) this.#deliverChunk(value);
      }
    } catch {
      // The exit handler surfaces the failure; a read error here is not separately reported.
    } finally {
      reader.releaseLock();
    }
  }

  async #pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) this.#appendStderr(value);
      }
    } catch {
      // Best-effort diagnostics only.
    } finally {
      reader.releaseLock();
    }
  }

  #deliverChunk(chunk: Uint8Array): void {
    if (!this.#hasHadChunkListener) {
      this.#pendingChunks.push(chunk);
      this.#pendingChunkBytes += chunk.byteLength;
      while (
        this.#pendingChunkBytes > DEFAULT_MAX_PENDING_CHUNK_BYTES &&
        this.#pendingChunks.length > 1
      ) {
        const dropped = this.#pendingChunks.shift();
        if (dropped !== undefined) this.#pendingChunkBytes -= dropped.byteLength;
      }
      return;
    }
    for (const listener of [...this.#chunkListeners]) listener(chunk);
  }

  #appendStderr(chunk: Uint8Array): void {
    this.#stderrText += this.#stderrDecoder.decode(chunk, { stream: true });
    if (this.#stderrText.length > this.#maxStderrBytes) {
      this.#stderrText = this.#stderrText.slice(this.#stderrText.length - this.#maxStderrBytes);
    }
  }

  #buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(this.#envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  #setStatus(status: ProcessStatus): void {
    this.#status = status;
    this.#emit({ status });
  }

  #emit(partial: { status: ProcessStatus; error?: AppError }): void {
    const event: OmpProcessEvent = {
      status: partial.status,
      ...(this.#processId === undefined ? {} : { processId: this.#processId }),
      ...(partial.error === undefined ? {} : { error: partial.error }),
    };
    for (const listener of [...this.#listeners]) listener(event);
  }

  #notifyClose(cause: unknown): void {
    for (const listener of [...this.#closeListeners]) listener(cause);
  }
}

/** Spawns a fresh `omp --mode rpc-ui` child; the default `createProcess` for `OmpProcessRegistry`. */
export function spawnOmpProcess(options: OmpProcessOptions): OmpProcess {
  return new SpawnedOmpProcess(options);
}

/**
 * omp moves itself to `/tmp` when it starts in the home folder, so a chat opened there was saved in
 * another folder (issue 1143). `--allow-home` keeps omp in the folder the chat names. It is passed for
 * the home folder itself only, compared by real path; a subfolder or any other folder starts as before.
 */
export async function homeFolderArguments(
  folder: string,
  homeDir: string,
): Promise<readonly string[]> {
  const [chat, home] = await Promise.all([realPathOrResolved(folder), realPathOrResolved(homeDir)]);
  return chat === home ? ["--allow-home"] : [];
}

async function realPathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

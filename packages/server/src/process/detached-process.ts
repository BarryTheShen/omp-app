/**
 * A chat host started to outlive the server (D2, `D2-step1-plan.md`): in its own systemd user scope when the user's
 * service manager is there, so stopping or restarting the server's service stops no host, else in a session of its own.
 * The server reaches it over its Unix socket (`chat-host/socket.ts`) instead of pipes. Its output goes to
 * `<socket>.log`, whose tail stands in for the stderr a piped host gives. `release` lets go of a host without ending
 * it; `stop` ends it, as for a piped host.
 */
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppError, OmpProcessId, ProcessStatus } from "@omp-app/contracts";
import {
  AppFailure,
  FolderPath,
  OmpProcessId as OmpProcessIdSchema,
  ThreadId,
} from "@omp-app/contracts";
import { type ChatHostHello, parseHostLine } from "@omp-app/contracts/chat-host";
import {
  buildChatEnv,
  homeFolderArguments,
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessListener,
  type ProcessTimer,
  type SpawnOmpProcessOptions,
} from "./omp-process";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_LOG_TAIL = 16 * 1024;

/** Whether a process is still there (signal 0 checks without signalling). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DetachedOmpProcessOptions extends SpawnOmpProcessOptions {
  /** The folder of the hosts' sockets and logs; made the user's alone. */
  readonly hostsDir: string;
  /** Start each host in its own systemd user scope; else in a session of its own (`setsid`). */
  readonly systemdScope: boolean;
  /** How long a starting host may take to open its socket. Default 30 s. */
  readonly connectTimeoutMs?: number;
}

/** Whether the user's systemd service manager answers here: its bus in the runtime folder, and `systemd-run`. */
export function systemdUserScopes(env: Readonly<Record<string, string | undefined>>): boolean {
  const runtime = env.XDG_RUNTIME_DIR;
  return (
    runtime !== undefined && existsSync(join(runtime, "bus")) && Bun.which("systemd-run") !== null
  );
}

function failure(code: "omp_exited" | "conflict", message: string): AppFailure {
  return new AppFailure({ code, message, retryable: code === "omp_exited" });
}

class DetachedOmpProcess implements OmpProcess {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly #options: DetachedOmpProcessOptions;
  readonly #timer: ProcessTimer;
  readonly #listeners = new Set<OmpProcessListener>();
  readonly #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(cause?: unknown) => void>();
  #status: ProcessStatus = "starting";
  #processId: OmpProcessId | undefined;
  #child: Bun.Subprocess | undefined;
  #socket: Bun.Socket<undefined> | undefined;
  #socketPath: string | undefined;
  #outgoing: Uint8Array[] = [];
  #drained: (() => void)[] = [];
  #startPromise: Promise<void> | undefined;
  #terminal = false;
  #released = false;
  #logTail = "";
  /** Until a client listens: the host's first line, its hello (see `#deliver`). */
  #hello: Uint8Array[] = [];
  #helloEnded = false;
  /** The host's process id from its hello, for a host this server attached to instead of starting (D2). */
  #adoptedPid: number | undefined;
  /** Waiting for the link to the host to close. */
  #disconnectWaiters: (() => void)[] = [];

  constructor(options: DetachedOmpProcessOptions) {
    this.threadId = options.threadId;
    this.folder = options.folder;
    this.#options = options;
    this.#timer = options.timer ?? {
      setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number | Timer),
    };
  }

  /**
   * Attaches to a host already running (D2: a server that starts finds the hosts an earlier one left): connects to its
   * socket and reads its hello, which names the chat. The hello stays first in what the chat's client reads.
   * `"absent"` when nothing listens on the socket (its host is gone); null when something does but sends no hello in
   * time (a host still held by another server closes a second connection at once): that socket must stay.
   */
  static async attach(options: {
    readonly socketPath: string;
    readonly timer?: ProcessTimer;
    readonly terminationGraceMs?: number;
    readonly helloTimeoutMs?: number;
  }): Promise<
    { readonly process: DetachedOmpProcess; readonly hello: ChatHostHello } | "absent" | null
  > {
    let target: DetachedOmpProcess | undefined;
    const early: Uint8Array[] = [];
    let ended = false;
    let socket: Bun.Socket<undefined>;
    try {
      socket = await Bun.connect({
        unix: options.socketPath,
        socket: {
          data: (_socket, data) => {
            if (target === undefined) early.push(data);
            else target.#deliver(data);
          },
          drain: () => {
            if (target !== undefined) target.#send();
          },
          close: () => {
            if (target === undefined) ended = true;
            else target.#onDisconnected();
          },
          error: () => undefined,
        },
      });
    } catch {
      return "absent";
    }
    const deadline = Date.now() + (options.helloTimeoutMs ?? 5_000);
    const decoder = new TextDecoder();
    let text = "";
    let read = 0;
    for (;;) {
      while (read < early.length) text += decoder.decode(early[read++], { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        const parsed = parseHostLine(text.slice(0, newline));
        if (!parsed.ok || parsed.value.kind !== "hello") {
          socket.end();
          return null;
        }
        const hello = parsed.value;
        const attached = new DetachedOmpProcess({
          threadId: ThreadId.parse(hello.session.id),
          folder: FolderPath.parse(hello.session.cwd),
          chatCommand: [],
          hostsDir: dirname(options.socketPath),
          systemdScope: false,
          ...(options.timer === undefined ? {} : { timer: options.timer }),
          ...(options.terminationGraceMs === undefined
            ? {}
            : { terminationGraceMs: options.terminationGraceMs }),
        });
        attached.#processId = OmpProcessIdSchema.parse(crypto.randomUUID());
        attached.#socket = socket;
        attached.#socketPath = options.socketPath;
        attached.#adoptedPid = hello.pid;
        attached.#startPromise = Promise.resolve();
        attached.#status = "running";
        for (const chunk of early) attached.#deliver(chunk);
        target = attached;
        if (ended) attached.#onDisconnected();
        return { process: attached, hello };
      }
      if (ended || Date.now() > deadline) {
        socket.end();
        return null;
      }
      await Bun.sleep(20);
    }
  }

  get status(): ProcessStatus {
    return this.#status;
  }

  get pid(): number | undefined {
    return this.#child?.pid ?? this.#adoptedPid;
  }

  get processId(): OmpProcessId | undefined {
    return this.#processId;
  }

  get stderrTail(): string {
    return this.#logTail;
  }

  /** Reads the host's log into the tail: what it said before it ended. */
  async stderrSettled(): Promise<void> {
    const path = this.#socketPath;
    if (path === undefined) return;
    try {
      const text = await readFile(`${path}.log`, "utf8");
      this.#logTail = text.slice(Math.max(0, text.length - MAX_LOG_TAIL));
    } catch {
      // No log yet: nothing to show.
    }
  }

  start(): Promise<void> {
    if (this.#terminal)
      return Promise.reject(failure("conflict", "This omp process was already stopped"));
    this.#startPromise ??= this.#launch();
    return this.#startPromise;
  }

  async #launch(): Promise<void> {
    this.#setStatus("starting");
    const options = this.#options;
    const homeDir = options.homeDir ?? (Bun.env.HOME as string);
    const processId = OmpProcessIdSchema.parse(crypto.randomUUID());
    this.#processId = processId;
    await mkdir(options.hostsDir, { recursive: true, mode: 0o700 });
    const socketPath = join(options.hostsDir, `${processId}.sock`);
    this.#socketPath = socketPath;
    let child: Bun.Subprocess;
    try {
      const env = await buildChatEnv({
        overrides: options.env ?? {},
        homeDir,
        folder: this.folder,
      });
      env.OMP_APP_HOST_SOCKET = socketPath;
      const command = [
        ...options.chatCommand,
        ...(await homeFolderArguments(this.folder, homeDir)),
        ...(options.args ?? []),
      ];
      const launcher = options.systemdScope
        ? [
            "systemd-run",
            "--user",
            "--scope",
            "--collect",
            "--quiet",
            `--unit=omp-app-chat-${processId}`,
            "--",
          ]
        : ["setsid"];
      const log = openSync(`${socketPath}.log`, "a", 0o600);
      try {
        child = (options.spawn ?? Bun.spawn)([...launcher, ...command], {
          cwd: this.folder,
          env,
          stdin: "ignore",
          stdout: log,
          stderr: log,
        });
      } finally {
        closeSync(log);
      }
    } catch (error) {
      this.#setStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      const failed = failure("omp_exited", `Failed to start omp: ${message}`);
      this.#emit({ status: "error", error: failed.appError });
      throw failed;
    }
    this.#child = child;
    void child.exited.then(() => this.#onChildExited());
    try {
      this.#socket = await this.#connect(socketPath, child);
    } catch (error) {
      await this.stderrSettled();
      this.#setStatus("error");
      const failed =
        error instanceof AppFailure
          ? error
          : failure("omp_exited", `Failed to reach omp: ${String(error)}`);
      this.#emit({ status: "error", error: failed.appError });
      throw failed;
    }
    this.#setStatus("running");
  }

  /** Connects to the host's socket once it is open; fails when the host ends first or takes too long. */
  async #connect(path: string, child: Bun.Subprocess): Promise<Bun.Socket<undefined>> {
    const deadline = Date.now() + (this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw failure("omp_exited", "omp ended before it was ready");
      if (existsSync(path)) {
        try {
          return await Bun.connect({
            unix: path,
            socket: {
              data: (_socket, data) => this.#deliver(data),
              drain: () => this.#send(),
              close: () => this.#onDisconnected(),
              error: () => undefined,
            },
          });
        } catch {
          // Not listening yet.
        }
      }
      if (Date.now() > deadline) throw failure("omp_exited", "omp did not open its socket in time");
      await Bun.sleep(50);
    }
  }

  #deliver(chunk: Uint8Array): void {
    if (this.#chunkListeners.size > 0) {
      for (const listener of [...this.#chunkListeners]) listener(chunk);
      return;
    }
    // Nobody reads yet: a host attached at this server's start, whose chat is not open. Its hello is kept for the client
    // that opens the chat; what follows is dropped, since that client asks the host for what is live then
    // (`replay_live`). A host this server starts is read from before it starts.
    if (this.#helloEnded) return;
    const newline = chunk.indexOf(10);
    if (newline === -1) {
      this.#hello.push(chunk);
      return;
    }
    this.#hello.push(chunk.subarray(0, newline + 1));
    this.#helloEnded = true;
  }

  #send(): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    while (this.#outgoing.length > 0) {
      const chunk = this.#outgoing[0] as Uint8Array;
      const written = socket.write(chunk);
      if (written < 0) return;
      if (written < chunk.length) {
        this.#outgoing[0] = chunk.subarray(written);
        return;
      }
      this.#outgoing.shift();
    }
    for (const resolve of this.#drained.splice(0)) resolve();
  }

  writeLine(line: string): Promise<void> {
    if (this.#socket === undefined)
      return Promise.reject(failure("omp_exited", "Failed to write to omp: it is not connected"));
    this.#outgoing.push(new TextEncoder().encode(line));
    const done = new Promise<void>((resolve) => this.#drained.push(resolve));
    this.#send();
    return done;
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    for (const chunk of this.#hello.splice(0)) listener(chunk);
    this.#helloEnded = true;
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

  /** Lets go of the host without ending it: it keeps its chat until a server attaches again or it hands it back. */
  async release(): Promise<void> {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#released = true;
    // What was written goes first (a `hand_back`, say), within a bound: a host that reads nothing more is let go of.
    if (this.#outgoing.length > 0 && this.#socket !== undefined) {
      const drained = new Promise<void>((resolve) => this.#drained.push(resolve));
      await Promise.race([drained, Bun.sleep(1_000)]);
    }
    this.#socket?.end();
    this.#setStatus("stopped");
    this.#notifyClose(undefined);
  }

  /**
   * Ends the host. One this server started: SIGTERM, then SIGKILL after the grace period, as for a piped host. One it
   * attached to: asked to hand its chat back, then signalled the same way when it has not gone within the grace period.
   */
  async stop(): Promise<void> {
    if (this.#terminal && !this.#released) return;
    this.#terminal = true;
    const child = this.#child;
    if (child === undefined && this.#adoptedPid !== undefined) {
      await this.#stopAdopted(this.#adoptedPid);
      await this.#removeFiles();
      this.#setStatus("stopped");
      this.#notifyClose(undefined);
      return;
    }
    this.#socket?.end();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      let handle: unknown;
      const escalate = new Promise<void>((resolve) => {
        handle = this.#timer.setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          resolve();
        }, this.#options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
      });
      try {
        await Promise.race([child.exited.then(() => undefined), escalate]);
        await child.exited;
      } finally {
        this.#timer.clearTimeout(handle);
      }
    }
    await this.#removeFiles();
    this.#setStatus("stopped");
    this.#notifyClose(undefined);
  }

  close(): Promise<void> {
    return this.stop();
  }

  /**
   * Asks the host to hand its chat back (`hand_back`): it answers, finishes a turn that runs, and ends, closing its link.
   * Its answer reaches nobody: the link's close is what tells that it went (`whenGone`).
   */
  handBack(): void {
    if (this.#socket === undefined) return;
    this.#outgoing.push(
      new TextEncoder().encode(
        `${JSON.stringify({ kind: "request", id: "hand-back", method: "hand_back", params: {} })}\n`,
      ),
    );
    this.#send();
  }

  /** Resolves true once the host's link closes, or false when it is still open after `ms`. */
  whenGone(ms: number): Promise<boolean> {
    if (this.#socket === undefined) return Promise.resolve(true);
    const gone = new Promise<boolean>((resolve) =>
      this.#disconnectWaiters.push(() => resolve(true)),
    );
    return Promise.race([gone, Bun.sleep(ms).then(() => false)]);
  }

  /** Asks an attached host to hand its chat back; signals its process when it has not gone in the grace period. */
  async #stopAdopted(pid: number): Promise<void> {
    const grace = this.#options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.handBack();
    await this.whenGone(grace);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!alive(pid)) return;
      try {
        process.kill(pid, signal);
      } catch {
        return;
      }
      for (let waited = 0; waited < grace && alive(pid); waited += 50) await Bun.sleep(50);
    }
  }

  #onDisconnected(): void {
    this.#socket = undefined;
    for (const resolve of this.#drained.splice(0)) resolve();
    for (const resolve of this.#disconnectWaiters.splice(0)) resolve();
    // A host this server attached to has no child to watch: its link closing on its own is its end.
    if (this.#child === undefined && !this.#terminal) {
      this.#terminal = true;
      const failed = failure("omp_exited", "omp ended");
      this.#status = "exited";
      this.#emit({ status: "exited", error: failed.appError });
      this.#notifyClose(failed);
    }
  }

  async #onChildExited(): Promise<void> {
    if (this.#terminal) return;
    this.#terminal = true;
    await this.stderrSettled();
    const child = this.#child;
    const reason =
      child?.signalCode !== null && child?.signalCode !== undefined
        ? `signal ${child.signalCode}`
        : `exit code ${child?.exitCode ?? "unknown"}`;
    const failed = failure("omp_exited", `omp exited (${reason})`);
    this.#status = "exited";
    this.#emit({ status: "exited", error: failed.appError });
    this.#notifyClose(failed);
    await this.#removeFiles();
  }

  async #removeFiles(): Promise<void> {
    const path = this.#socketPath;
    if (path === undefined) return;
    await Promise.all([rm(path, { force: true }), rm(`${path}.log`, { force: true })]);
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

/** Starts a chat host that outlives the server, reached over its socket. */
export function spawnDetachedOmpProcess(options: DetachedOmpProcessOptions): OmpProcess {
  return new DetachedOmpProcess(options);
}

/**
 * Finds the hosts an earlier server left running in `hostsDir` (D2), as a server starts. A host on this server's
 * protocol is attached to and given to `adopt`, which serves its chat from then on. One on another protocol is asked to
 * hand its chat back (it finishes the turn it runs, then ends), and `handingBack` is told its chat. A socket nothing
 * listens on is removed with its log; one another server holds is left alone.
 */
export async function adoptRunningHosts(options: {
  readonly hostsDir: string;
  /** The chat host protocol this server speaks (`CHAT_HOST_PROTOCOL_VERSION`). */
  readonly protocol: number;
  readonly adopt: (process: OmpProcess, hello: ChatHostHello) => void;
  readonly handingBack: (threadId: ThreadId) => void;
  /** A host attached to whose chat could not be taken over; it was stopped. */
  readonly onFailed?: (threadId: ThreadId, error: unknown) => void;
}): Promise<{ readonly adopted: number; readonly handedBack: number }> {
  let names: string[];
  try {
    names = await readdir(options.hostsDir);
  } catch {
    return { adopted: 0, handedBack: 0 };
  }
  let adopted = 0;
  let handedBack = 0;
  for (const name of names) {
    if (!name.endsWith(".sock")) continue;
    const socketPath = join(options.hostsDir, name);
    const attached = await DetachedOmpProcess.attach({ socketPath });
    if (attached === "absent") {
      await Promise.all([
        rm(socketPath, { force: true }),
        rm(`${socketPath}.log`, { force: true }),
      ]);
      continue;
    }
    if (attached === null) continue;
    const { process, hello } = attached;
    if (hello.protocol !== options.protocol) {
      process.handBack();
      options.handingBack(process.threadId);
      await process.release();
      handedBack += 1;
      continue;
    }
    try {
      options.adopt(process, hello);
      adopted += 1;
    } catch (error) {
      options.onFailed?.(process.threadId, error);
    }
  }
  return { adopted, handedBack };
}

/**
 * Asks each host in `hostsDir` that no server holds to hand its chat back now (`omp-app tui`, D2 section 3), rather
 * than after its wait; a turn that runs is finished first. A host a server holds is the app's, and stays. Waits up to
 * `waitMs` for the hosts asked to go; one still finishing a turn is let go of, and goes when its turn ends.
 */
export async function handBackHosts(options: {
  readonly hostsDir: string;
  readonly waitMs: number;
  /** Told how many hosts were asked, before the wait. */
  readonly onAsked?: (count: number) => void;
}): Promise<{ readonly handedBack: number; readonly finishing: number }> {
  let names: string[];
  try {
    names = await readdir(options.hostsDir);
  } catch {
    return { handedBack: 0, finishing: 0 };
  }
  const asked: DetachedOmpProcess[] = [];
  for (const name of names) {
    if (!name.endsWith(".sock")) continue;
    const attached = await DetachedOmpProcess.attach({ socketPath: join(options.hostsDir, name) });
    if (attached === "absent" || attached === null) continue;
    attached.process.handBack();
    asked.push(attached.process);
  }
  if (asked.length === 0) return { handedBack: 0, finishing: 0 };
  options.onAsked?.(asked.length);
  const gone = await Promise.all(asked.map((process) => process.whenGone(options.waitMs)));
  await Promise.all(asked.map((process, index) => (gone[index] ? undefined : process.release())));
  const handedBack = gone.filter(Boolean).length;
  return { handedBack, finishing: asked.length - handedBack };
}

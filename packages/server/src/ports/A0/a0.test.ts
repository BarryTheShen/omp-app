import { describe, expect, test } from "bun:test";
import {
  AppFailure,
  FolderPath,
  HostCallId,
  OmpProcessId,
  type OmpProcessId as OmpProcessIdType,
  RequestId,
  rpcSessionEventStream,
  SessionFilePath,
  type StreamKey,
  ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import { z } from "zod";
import type { Logger } from "../../logging";
import {
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessOptions,
  OmpProcessRegistry,
} from "../../process";
import type { PortHandlerContext as ServerPortHandlerContext } from "../../registry/ports";
import { EventReplayHub } from "../../replay";
import {
  type A0PortContext,
  createA0PortRegistrations,
  createA0Runtime,
  type ThreadBootstrap,
} from "./index";

const encoder = new TextEncoder();
const folder = FolderPath.parse("/workspace/a0-7");
const authorityThread = ThreadId.parse("omp-session-a0-7");
const authorityFile = SessionFilePath.parse("/workspace/a0-7/.omp/authoritative.jsonl");
const bootstrap: ThreadBootstrap = {
  threadId: ThreadId.parse("thread-a0-7"),
  folderPath: folder,
  sessionFile: authorityFile,
};
const HostTools = z.array(z.object({ name: z.string() }).passthrough());
const HostUriSchemes = z.array(z.object({ scheme: z.string() }).passthrough());

function registeredToolNames(value: unknown): string[] {
  const parsed = HostTools.safeParse(value);
  return parsed.success ? parsed.data.map((tool) => tool.name) : [];
}

function registeredUriSchemes(value: unknown): string[] {
  const parsed = HostUriSchemes.safeParse(value);
  return parsed.success ? parsed.data.map((scheme) => scheme.scheme) : [];
}

interface FakeIdentity {
  readonly threadId: ThreadId;
  readonly sessionFile: SessionFilePath;
}

class FakeProcess implements OmpProcess {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly args: readonly string[];
  readonly processId: OmpProcessIdType = OmpProcessId.parse("process-a0-7");
  readonly writes: Record<string, unknown>[] = [];
  identity: FakeIdentity;
  nextIdentity: FakeIdentity | undefined;
  /** Extra fields the fake omp reports in `get_state` (for example `isStreaming: true`). */
  extraState: Record<string, unknown> = {};
  /** When set, `stop()` finishes only after this resolves, like a real omp flushing before exit. */
  stopGate: Promise<void> | undefined;
  /** When set, omp's answer to `set_host_tools` waits for this, like an omp that answers late. */
  holdHostTools: Promise<void> | undefined = undefined;
  /** When set, `stop()` leaves the session open: a write omp has not answered is still pending after the stop. */
  keepPendingOnStop = false;
  /** When set, `start()` fails with it, like an omp that cannot be spawned. */
  startFailure: AppFailure | undefined;
  /** The stderr omp printed before it stopped: the tail the server reads for why it stopped. */
  stderr = "";
  /** When set, the fake exits on its next request instead of answering it: an omp that dies after it started. */
  exitOnWrite = false;
  /** Set before the process starts: its ready frame waits for `sendReady()`, so the chat is still starting. */
  holdReady = false;
  #status: OmpProcessEvent["status"] = "starting";
  #eventListeners = new Set<(event: OmpProcessEvent) => void>();
  #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  #closeListeners = new Set<(cause?: unknown) => void>();

  constructor(options: OmpProcessOptions, identity: FakeIdentity) {
    this.threadId = options.threadId;
    this.folder = options.folder;
    this.args = options.args ?? [];
    this.identity = identity;
  }

  get status(): OmpProcessEvent["status"] {
    return this.#status;
  }

  get pid(): number | undefined {
    return 777;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  start(): Promise<void> {
    if (this.startFailure !== undefined) {
      // Like the real process: a start that fails leaves it in the error state.
      this.emitEvent({
        status: "error",
        processId: this.processId,
        error: this.startFailure.appError,
      });
      return Promise.reject(this.startFailure);
    }
    this.emitEvent({ status: "running", processId: this.processId });
    if (!this.holdReady) this.sendReady();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.stopGate;
    this.emitEvent({ status: "stopped", processId: this.processId });
    if (this.keepPendingOnStop) return;
    for (const listener of [...this.#closeListeners]) listener();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  writeLine(line: string): Promise<void> {
    if (this.exitOnWrite) {
      this.exitOnWrite = false;
      this.crash();
      return Promise.resolve();
    }
    const frame = JSON.parse(line) as Record<string, unknown>;
    this.writes.push(frame);
    const command = frame.type;
    const data =
      command === "negotiate_protocol"
        ? { protocolVersion: 2 }
        : command === "prompt" || command === "abort_and_prompt"
          ? { agentInvoked: true }
          : command === "set_subagent_subscription"
            ? { level: frame.level }
            : command === "set_event_filter"
              ? { events: frame.events, messageUpdates: frame.messageUpdates }
              : command === "set_host_tools"
                ? { toolNames: registeredToolNames(frame.tools) }
                : command === "set_host_uri_schemes"
                  ? { schemes: registeredUriSchemes(frame.schemes) }
                  : command === "branch"
                    ? { text: "", cancelled: false }
                    : command === "get_state"
                      ? {
                          sessionId: this.identity.threadId,
                          sessionFile: this.identity.sessionFile,
                          ...this.extraState,
                        }
                      : {};
    const response = { type: "response", id: frame.id, command, success: true, data };
    if (command === "set_host_tools" && this.holdHostTools !== undefined) {
      void this.holdHostTools.then(() => this.emit(response));
    } else {
      this.emit(response);
    }
    if (command === "branch" && this.nextIdentity !== undefined) this.identity = this.nextIdentity;
    if (command === "set_session_name" && this.nextIdentity !== undefined) {
      this.identity = this.nextIdentity;
    }
    if (command === "prompt" || command === "abort_and_prompt") {
      this.emit({
        type: "prompt_result",
        id: frame.id,
        agentInvoked: true,
        status: "completed",
        sessionSettled: false,
      });
      this.emit({ type: "session_settled" });
    }
    return Promise.resolve();
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    return () => this.#chunkListeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onEvent(listener: (event: OmpProcessEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  emit(frame: Record<string, unknown>): void {
    const bytes = encoder.encode(`${JSON.stringify(frame)}\n`);
    for (const listener of [...this.#chunkListeners]) listener(bytes);
  }

  emitRequest(frame: Record<string, unknown>): void {
    this.emit(frame);
  }

  crash(): void {
    const error = new AppFailure({ code: "omp_exited", message: "omp exited", retryable: true });
    this.emitEvent({ status: "exited", processId: this.processId, error: error.appError });
    for (const listener of [...this.#closeListeners]) listener(error);
  }

  /** Sends omp's ready frame: a process that held it back (`holdReady`) finishes its start from here. */
  sendReady(): void {
    this.emit({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864,
    });
  }

  private emitEvent(event: OmpProcessEvent): void {
    this.#status = event.status;
    for (const listener of [...this.#eventListeners]) listener(event);
  }
}

function context(
  created: FakeProcess[],
  identity: FakeIdentity = { threadId: authorityThread, sessionFile: authorityFile },
): A0PortContext {
  return {
    processRegistry: new OmpProcessRegistry({
      createProcess: (options: OmpProcessOptions) => {
        const process = new FakeProcess(options, identity);
        created.push(process);
        return process;
      },
    }),
    replay: new EventReplayHub(),
    capabilities: {},
    resolveThread: async (threadId) => ({
      ...bootstrap,
      threadId,
      args: ["--resume", authorityFile],
    }),
    externalOmp: async () => "none",
    latestThread: async () => undefined,
    sessionFileExists: async () => true,
    serverInfo: {
      instanceId: "instance-a0-7",
      serverVersion: "test",
      launchFolder: FolderPath.parse("/workspace"),
      omp: null,
    },
    health: { status: "ok" },
  };
}
type HandlerSet = Readonly<
  Record<string, (args: unknown, context: ServerPortHandlerContext) => unknown>
>;

function handlersFor(context: A0PortContext, index: number): HandlerSet {
  const registration = createA0PortRegistrations(context)[index];
  if (registration === undefined) throw new Error(`missing registration ${index}`);
  return registration.handlers as HandlerSet;
}

function getHandler(
  handlers: HandlerSet,
  name: string,
): (args: unknown, context: ServerPortHandlerContext) => unknown {
  const handler = handlers[name];
  if (handler === undefined) throw new Error(`missing handler ${name}`);
  return handler;
}
function payloadKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
  return typeof value.kind === "string" ? value.kind : undefined;
}
/** The process status a `process` event carries, or undefined for any other payload. */
function processStatus(value: unknown): string | undefined {
  if (payloadKind(value) !== "process") return undefined;
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined;
  return typeof value.status === "string" ? value.status : undefined;
}

/** The sequence of the replayed event that carries a request; the test fails when no replayed event does. */
function seqOfRequest(
  frames: readonly { readonly seq: number; readonly payload: unknown }[],
  requestId: string,
): number {
  const frame = frames.find((item) => JSON.stringify(item.payload).includes(`"id":"${requestId}"`));
  if (frame === undefined) throw new Error(`no replayed event carries ${requestId}`);
  return frame.seq;
}
function call(connectionId: string): ServerPortHandlerContext {
  return {
    signal: new AbortController().signal,
    connectionId,
    requestId: RequestId.parse(`call-${connectionId}`),
    portContext: undefined,
  };
}

/** The A0 registrations over a process registry that stops unwatched chats after `idleCloseMs`. */
function withIdleClose(created: FakeProcess[], idleCloseMs: number) {
  const processRegistry = new OmpProcessRegistry({
    idleCloseMs,
    createProcess: (options: OmpProcessOptions) => {
      const process = new FakeProcess(options, {
        threadId: authorityThread,
        sessionFile: authorityFile,
      });
      created.push(process);
      return process;
    },
  });
  const registration = createA0PortRegistrations({ ...context(created), processRegistry })[0];
  if (registration === undefined) throw new Error("missing registration");
  const handlers = registration.handlers as HandlerSet;
  return { processRegistry, registration, open: getHandler(handlers, "open"), handlers };
}

/** The A0 runtime and its handlers over a process registry that stops unwatched chats after `idleCloseMs`. */
function runtimeWithIdleClose(created: FakeProcess[], idleCloseMs: number) {
  const processRegistry = new OmpProcessRegistry({
    idleCloseMs,
    createProcess: (options: OmpProcessOptions) => {
      const process = new FakeProcess(options, {
        threadId: authorityThread,
        sessionFile: authorityFile,
      });
      created.push(process);
      return process;
    },
  });
  const runtime = createA0Runtime({ ...context(created), processRegistry });
  const registration = runtime.registrations[0];
  if (registration === undefined) throw new Error("missing registration");
  return { processRegistry, runtime, handlers: registration.handlers as HandlerSet };
}

/** A process registry whose fake processes are kept in `created`; `configure` sets each one before it starts. */
function registryKeeping(
  created: FakeProcess[],
  configure: (process: FakeProcess) => void = () => undefined,
): OmpProcessRegistry {
  return new OmpProcessRegistry({
    createProcess: (options: OmpProcessOptions) => {
      const process = new FakeProcess(options, {
        threadId: authorityThread,
        sessionFile: authorityFile,
      });
      configure(process);
      created.push(process);
      return process;
    },
  });
}

/** Counts the viewer holds a process registry lets go of: each close releases one. */
function countReleases(processRegistry: OmpProcessRegistry): { count: number } {
  const releases = { count: 0 };
  const release = processRegistry.release.bind(processRegistry);
  processRegistry.release = (threadId) => {
    releases.count += 1;
    release(threadId);
  };
  return releases;
}

/** A timer whose timeouts run only when the test calls `fireAll()`; `pending()` counts the timeouts not yet run. */
function firingTimer() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    setTimeout: (handler: () => void): number => {
      nextHandle += 1;
      callbacks.set(nextHandle, handler);
      return nextHandle;
    },
    clearTimeout: (handle: unknown): void => {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    fireAll: (): void => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    pending: (): number => callbacks.size,
  };
}

describe("A0.7 RpcSessionPort handlers", () => {
  test("opens, sends at admission, and publishes prompt completion/settled events with replay", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    const first = (await getHandler(handlers, "open")(
      { folderPath: folder, start: "new" },
      call("one"),
    )) as {
      threadId: ThreadId;
      sessionFile: string;
    };
    expect(first.threadId).toBe(authorityThread);
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    expect(process.args).toEqual([]);
    const result = await getHandler(handlers, "send")(
      { threadId: first.threadId, command: { type: "prompt", message: "hello" } },
      call("one"),
    );
    expect(result).toEqual({ agentInvoked: true });
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: first.threadId },
      call("one"),
    )) as { stream: StreamKey };
    const replay = runtimeContext.replay;
    const all = replay.replay(stream.stream, 0);
    const afterFirst = replay.replay(stream.stream, 1);
    if ("error" in all || "error" in afterFirst) throw new Error("unexpected replay conflict");
    expect(afterFirst.frames.length).toBeLessThan(all.frames.length);
    expect(afterFirst.frames[0]?.seq).toBeGreaterThan(1);
    expect(stream.stream).toContain(first.threadId);
    expect(replay.latestSeq(stream.stream)).toBeGreaterThan(0);
    expect(payloadKind(all.frames[0]?.payload)).toBe("process");
  });

  test("a chat is busy from agent_start until omp reports it settled, and a yielded run does not end it", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const busy = () => runtimeContext.processRegistry.busyOf(authorityThread);
    expect(busy()).toBe(false);

    process.emit({ type: "agent_start" });
    expect(busy()).toBe(true);
    // The run yielded, but a queued message or background job can still wake the session: the chat stays busy.
    process.emit({ type: "agent_end", messages: [] });
    expect(busy()).toBe(true);
    process.emit({ type: "session_settled" });
    expect(busy()).toBe(false);

    process.emit({ type: "agent_start" });
    process.emit({
      type: "prompt_result",
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    });
    expect(busy()).toBe(false);
    await runtimeContext.processRegistry.closeAll();
  });

  test("uses --continue for latest and --resume for an existing omp ThreadId", async () => {
    const latestCreated: FakeProcess[] = [];
    const latestHandlers = handlersFor(context(latestCreated), 0);
    await getHandler(latestHandlers, "open")(
      { folderPath: folder, start: "latest" },
      call("latest"),
    );
    expect(latestCreated[0]?.args).toEqual(["--continue"]);

    const resumeCreated: FakeProcess[] = [];
    const resumeHandlers = handlersFor(context(resumeCreated), 0);
    await getHandler(resumeHandlers, "open")({ threadId: authorityThread }, call("resume"));
    expect(resumeCreated[0]?.args).toEqual(["--resume", authorityFile]);
  });

  test("opening a chat with a model the person picked passes it to omp as --model", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")(
      { threadId: authorityThread, model: { provider: "fake", modelId: "fake-model" } },
      call("picked"),
    );
    expect(created[0]?.args).toEqual(["--resume", authorityFile, "--model", "fake/fake-model"]);
  });

  test("omp that stops at start because a saved model is gone fails the open as model_unavailable, in plain words", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = new OmpProcessRegistry({
      createProcess: (options: OmpProcessOptions) => {
        const process = new FakeProcess(options, {
          threadId: authorityThread,
          sessionFile: authorityFile,
        });
        process.startFailure = new AppFailure({
          code: "omp_exited",
          message: "omp exited (exit code 1): at async Rg (/$bunfs/root/omp-linux-x64:636241:19)",
          retryable: true,
        });
        process.stderr = [
          `636980 |       throw new Error(\`Could not restore model \${Ct[0]}\`);`,
          "                     ^",
          "error: Could not restore model fake/gone-model",
          "      at a8u (/$bunfs/root/omp-linux-x64:636980:13)",
          "",
        ].join("\n");
        created.push(process);
        return process;
      },
    });
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    let failure: unknown;
    try {
      await getHandler(handlers, "open")({ threadId: authorityThread }, call("saved"));
    } catch (error: unknown) {
      failure = error;
    }
    if (!(failure instanceof AppFailure)) throw new Error("expected an AppFailure");
    expect(failure.appError).toEqual({
      code: "model_unavailable",
      message:
        "This chat used fake/gone-model, which is not available any more. Pick another model to open it.",
      retryable: false,
    });
  });

  test("a chat whose omp exits as it opens opens again with a fresh omp, not the exited one", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = new OmpProcessRegistry({
      createProcess: (options: OmpProcessOptions) => {
        const process = new FakeProcess(options, {
          threadId: authorityThread,
          sessionFile: authorityFile,
        });
        // The first omp starts, then exits on its first request, as one that dies while the chat opens does. The
        // retry must start a new omp; it must not reuse the one that exited.
        if (created.length === 0) {
          process.exitOnWrite = true;
          process.stderr = "error: Could not restore model fake/gone-model\n";
        }
        created.push(process);
        return process;
      },
    });
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    await expect(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("saved")),
    ).rejects.toMatchObject({ appError: { code: "model_unavailable" } });

    await getHandler(handlers, "open")(
      { threadId: authorityThread, model: { provider: "fake", modelId: "fake-model" } },
      call("saved"),
    );

    expect(created).toHaveLength(2);
    expect(created[1]?.args).toEqual(["--resume", authorityFile, "--model", "fake/fake-model"]);
  });

  test("a chat opened with a model the person picked starts omp with that model again after a crash", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")(
      { threadId: authorityThread, model: { provider: "fake", modelId: "fake-model" } },
      call("picked"),
    );
    const crashed = created[0];
    if (crashed === undefined) throw new Error("missing fake process");
    crashed.crash();
    await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "prompt", message: "after the crash" } },
      call("picked"),
    );
    const revived = created[1];
    if (revived === undefined) throw new Error("omp was not started again");
    expect(revived.args).toEqual(["--resume", authorityFile, "--model", "fake/fake-model"]);
  });

  test("a second connection that asks for the newest chat is refused in plain words, and the first viewer keeps its process", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));

    await expect(
      getHandler(handlers, "open")({ folderPath: folder, start: "latest" }, call("two")),
    ).rejects.toMatchObject({
      appError: { code: "conflict", message: "This chat is open in another tab or window." },
    });
    expect(runtimeContext.processRegistry.get(authorityThread)).toBe(created[0]);
  });

  test("a refused open of the newest chat starts no second omp, so nothing is written to the chat", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      latestThread: async () => ({ threadId: authorityThread, sessionFile: authorityFile }),
    };
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));

    await expect(
      getHandler(handlers, "open")({ folderPath: folder, start: "latest" }, call("two")),
    ).rejects.toMatchObject({
      appError: { code: "conflict", message: "This chat is open in another tab or window." },
    });
    expect(created).toHaveLength(1);
    expect(runtimeContext.processRegistry.get(authorityThread)).toBe(created[0]);
  });

  test("a latest open whose newest chat nobody holds still starts omp with --continue", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      latestThread: async () => ({ threadId: authorityThread, sessionFile: authorityFile }),
    };
    const handlers = handlersFor(runtimeContext, 0);

    await getHandler(handlers, "open")({ folderPath: folder, start: "latest" }, call("one"));
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual(["--continue"]);
  });

  test("rejects a mismatched omp identity and releases the provisional process", async () => {
    const created: FakeProcess[] = [];
    const mismatch = {
      threadId: ThreadId.parse("omp-other-session"),
      sessionFile: authorityFile,
    };
    const handlers = handlersFor(context(created, mismatch), 0);

    await expect(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("mismatch")),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(created[0]?.status).toBe("stopped");
  });

  test("reports an unknown resume id as not_found before spawning", async () => {
    const created: FakeProcess[] = [];
    const unknownContext = {
      ...context(created),
      resolveThread: async () => undefined,
    };
    const handlers = handlersFor(unknownContext, 0);

    await expect(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("unknown")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    expect(created).toHaveLength(0);
  });

  test("rekeys after branch: the new id opens the same process", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const switchedThread = ThreadId.parse("omp-session-branched");
    const switchedFile = SessionFilePath.parse("/workspace/a0-7/.omp/branched.jsonl");
    process.nextIdentity = { threadId: switchedThread, sessionFile: switchedFile };

    await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "branch", entryId: "entry-1" } },
      call("one"),
    );
    const reopened = (await getHandler(handlers, "open")(
      { threadId: switchedThread },
      call("two"),
    )) as { threadId: ThreadId; sessionFile: string };

    expect(reopened.threadId).toBe(switchedThread);
    expect(reopened.sessionFile).toBe(switchedFile);
    expect(created[0]).toBe(process);
    process.emit({
      type: "prompt_result",
      id: "later",
      agentInvoked: true,
      status: "completed",
      sessionSettled: false,
    });
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: switchedThread },
      call("two"),
    )) as { stream: StreamKey };
    expect(runtimeContext.replay.latestSeq(stream.stream)).toBeGreaterThan(0);
  });

  test("after a branch the old thread opens a fresh process on its original file, and the moved process keeps running", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const moved = created[0];
    if (moved === undefined) throw new Error("missing fake process");
    const switchedThread = ThreadId.parse("omp-session-branched");
    const switchedFile = SessionFilePath.parse("/workspace/a0-7/.omp/branched.jsonl");
    moved.nextIdentity = { threadId: switchedThread, sessionFile: switchedFile };
    await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "branch", entryId: "entry-1" } },
      call("one"),
    );

    // The old id is no longer an alias for the branch: it resumes the original session file.
    const original = (await getHandler(handlers, "open")(
      { threadId: authorityThread },
      call("two"),
    )) as { threadId: ThreadId; sessionFile: string };
    expect(original).toMatchObject({ threadId: authorityThread, sessionFile: authorityFile });
    expect(created).toHaveLength(2);
    expect(created[1]?.identity).toEqual({ threadId: authorityThread, sessionFile: authorityFile });

    // The branch keeps its own process, which nothing stopped; it still answers under its new id.
    expect(moved.status).toBe("running");
    const branch = (await getHandler(handlers, "open")(
      { threadId: switchedThread },
      call("two"),
    )) as { threadId: ThreadId; sessionFile: string };
    expect(branch).toMatchObject({ threadId: switchedThread, sessionFile: switchedFile });
    expect(created).toHaveLength(2);
    expect(
      await getHandler(handlers, "send")(
        { threadId: switchedThread, command: { type: "get_state" } },
        call("two"),
      ),
    ).toMatchObject({ sessionId: switchedThread });
  });

  test("a moved chat tells the browsers still on the old thread, and its events go on in the new stream", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const moved = created[0];
    if (moved === undefined) throw new Error("missing fake process");
    const switchedThread = ThreadId.parse("omp-session-branched");
    moved.nextIdentity = {
      threadId: switchedThread,
      sessionFile: SessionFilePath.parse("/workspace/a0-7/.omp/branched.jsonl"),
    };
    const { replay } = runtimeContext;
    const oldStream = rpcSessionEventStream(authorityThread);
    const newStream = rpcSessionEventStream(switchedThread);
    const heard: unknown[] = [];
    const unsubscribe = replay.subscribe(oldStream, (frame) => {
      heard.push(frame.payload);
    });
    const beforeMove = replay.latestSeq(oldStream);

    await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "branch", entryId: "entry-1" } },
      call("one"),
    );
    expect(heard).toEqual([
      { kind: "notification", frame: { type: "session_info_update", sessionId: switchedThread } },
    ]);
    expect(replay.latestSeq(oldStream)).toBe(0);
    expect(replay.latestSeq(newStream)).toBe(beforeMove + 1);

    // The moved process's next event continues the new stream's numbering, not the old one's.
    moved.emit({
      type: "prompt_result",
      id: "later",
      agentInvoked: true,
      status: "completed",
      sessionSettled: false,
    });
    expect(replay.latestSeq(newStream)).toBe(beforeMove + 2);
    expect(heard).toHaveLength(1);

    // Opening the old thread starts a new run on the old stream, which never replays the moved notice.
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    expect(JSON.stringify(replay.replay(oldStream, 0))).not.toContain(switchedThread);
    expect(moved.status).toBe("running");
    unsubscribe();
  });

  test("two viewers arbitrate the most detailed subagent subscription and recompute after close", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "progress" },
      call("one"),
    );
    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "events" },
      call("two"),
    );
    await getHandler(handlers, "close")({ threadId: authorityThread }, call("two"));

    const commands = created[0]?.writes.filter(
      (frame) => frame.type === "set_subagent_subscription",
    );
    expect(commands?.map((frame) => frame.level)).toEqual(["progress", "events", "progress"]);
  });
  test("closing a chat whose omp is still starting resolves, and releases its viewer once", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = registryKeeping(created, (process) => {
      process.holdReady = true;
    });
    const releases = countReleases(processRegistry);
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    const opening = getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    for (let turn = 0; turn < 100 && created[0]?.status !== "running"; turn += 1) {
      await Bun.sleep(0);
    }

    await expect(
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    ).resolves.toBeNull();
    expect(releases.count).toBe(1);

    created[0]?.sendReady();
    await opening;
  });

  test("closing a chat whose omp crashed resolves, and releases its viewer once", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = registryKeeping(created);
    const releases = countReleases(processRegistry);
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    created[0]?.crash();

    await expect(
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    ).resolves.toBeNull();
    expect(releases.count).toBe(1);
  });

  test("closing a tuned chat whose omp crashed resolves, and releases its viewer once", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = registryKeeping(created);
    const releases = countReleases(processRegistry);
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "progress" },
      call("one"),
    );
    created[0]?.crash();

    await expect(
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    ).resolves.toBeNull();
    expect(releases.count).toBe(1);
  });

  test("closing the last view of a ready chat sends omp no subscription or filter change", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    const sentBefore = created[0]?.writes.length ?? 0;

    await getHandler(handlers, "close")({ threadId: authorityThread }, call("one"));

    const changes = (created[0]?.writes ?? [])
      .slice(sentBefore)
      .filter(
        (frame) => frame.type === "set_subagent_subscription" || frame.type === "set_event_filter",
      );
    expect(changes).toEqual([]);
  });

  test("merges host registrations by connection and restores them after restart", async () => {
    const created: FakeProcess[] = [];
    const { processRegistry, registration, open, handlers } = withIdleClose(created, 1_000);
    await open({ folderPath: folder, start: "new" }, call("one"));
    await open({ threadId: authorityThread }, call("two"));
    const send = getHandler(handlers, "send");
    const firstTool = {
      name: "tab_one",
      label: "tab_one",
      description: "First tab tool",
      parameters: { type: "object" },
    };
    const secondTool = {
      name: "tab_two",
      label: "tab_two",
      description: "Second tab tool",
      parameters: { type: "object" },
    };
    const firstScheme = { scheme: "tabone", writable: false };
    const secondScheme = { scheme: "tabtwo", writable: false };

    await expect(
      send(
        {
          threadId: authorityThread,
          registrationOwner: "owner-one",
          command: { type: "set_host_tools", tools: [firstTool] },
        },
        call("one"),
      ),
    ).resolves.toEqual({ toolNames: ["tab_one"] });
    await expect(
      send(
        {
          threadId: authorityThread,
          registrationOwner: "owner-two",
          command: { type: "set_host_tools", tools: [secondTool] },
        },
        call("two"),
      ),
    ).resolves.toEqual({ toolNames: ["tab_two"] });
    await send(
      {
        threadId: authorityThread,
        registrationOwner: "owner-one",
        command: { type: "set_host_uri_schemes", schemes: [firstScheme] },
      },
      call("one"),
    );
    await send(
      {
        threadId: authorityThread,
        registrationOwner: "owner-two",
        command: { type: "set_host_uri_schemes", schemes: [secondScheme] },
      },
      call("two"),
    );

    await getHandler(handlers, "restart")({ threadId: authorityThread }, call("one"));
    let process = created.at(-1);
    if (process === undefined) throw new Error("missing fake process");
    const restartedTools = process.writes.filter((frame) => frame.type === "set_host_tools").at(-1);
    const restartedSchemes = process.writes
      .filter((frame) => frame.type === "set_host_uri_schemes")
      .at(-1);
    expect(restartedTools?.tools).toEqual([firstTool, secondTool]);
    expect(restartedSchemes?.schemes).toEqual([firstScheme, secondScheme]);

    await getHandler(handlers, "close")({ threadId: authorityThread }, call("one"));
    process = created.at(-1);
    if (process === undefined) throw new Error("missing fake process");
    const remainingTools = process.writes.filter((frame) => frame.type === "set_host_tools").at(-1);
    const remainingSchemes = process.writes
      .filter((frame) => frame.type === "set_host_uri_schemes")
      .at(-1);
    expect(remainingTools?.tools).toEqual([secondTool]);
    expect(remainingSchemes?.schemes).toEqual([secondScheme]);

    await registration.onConnectionClosed?.("two");
    const clearedTools = process.writes.filter((frame) => frame.type === "set_host_tools").at(-1);
    const clearedSchemes = process.writes
      .filter((frame) => frame.type === "set_host_uri_schemes")
      .at(-1);
    expect(clearedTools?.tools).toEqual([]);
    expect(clearedSchemes?.schemes).toEqual([]);
    await processRegistry.closeAll();
  });

  test("releaseViews lets go of one connection's views and its host tools, and keeps the other connection's", async () => {
    const created: FakeProcess[] = [];
    const { processRegistry, runtime, handlers } = runtimeWithIdleClose(created, 1_000);
    const open = getHandler(handlers, "open");
    const send = getHandler(handlers, "send");
    await open({ threadId: authorityThread }, call("one"));
    await open({ threadId: authorityThread }, call("two"));
    await open({ threadId: authorityThread }, call("one"));
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(2);
    expect(runtime.views.viewsOf(authorityThread, "two")).toBe(1);
    expect(runtime.views.viewsOf(ThreadId.parse("never-opened"), "one")).toBe(0);
    expect(processRegistry.watcherCount(authorityThread)).toBe(3);

    const oneTool = {
      name: "tab_one",
      label: "tab_one",
      description: "First tab tool",
      parameters: { type: "object" },
    };
    const twoTool = {
      name: "tab_two",
      label: "tab_two",
      description: "Second tab tool",
      parameters: { type: "object" },
    };
    await send(
      {
        threadId: authorityThread,
        registrationOwner: "owner-one",
        command: { type: "set_host_tools", tools: [oneTool] },
      },
      call("one"),
    );
    await send(
      {
        threadId: authorityThread,
        registrationOwner: "owner-two",
        command: { type: "set_host_tools", tools: [twoTool] },
      },
      call("two"),
    );

    await runtime.views.releaseViews(authorityThread, "one");
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);
    expect(runtime.views.viewsOf(authorityThread, "two")).toBe(1);
    expect(processRegistry.watcherCount(authorityThread)).toBe(1);
    expect(created[0]?.status).toBe("running");
    const tools = created[0]?.writes.filter((frame) => frame.type === "set_host_tools").at(-1);
    expect(tools?.tools).toEqual([twoTool]);

    // A connection with no view of the chat has nothing to let go: nothing changes.
    await runtime.views.releaseViews(authorityThread, "one");
    expect(processRegistry.watcherCount(authorityThread)).toBe(1);
    await processRegistry.closeAll();
  });

  test("refuses host registrations from a connection that never opened the thread", async () => {
    const created: FakeProcess[] = [];
    const { processRegistry, open, handlers } = withIdleClose(created, 1_000);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const send = getHandler(handlers, "send");
    const stranger = {
      name: "tab_stranger",
      label: "tab_stranger",
      description: "Never released",
      parameters: { type: "object" },
    };
    await expect(
      send(
        {
          threadId: authorityThread,
          registrationOwner: "owner-two",
          command: { type: "set_host_tools", tools: [stranger] },
        },
        call("two"),
      ),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    await expect(
      send(
        {
          threadId: authorityThread,
          registrationOwner: "owner-two",
          command: {
            type: "set_host_uri_schemes",
            schemes: [{ scheme: "tabtwo", writable: false }],
          },
        },
        call("two"),
      ),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    const registrations =
      created[0]?.writes.filter(
        (frame) => frame.type === "set_host_tools" || frame.type === "set_host_uri_schemes",
      ) ?? [];
    expect(registrations).toHaveLength(0);
    await processRegistry.closeAll();
  });

  test("the ask-dialog opt-in lasts for one omp process: a restart tells the new omp again, and a chat that never opted in is not told", async () => {
    const created: FakeProcess[] = [];
    const { processRegistry, open, handlers } = withIdleClose(created, 1_000);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const send = getHandler(handlers, "send");
    const restart = getHandler(handlers, "restart");
    const optIns = (process: FakeProcess | undefined) =>
      process?.writes
        .filter((frame) => frame.type === "set_ask_dialog")
        .map((frame) => frame.enabled) ?? [];

    // A chat nobody opted in: its restarted omp is told nothing about rich ask questions.
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([]);

    await expect(
      send(
        { threadId: authorityThread, command: { type: "set_ask_dialog", enabled: true } },
        call("one"),
      ),
    ).resolves.toEqual({});
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([true]);
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([true]);

    await send(
      { threadId: authorityThread, command: { type: "set_ask_dialog", enabled: false } },
      call("one"),
    );
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([]);
    await processRegistry.closeAll();
  });

  test("a closed connection releases every chat it opened, and the process stops once nobody watches it", async () => {
    const created: FakeProcess[] = [];
    const { processRegistry, registration, open } = withIdleClose(created, 25);
    await open({ folderPath: folder, start: "new" }, call("one"));
    // The same tab opened the chat again (a reload that never said goodbye) and another tab watches it.
    await open({ threadId: authorityThread }, call("one"));
    await open({ threadId: authorityThread }, call("two"));

    await registration.onConnectionClosed?.("one");
    await Bun.sleep(80);
    expect(processRegistry.has(authorityThread)).toBe(true);
    expect(created[0]?.status).not.toBe("stopped");

    await registration.onConnectionClosed?.("two");
    await Bun.sleep(80);
    expect(processRegistry.has(authorityThread)).toBe(false);
    expect(created[0]?.status).toBe("stopped");

    // A connection that never opened anything, or closes twice, changes nothing.
    await registration.onConnectionClosed?.("two");
    await registration.onConnectionClosed?.("never-opened");
  });

  test("an unwatched chat keeps its process while omp is still working, is stopped once settled, and opens again on a fresh process", async () => {
    const created: FakeProcess[] = [];
    const { processRegistry, registration, open, handlers } = withIdleClose(created, 20);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("no process was started");
    first.extraState = { isStreaming: true };

    await registration.onConnectionClosed?.("one");
    await Bun.sleep(120);
    // Six idle periods passed and omp kept answering "streaming": the turn was never cut off.
    expect(processRegistry.has(authorityThread)).toBe(true);
    expect(first.status).not.toBe("stopped");

    first.extraState = { isStreaming: false, hasPendingAsyncWork: true };
    await Bun.sleep(80);
    // Background work that can still wake the session counts as working too.
    expect(first.status).not.toBe("stopped");

    first.extraState = {};
    await Bun.sleep(80);
    expect(first.status).toBe("stopped");
    expect(processRegistry.has(authorityThread)).toBe(false);

    // The chat opens again on a new process, and commands reach that one, not the stopped one.
    const writesToFirst = first.writes.length;
    await open({ threadId: authorityThread }, call("two"));
    expect(created).toHaveLength(2);
    await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "prompt", message: "hello again" } },
      call("two"),
    );
    expect(created[1]?.writes.some((frame) => frame.type === "prompt")).toBe(true);
    expect(first.writes).toHaveLength(writesToFirst);
  });

  test("opening a chat again while its old process is still exiting waits for it, so two omp never share a session file", async () => {
    const created: FakeProcess[] = [];
    const { registration, open } = withIdleClose(created, 20);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("no process was started");
    const exit = Promise.withResolvers<void>();
    first.stopGate = exit.promise;

    await registration.onConnectionClosed?.("one");
    await Bun.sleep(80);
    const reopened = open({ threadId: authorityThread }, call("two"));
    await Bun.sleep(60);
    expect(created).toHaveLength(1);

    exit.resolve();
    await reopened;
    expect(created).toHaveLength(2);
    expect(first.status).toBe("stopped");
  });

  test("opening a chat whose old omp does not stop in time is refused, and the open does not wait for ever", async () => {
    const created: FakeProcess[] = [];
    const timer = firingTimer();
    const processRegistry = new OmpProcessRegistry({
      timer,
      idleCloseMs: 20,
      createProcess: (options: OmpProcessOptions) => {
        const process = new FakeProcess(options, {
          threadId: authorityThread,
          sessionFile: authorityFile,
        });
        // The old omp never finishes stopping.
        process.stopGate = new Promise<void>(() => undefined);
        created.push(process);
        return process;
      },
    });
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await getHandler(handlers, "close")({ threadId: authorityThread }, call("one"));
    // The idle close asks omp whether it has settled, then starts the stop, which does not finish.
    timer.fireAll();
    for (let turn = 0; turn < 50; turn += 1) await Bun.sleep(0);

    const reopened = Promise.resolve(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("two")),
    );
    const rejected = reopened.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    // The open waits for the stop only up to its limit, and the limit is then refused.
    for (let turn = 0; turn < 100 && timer.pending() === 0; turn += 1) await Bun.sleep(0);
    timer.fireAll();
    expect(await rejected).toMatchObject({
      appError: {
        code: "conflict",
        message: "omp did not stop, so this chat was not opened. Try again in a moment.",
      },
    });
    expect(created).toHaveLength(1);
  });

  test("a stop that fails while this tab still watches its chat keeps the chat open for that tab", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    process.stop = () => Promise.reject(new Error("omp could not be signalled"));

    // A delete from this tab stops the chat's omp, counting this tab's own view as its own. The stop fails.
    await expect(
      ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
      },
    });
    // The chat is still open for this tab: its entry and its view are kept, so its next message reaches omp.
    expect(runtime.sessionFor(authorityThread)).toBeDefined();
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(ctx.processRegistry.watcherCount(authorityThread)).toBe(1);
  });

  test("a stop takes the chat's views with omp, and while omp is stopping the views are still counted for another tab", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;

    const stopping = ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(authorityThread); turn += 1) {
      await Bun.sleep(0);
    }
    // omp is stopping: its entry has left the registry, but its views still count, so another tab is refused.
    expect(ctx.processRegistry.isStopping(authorityThread)).toBe(true);
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(runtime.views.watcherCount(authorityThread)).toBe(1);

    gate.resolve();
    await stopping;
    // omp has exited: the views on its chat went with it.
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);
    expect(runtime.views.watcherCount(authorityThread)).toBe(0);
    expect(runtime.sessionFor(authorityThread)).toBeUndefined();
  });

  test("a stop reaches no viewer and no replay: the stream's latest sequence does not move while omp exits", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: authorityThread },
      call("one"),
    )) as { stream: StreamKey };
    const before = ctx.replay.latestSeq(stream.stream);

    await ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);

    expect(created[0]?.status).toBe("stopped");
    expect(ctx.replay.latestSeq(stream.stream)).toBe(before);
  });

  test("a send to a chat whose omp is stopping is refused as no open thread, and writes nothing to omp", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;
    const stopping = ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(authorityThread); turn += 1) {
      await Bun.sleep(0);
    }
    const writes = process.writes.length;

    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "too late" } },
        call("one"),
      ),
    ).rejects.toMatchObject({
      appError: { code: "not_found", message: `No open thread ${authorityThread}` },
    });
    expect(process.writes.length).toBe(writes);

    gate.resolve();
    await stopping;
  });

  test("a send to a chat another omp holds, with no omp here, is refused with the sentence and starts no omp", async () => {
    const created: FakeProcess[] = [];
    const runtime = createA0Runtime({ ...context(created), externalOmp: async () => "running" });
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "hello" } },
        call("tab"),
      ),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message:
          "Another omp has this chat open, so nothing was sent. Close that omp, then reload this page.",
        retryable: true,
      },
    });
    expect(created).toHaveLength(0);
  });

  test("a send to a chat nobody holds, with no omp here, is still refused as no open thread, and starts no omp", async () => {
    const created: FakeProcess[] = [];
    const runtime = createA0Runtime(context(created));
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "hello" } },
        call("tab"),
      ),
    ).rejects.toMatchObject({
      appError: { code: "not_found", message: `No open thread ${authorityThread}` },
    });
    expect(created).toHaveLength(0);
  });

  test("a tab that closes its chat while omp stops is not kept as a watcher when that stop fails", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const gate = Promise.withResolvers<void>();
    process.stop = () =>
      gate.promise.then(() => Promise.reject(new Error("omp could not be signalled")));

    // A delete from this tab starts the stop. While omp stops, this tab moves on and closes the chat.
    const deleting = ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(authorityThread); turn += 1) {
      await Bun.sleep(0);
    }
    await expect(
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    ).resolves.toBeNull();
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);

    // The stop then fails. The chat is not registered again with a watcher that has closed it.
    gate.resolve();
    await expect(deleting).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
      },
    });
    expect(ctx.processRegistry.has(authorityThread)).toBe(false);
    expect(ctx.processRegistry.watcherCount(authorityThread)).toBe(0);
  });

  test("a chat whose omp is stopping has no session for the command path, and a rename waits for omp to exit", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const gate = Promise.withResolvers<void>();
    process.stop = () =>
      gate.promise.then(() => Promise.reject(new Error("omp could not be signalled")));

    const deleting = ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(authorityThread); turn += 1) {
      await Bun.sleep(0);
    }
    expect(runtime.sessionFor(authorityThread)).toBeUndefined();

    // A rename sent while omp stops waits for the stop to end, and writes nothing into the stopping omp.
    const renamed = Promise.resolve(
      getHandler(handlers, "rename")(
        { threadId: authorityThread, name: "during the stop" },
        call("one"),
      ),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(0);
    expect(process.writes.some((frame) => frame.type === "set_session_name")).toBe(false);

    gate.resolve();
    await expect(deleting).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(await renamed).toMatchObject({ appError: { code: "conflict" } });
  });

  /**
   * Tab one holds a host tool, and lets its view go while omp stops: omp's exit ends the stop before omp answers the
   * host write that takes the tool back. Tab two opens the chat meanwhile. Returns tab two's watcher count when it
   * opens, and after omp's late answer; a release that comes after the stop must not reach tab two's watcher.
   */
  async function lateHostAnswerAfterStop(
    letGo: (runtime: ReturnType<typeof createA0Runtime>, handlers: HandlerSet) => unknown,
  ): Promise<{ readonly opened: number; readonly answered: number }> {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    await getHandler(handlers, "send")(
      {
        threadId: authorityThread,
        registrationOwner: "owner-one",
        command: {
          type: "set_host_tools",
          tools: [
            {
              name: "tab_one",
              label: "tab_one",
              description: "Tab one tool",
              parameters: { type: "object" },
            },
          ],
        },
      },
      call("one"),
    );
    const stopGate = Promise.withResolvers<void>();
    const hostAnswer = Promise.withResolvers<void>();
    process.stopGate = stopGate.promise;
    process.keepPendingOnStop = true;
    process.holdHostTools = hostAnswer.promise;

    // Tab one's delete stops omp, counting its own view as its own. The stop waits at its gate.
    const stopping = ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(authorityThread); turn += 1) {
      await Bun.sleep(0);
    }
    expect(ctx.processRegistry.isStopping(authorityThread)).toBe(true);
    // Tab one lets go while the stop runs. Its host write to omp is not answered yet.
    const letting = Promise.resolve(letGo(runtime, handlers));
    for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(0);
    // omp exits, and tab two opens the chat.
    stopGate.resolve();
    await stopping;
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    const opened = ctx.processRegistry.watcherCount(authorityThread);
    // omp answers tab one's host write only now, after the stop has ended.
    hostAnswer.resolve();
    await letting;
    return { opened, answered: ctx.processRegistry.watcherCount(authorityThread) };
  }

  test("a close during a stop lets its view go before omp answers its host write, so the next tab keeps its watcher", async () => {
    const result = await lateHostAnswerAfterStop((_runtime, handlers) =>
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    );
    expect(result).toEqual({ opened: 1, answered: 1 });
  });

  test("a connection that closes during a stop lets its views go before omp answers, so the next tab keeps its watcher", async () => {
    const result = await lateHostAnswerAfterStop(async (runtime) => {
      await runtime.registrations[0]?.onConnectionClosed?.("one");
    });
    expect(result).toEqual({ opened: 1, answered: 1 });
  });

  test("releaseViews during a stop lets its views go before omp answers, so the next tab keeps its watcher", async () => {
    const result = await lateHostAnswerAfterStop((runtime) =>
      runtime.views.releaseViews(authorityThread, "one"),
    );
    expect(result).toEqual({ opened: 1, answered: 1 });
  });

  test("a rename sent with a switched chat's old id waits for that chat's stopping omp, and writes to neither omp", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const switchedThread = ThreadId.parse("omp-session-switched-rename");
    process.nextIdentity = {
      threadId: switchedThread,
      sessionFile: SessionFilePath.parse("/workspace/a0-7/.omp/switched-rename.jsonl"),
    };
    await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "branch", entryId: "entry-1" } },
      call("one"),
    );
    // The switched chat is keyed by its new id, and the old id leads to it.
    const gate = Promise.withResolvers<void>();
    process.stop = () =>
      gate.promise.then(() => Promise.reject(new Error("omp could not be signalled")));
    const deleting = ctx.processRegistry.stopIfUnwatched(switchedThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(switchedThread); turn += 1) {
      await Bun.sleep(0);
    }
    expect(ctx.processRegistry.isStopping(switchedThread)).toBe(true);

    // A rename sent with the old id, while that chat's omp stops.
    const renamed = Promise.resolve(
      getHandler(handlers, "rename")(
        { threadId: authorityThread, name: "during the stop" },
        call("one"),
      ),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(0);
    expect(process.writes.some((frame) => frame.type === "set_session_name")).toBe(false);

    gate.resolve();
    await expect(deleting).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(await renamed).toMatchObject({ appError: { code: "conflict" } });
    // Neither omp was asked to set the name, and no omp was started for the file the old id names.
    expect(process.writes.some((frame) => frame.type === "set_session_name")).toBe(false);
    expect(created).toHaveLength(1);
  });

  test("closing a chat with no open entry resolves to null, and lets go of nothing", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await expect(
      getHandler(handlers, "close")({ threadId: ThreadId.parse("chat-never-opened") }, call("one")),
    ).resolves.toBeNull();
    expect(ctx.processRegistry.watcherCount(authorityThread)).toBe(1);
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(created).toHaveLength(1);
  });

  test("restoreViews gives a connection back its view on the omp another tab started, once each, and starts no omp for a chat nothing serves", async () => {
    const created: FakeProcess[] = [];
    const ctx = context(created);
    const runtime = createA0Runtime(ctx);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the rpc registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;

    // Tab one's delete stops omp, counting its own view as its own. The stop waits at its gate.
    const deleting = ctx.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    for (let turn = 0; turn < 100 && !ctx.processRegistry.isStopping(authorityThread); turn += 1) {
      await Bun.sleep(0);
    }
    // Tab two opens the chat while omp stops: the omp it starts after the stop serves the chat.
    const second = getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    gate.resolve();
    await deleting;
    await second;
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);
    expect(runtime.views.watcherCount(authorityThread)).toBe(1);

    // The refused delete gives tab one its view back on that omp, once: a second call adds nothing.
    runtime.views.restoreViews(authorityThread, "one", 1);
    runtime.views.restoreViews(authorityThread, "one", 1);
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(runtime.views.watcherCount(authorityThread)).toBe(2);
    expect(created).toHaveLength(2);

    // A chat no running omp serves gets nothing, and no omp is started for it.
    runtime.views.restoreViews(ThreadId.parse("chat-nothing-serves"), "one", 1);
    expect(created).toHaveLength(2);
  });

  test("routes UI/host answers and exposes a process crash as a replayed process event", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    process.emitRequest({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "?",
      message: "?",
    });
    await getHandler(handlers, "answerExtensionUi")(
      {
        threadId: authorityThread,
        response: {
          type: "extension_ui_response",
          id: UiRequestId.parse("ui-1"),
          confirmed: true,
        },
      },
      call("one"),
    );
    process.emitRequest({
      type: "host_tool_call",
      id: "host-1",
      toolCallId: "tool-1",
      toolName: "echo",
      arguments: {},
    });
    await getHandler(handlers, "answerHostTool")(
      {
        threadId: authorityThread,
        response: {
          type: "host_tool_result",
          id: HostCallId.parse("host-1"),
          result: { content: [] },
        },
      },
      call("one"),
    );
    process.crash();
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: authorityThread },
      call("one"),
    )) as { stream: StreamKey };
    const replay = runtimeContext.replay.replay(stream.stream, 0);
    if ("error" in replay) throw new Error("unexpected replay conflict");
    expect(process.writes).toContainEqual({
      type: "extension_ui_response",
      id: "ui-1",
      confirmed: true,
    });
    expect(process.writes).toContainEqual({
      type: "host_tool_result",
      id: "host-1",
      result: { content: [] },
    });
    expect(replay.frames.some((frame) => payloadKind(frame.payload) === "process")).toBe(true);
  });

  test("keeps the questions omp waits on until each is answered or cancelled, each with the sequence that asked it", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const openQuestions = () =>
      getHandler(handlers, "openQuestions")({ threadId: authorityThread }, call("one")) as Array<{
        seq: number;
        request: { id: string };
      }>;
    process.emitRequest({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Go on?",
      message: "",
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "note-1",
      method: "notify",
      message: "heads up",
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "ui-2",
      method: "input",
      title: "Name?",
    });
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: authorityThread },
      call("one"),
    )) as { stream: StreamKey };
    const replay = runtimeContext.replay.replay(stream.stream, 0);
    if ("error" in replay) throw new Error("unexpected replay conflict");
    const open = openQuestions();
    expect(open.map((question) => question.request.id)).toEqual(["ui-1", "ui-2"]);
    expect(open.map((question) => question.seq)).toEqual([
      seqOfRequest(replay.frames, "ui-1"),
      seqOfRequest(replay.frames, "ui-2"),
    ]);
    await getHandler(handlers, "answerExtensionUi")(
      {
        threadId: authorityThread,
        response: {
          type: "extension_ui_response",
          id: UiRequestId.parse("ui-1"),
          confirmed: true,
        },
      },
      call("one"),
    );
    expect(openQuestions().map((question) => question.request.id)).toEqual(["ui-2"]);
    process.emitRequest({
      type: "extension_ui_request",
      id: "cancel-2",
      method: "cancel",
      targetId: "ui-2",
    });
    expect(openQuestions()).toEqual([]);
  });

  test("a question omp was waiting on is not open once omp has exited", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    process.emitRequest({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Go on?",
      message: "",
    });
    const openQuestions = getHandler(handlers, "openQuestions");
    expect(openQuestions({ threadId: authorityThread }, call("one"))).toHaveLength(1);
    process.crash();
    expect(openQuestions({ threadId: authorityThread }, call("one"))).toEqual([]);
  });

  test("keeps the status, widget and title omp last set until each is replaced or cleared, and a restart drops them", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake process");
    const stateFrames = () =>
      getHandler(handlers, "stateFrames")({ threadId: authorityThread }, call("one")) as Array<{
        seq: number;
        request: { id: string };
      }>;
    process.emitRequest({
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "build",
      statusText: "Running",
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "build",
      widgetLines: ["Building"],
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "status-2",
      method: "setStatus",
      statusKey: "build",
      statusText: "Done",
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "status-lint",
      method: "setStatus",
      statusKey: "lint",
      statusText: "Clean",
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "title-1",
      method: "setTitle",
      title: "Build status",
    });
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: authorityThread },
      call("one"),
    )) as { stream: StreamKey };
    const replay = runtimeContext.replay.replay(stream.stream, 0);
    if ("error" in replay) throw new Error("unexpected replay conflict");
    // Each key holds its latest frame, with the sequence that set it, oldest first.
    expect(stateFrames().map((frame) => frame.request.id)).toEqual([
      "widget-1",
      "status-2",
      "status-lint",
      "title-1",
    ]);
    expect(stateFrames().map((frame) => frame.seq)).toEqual([
      seqOfRequest(replay.frames, "widget-1"),
      seqOfRequest(replay.frames, "status-2"),
      seqOfRequest(replay.frames, "status-lint"),
      seqOfRequest(replay.frames, "title-1"),
    ]);
    // A status or a widget sent with no text or lines clears what it names.
    process.emitRequest({
      type: "extension_ui_request",
      id: "status-clear",
      method: "setStatus",
      statusKey: "build",
    });
    process.emitRequest({
      type: "extension_ui_request",
      id: "widget-clear",
      method: "setWidget",
      widgetKey: "build",
    });
    expect(stateFrames().map((frame) => frame.request.id)).toEqual(["status-lint", "title-1"]);
    // A later title replaces the earlier one: the title key holds only the latest.
    process.emitRequest({
      type: "extension_ui_request",
      id: "title-2",
      method: "setTitle",
      title: "Build done",
    });
    expect(stateFrames().map((frame) => frame.request.id)).toEqual(["status-lint", "title-2"]);
    await getHandler(handlers, "restart")({ threadId: authorityThread }, call("one"));
    expect(stateFrames()).toEqual([]);
  });

  test("a restart drops the questions of the omp it replaces, since the new omp cannot answer them", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("missing fake process");
    first.emitRequest({
      type: "extension_ui_request",
      id: "ui-9",
      method: "confirm",
      title: "Go on?",
      message: "",
    });
    expect(
      getHandler(handlers, "openQuestions")({ threadId: authorityThread }, call("one")),
    ).toHaveLength(1);
    await getHandler(handlers, "restart")({ threadId: authorityThread }, call("one"));
    expect(created).toHaveLength(2);
    expect(
      getHandler(handlers, "openQuestions")({ threadId: authorityThread }, call("one")),
    ).toEqual([]);
  });

  test("a command sent after omp crashed starts omp again on the same chat and tells it what the old one had been told", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "progress" },
      call("one"),
    );
    const crashed = created[0];
    if (crashed === undefined) throw new Error("missing fake process");
    crashed.crash();

    const result = await getHandler(handlers, "send")(
      { threadId: authorityThread, command: { type: "prompt", message: "after the crash" } },
      call("one"),
    );

    expect(result).toEqual({ agentInvoked: true });
    expect(created).toHaveLength(2);
    const revived = created[1];
    if (revived === undefined) throw new Error("omp was not started again");
    expect(revived.args).toEqual(["--resume", authorityFile]);
    expect(revived.writes).toContainEqual(
      expect.objectContaining({ type: "prompt", message: "after the crash" }),
    );
    expect(
      revived.writes
        .filter((frame) => frame.type === "set_subagent_subscription")
        .map((f) => f.level),
    ).toEqual(["progress"]);
    // The chat stays one chat for the browsers watching it: its stream carries the new process.
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: authorityThread },
      call("one"),
    )) as { stream: StreamKey };
    const replay = runtimeContext.replay.replay(stream.stream, 0);
    if ("error" in replay) throw new Error("unexpected replay conflict");
    const statuses = replay.frames
      .map((frame) => processStatus(frame.payload))
      .filter((status) => status !== undefined);
    expect(statuses).toContain("exited");
    expect(statuses.at(-1)).toBe("ready");
  });

  test("two commands sent at once after a crash start omp only once", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await Promise.all([
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "first" } },
        call("one"),
      ),
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "get_state" } },
        call("one"),
      ),
    ]);

    expect(created).toHaveLength(2);
  });

  test("a rename sent after omp crashed starts omp again and renames the chat", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await getHandler(handlers, "rename")(
      { threadId: authorityThread, name: "Renamed after the crash" },
      call("one"),
    );

    expect(created).toHaveLength(2);
    expect(created[1]?.writes).toContainEqual(
      expect.objectContaining({ type: "set_session_name", name: "Renamed after the crash" }),
    );
  });

  test("a subagent subscription sent after omp crashed starts omp again and applies it", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "progress" },
      call("one"),
    );

    expect(created).toHaveLength(2);
    expect(created[1]?.writes).toContainEqual(
      expect.objectContaining({ type: "set_subagent_subscription", level: "progress" }),
    );
  });

  test("an event filter sent after omp crashed starts omp again", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await getHandler(handlers, "setEventFilter")(
      { threadId: authorityThread, events: null },
      call("one"),
    );

    expect(created).toHaveLength(2);
  });

  test("a chat whose omp stopped before the chat was saved is not started again and says why", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor({ ...context(created), sessionFileExists: async () => false }, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "hello again" } },
        call("one"),
      ),
    ).rejects.toMatchObject({
      appError: {
        code: "omp_exited",
        message: expect.stringContaining("before this chat was saved"),
      },
    });
    expect(created).toHaveLength(1);
  });

  test("a failed start leaves the chat able to try again on the next command", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = new OmpProcessRegistry({
      createProcess: (options: OmpProcessOptions) => {
        const process = new FakeProcess(options, {
          threadId: authorityThread,
          sessionFile: authorityFile,
        });
        // The process started for the first send after the crash cannot start; the next one can.
        if (created.length === 1) {
          process.startFailure = new AppFailure({
            code: "omp_exited",
            message: "omp could not start",
            retryable: true,
          });
        }
        created.push(process);
        return process;
      },
    });
    const handlers = handlersFor({ ...context(created), processRegistry }, 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "try" } },
        call("one"),
      ),
    ).rejects.toMatchObject({ appError: { message: "omp could not start" } });
    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "prompt", message: "try again" } },
        call("one"),
      ),
    ).resolves.toEqual({ agentInvoked: true });
    expect(created).toHaveLength(3);
  });

  test("a pre-aborted send rejects with AppFailure(cancelled)", async () => {
    const created: FakeProcess[] = [];
    const handlers = handlersFor(context(created), 0);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      getHandler(handlers, "send")(
        { threadId: authorityThread, command: { type: "get_state" } },
        { ...call("one"), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });

  test("an open whose connection closed while it waited adds no viewer and starts no omp", async () => {
    const created: FakeProcess[] = [];
    const processRegistry = new OmpProcessRegistry({
      createProcess: (options: OmpProcessOptions) => {
        const process = new FakeProcess(options, {
          threadId: authorityThread,
          sessionFile: authorityFile,
        });
        created.push(process);
        return process;
      },
    });
    // The chat's omp is still stopping, so the open waits for it to be gone.
    const stop = Promise.withResolvers<void>();
    processRegistry.whenGone = () => stop.promise;
    const registration = createA0PortRegistrations({ ...context(created), processRegistry })[0];
    if (registration === undefined) throw new Error("missing A0 registration");
    const handlers = registration.handlers as HandlerSet;
    const controller = new AbortController();
    const opened = getHandler(handlers, "open")(
      { threadId: authorityThread },
      { ...call("tab"), signal: controller.signal },
    );

    // The tab closes while the open waits: the dispatcher aborts the call, then releases the connection.
    controller.abort("connection_closed");
    await registration.onConnectionClosed?.("tab");
    stop.resolve();

    await expect(opened).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(created).toHaveLength(0);
    expect(processRegistry.has(authorityThread)).toBe(false);
  });
});

describe("A0.7 AppPort handlers", () => {
  test("returns server information, capabilities and health", async () => {
    const created: FakeProcess[] = [];
    const app = handlersFor(context(created), 1);
    expect(getHandler(app, "serverInfo")({}, call("app"))).toMatchObject({
      instanceId: "instance-a0-7",
    });
    expect(getHandler(app, "capabilities")({}, call("app"))).toEqual({});
    expect(getHandler(app, "health")({}, call("app"))).toEqual({ status: "ok" });
  });

  test("browser errors reach the debug log cut to size, and a page stuck in a loop cannot flood it", async () => {
    const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    const logger: Logger = {
      path: "/log/omp-app.log",
      info: (event, fields) => events.push({ level: "info", event, fields: { ...fields } }),
      warn: (event, fields) => events.push({ level: "warn", event, fields: { ...fields } }),
      error: (event, fields) => events.push({ level: "error", event, fields: { ...fields } }),
      addSecret: () => undefined,
      tail: () => "",
    };
    const created: FakeProcess[] = [];
    const app = handlersFor({ ...context(created), logger }, 1);
    const report = getHandler(app, "reportClientError");
    expect(
      report(
        {
          kind: "unhandledrejection",
          message: "x".repeat(1_500),
          stack: "s".repeat(4_000),
          page: "http://127.0.0.1:4317/",
        },
        call("app"),
      ),
    ).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("client.error");
    expect(String(events[0]?.fields.message).length).toBeLessThan(530);
    expect(String(events[0]?.fields.stack).length).toBeLessThan(2_030);
    expect(events[0]?.fields.kind).toBe("unhandledrejection");

    for (let index = 0; index < 100; index += 1) {
      report({ kind: "console", message: `loop ${index}` }, call("app"));
    }
    // 30 a minute at most (the first report counts): the rest are dropped.
    expect(events.filter((event) => event.event === "client.error")).toHaveLength(30);
  });

  test("the debug report comes from the composition's seam, and is unavailable without one", async () => {
    const created: FakeProcess[] = [];
    const without = handlersFor(context(created), 1);
    await expect(getHandler(without, "debugReport")({}, call("app"))).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    const withSeam = handlersFor(
      {
        ...context(created),
        debugReport: async () => ({ fileName: "omp-app-debug-x.log", text: "report text" }),
      },
      1,
    );
    expect(await getHandler(withSeam, "debugReport")({}, call("app"))).toEqual({
      fileName: "omp-app-debug-x.log",
      text: "report text",
    });
  });
});

describe("A0.rename: omp sets a chat's title, whether or not the chat is open", () => {
  test("an open chat is renamed by its own omp and stays open", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    await expect(
      getHandler(handlers, "rename")(
        { threadId: authorityThread, name: "Renamed open" },
        call("one"),
      ),
    ).resolves.toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]?.writes).toContainEqual(
      expect.objectContaining({ type: "set_session_name", name: "Renamed open" }),
    );
    expect(created[0]?.status).toBe("running");
  });

  test("a chat nobody has open is renamed by a short-lived omp that stops once the title is saved", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await expect(
      getHandler(handlers, "rename")(
        { threadId: authorityThread, name: "Closed rename" },
        call("one"),
      ),
    ).resolves.toBeNull();
    const host = created[0];
    expect(created).toHaveLength(1);
    expect(host?.args).toEqual(["--resume", authorityFile]);
    expect(host?.writes).toContainEqual(
      expect.objectContaining({ type: "set_session_name", name: "Closed rename" }),
    );
    expect(host?.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("a chat another viewer has open keeps its process when one viewer renames it", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext, 0);
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    await getHandler(handlers, "rename")(
      { threadId: authorityThread, name: "Shared" },
      call("one"),
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("running");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(true);
  });

  test("refuses to rename a chat another omp is writing: the check runs once the host is up, and nothing is written", async () => {
    const created: FakeProcess[] = [];
    const seen: { hosts: number; asked: string[] } = { hosts: 0, asked: [] };
    const runtimeContext: A0PortContext = {
      ...context(created),
      externalOmp: async (threadId, sessionFile, hostPid) => {
        seen.hosts = created.length;
        seen.asked.push(`${threadId} ${sessionFile} host ${hostPid}`);
        return "running";
      },
    };
    const handlers = handlersFor(runtimeContext, 0);
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Busy" }, call("one")),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message: expect.stringMatching(/Another omp is using this chat/),
      },
    });
    // The fake omp reports pid 777: the check must be told it, so the host is not taken for another omp.
    expect(seen).toEqual({
      hosts: 1,
      asked: [`${authorityThread} ${authorityFile} host 777`],
    });
    const host = created[0];
    expect(host?.writes.some((frame) => frame.type === "set_session_name")).toBe(false);
    expect(host?.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("refuses to rename a chat while the app can't tell whether another omp is writing it, and writes nothing", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      externalOmp: async () => "unknown",
    };
    const handlers = handlersFor(runtimeContext, 0);
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Unknown" }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    expect(created[0]?.writes.some((frame) => frame.type === "set_session_name")).toBe(false);
    expect(created[0]?.status).toBe("stopped");
  });

  test("a chat that does not exist cannot be renamed", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      resolveThread: async () => undefined,
    };
    const handlers = handlersFor(runtimeContext, 0);
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Gone" }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    expect(created).toHaveLength(0);
  });

  test("a rename omp saved to a copy of the chat is reported, and the copy's omp is stopped", async () => {
    const created: FakeProcess[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      processRegistry: new OmpProcessRegistry({
        createProcess: (options: OmpProcessOptions) => {
          const process = new FakeProcess(options, {
            threadId: authorityThread,
            sessionFile: authorityFile,
          });
          // omp writes to a copy when another live process holds the chat's file.
          process.nextIdentity = {
            threadId: ThreadId.parse("omp-copy-a0-7"),
            sessionFile: SessionFilePath.parse("/workspace/a0-7/.omp/copy-a0-7.jsonl"),
          };
          created.push(process);
          return process;
        },
      }),
    };
    const handlers = handlersFor(runtimeContext, 0);
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Copied" }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(created[0]?.writes).toContainEqual(
      expect.objectContaining({ type: "set_session_name", name: "Copied" }),
    );
    expect(created[0]?.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });
});

/**
 * The chat session runtime (`chat-session.ts`) over a fake chat host: opens, views, stops, crash recovery, host requests
 * and renames, case by case. The same cases ran against A0's RPC runtime until H5.6b deleted it; the real chat host runs
 * them end to end in `test/e2e/sdk-chat-session-*.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppFailure,
  chatSessionEventStream,
  FolderPath,
  OmpProcessId,
  type OmpProcessId as OmpProcessIdType,
  RequestId,
  SessionFilePath,
  type StreamKey,
  ThreadId,
  type UsageLimitsResult,
} from "@omp-app/contracts";
import { CHAT_HOST_METHODS } from "@omp-app/contracts/chat-host";
import {
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessOptions,
  OmpProcessRegistry,
} from "../../process";
import type { PortHandlerContext as ServerPortHandlerContext } from "../../registry/ports";
import { EventReplayHub } from "../../replay";
import { type A0PortContext, createA0Runtime, type ThreadBootstrap } from "./index";

const encoder = new TextEncoder();
const folder = FolderPath.parse("/workspace/a0-7");
const authorityThread = ThreadId.parse("omp-session-a0-7");
const authorityFile = SessionFilePath.parse("/workspace/a0-7/.omp/authoritative.jsonl");
const bootstrap: ThreadBootstrap = {
  threadId: authorityThread,
  folderPath: folder,
  sessionFile: authorityFile,
  args: [],
};

interface FakeIdentity {
  readonly threadId: ThreadId;
  readonly sessionFile: SessionFilePath;
}

interface FakeRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** The names a registration carries, as the host answers them. */
function namesOf(items: unknown, key: "name" | "scheme"): string[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) =>
    typeof item === "object" && item !== null && typeof item[key] === "string" ? [item[key]] : [],
  );
}

/** A chat host on our protocol: it says hello, answers the server's requests, sends events, and can crash. */
class FakeChatHost implements OmpProcess {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  readonly args: readonly string[];
  readonly processId: OmpProcessIdType = OmpProcessId.parse("process-a0-7");
  readonly requests: FakeRequest[] = [];
  /** The server's answers to the host's own requests (its dialogs and tool calls), in order. */
  readonly responses: Record<string, unknown>[] = [];
  identity: FakeIdentity;
  nextIdentity: FakeIdentity | undefined;
  /** Extra fields the fake reports in `get_state` (for example `messageCount: 4`). */
  extraState: Record<string, unknown> = {};
  /** When set, `stop()` finishes only after this resolves, like a host flushing before exit. */
  stopGate: Promise<void> | undefined;
  /** When set, the host's answer to `set_host_tools` waits for this, like a host that answers late. */
  holdHostTools: Promise<void> | undefined = undefined;
  /** When set, the host's answer to a `bash` request waits for this, like a command that runs for a while. */
  holdBash: Promise<void> | undefined = undefined;
  /** When set, the host refuses a `bash` request, like a host that stopped while the command ran. */
  failBash = false;
  /** When set, `stop()` leaves the process open: a request the host has not answered is still pending after the stop. */
  keepPendingOnStop = false;
  /** When set, `start()` fails with it, like a host that cannot be spawned. */
  startFailure: AppFailure | undefined;
  /** The stderr the host printed before it stopped: the tail the server reads for why it stopped. */
  stderr = "";
  /** When set, the fake exits on its next request instead of answering it: a host that dies after it started. */
  exitOnWrite = false;
  /** Set before the process starts: its hello waits for `sendHello()`, so the chat is still starting. */
  holdHello = false;
  /** Events the fake sends right after its hello: the conversation omp restored when its autoResume setting is on. */
  startupEvents: Record<string, unknown>[] = [];
  /** When set, the host refuses `new_session`, like an extension that cancels it. */
  cancelNewSession = false;
  #seq = 0;
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

  /** The methods the server asked, in order. */
  get methods(): string[] {
    return this.requests.map((request) => request.method);
  }

  start(): Promise<void> {
    if (this.startFailure !== undefined) {
      // Like the real process: a start that fails leaves it in the error state.
      this.emitStatus({
        status: "error",
        processId: this.processId,
        error: this.startFailure.appError,
      });
      return Promise.reject(this.startFailure);
    }
    this.emitStatus({ status: "running", processId: this.processId });
    if (!this.holdHello) this.sendHello();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.stopGate;
    this.emitStatus({ status: "stopped", processId: this.processId });
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
    const message = JSON.parse(line) as Record<string, unknown>;
    // The server's answers to the host's own requests are kept apart from its requests.
    if (message.kind === "response") this.responses.push(message);
    if (message.kind !== "request") return Promise.resolve();
    const request: FakeRequest = {
      id: String(message.id),
      method: String(message.method),
      params: (message.params ?? {}) as Record<string, unknown>,
    };
    this.requests.push(request);
    const respond = (): void => {
      if (request.method === "bash" && this.failBash) {
        this.send({
          kind: "response",
          id: request.id,
          ok: false,
          error: { code: "failed", message: "omp stopped the command" },
        });
        return;
      }
      this.send({ kind: "response", id: request.id, ok: true, result: this.resultOf(request) });
    };
    if (request.method === "set_host_tools" && this.holdHostTools !== undefined) {
      void this.holdHostTools.then(respond);
    } else if (request.method === "bash" && this.holdBash !== undefined) {
      void this.holdBash.then(respond);
    } else {
      respond();
    }
    // A fresh session has no messages, as omp reports it.
    if (request.method === "new_session" && !this.cancelNewSession) {
      this.extraState = { ...this.extraState, messageCount: 0 };
    }
    if (
      (request.method === "branch" || request.method === "set_session_name") &&
      this.nextIdentity !== undefined
    ) {
      this.identity = this.nextIdentity;
    }
    if (request.method === "prompt") {
      this.emitEvent({
        type: "prompt_result",
        requestId: request.id,
        agentInvoked: true,
        status: "completed",
        sessionSettled: false,
      });
      this.emitEvent({ type: "session_settled" });
    }
    return Promise.resolve();
  }

  resultOf(request: FakeRequest): unknown {
    switch (request.method) {
      case "prompt":
        return { resultFollows: true };
      case "get_state":
        return {
          sessionId: this.identity.threadId,
          sessionFile: this.identity.sessionFile,
          messageCount: 0,
          isStreaming: false,
          isSettled: true,
          ...this.extraState,
        };
      case "new_session":
        return { cancelled: this.cancelNewSession };
      case "branch":
        return { text: "", cancelled: false };
      case "set_subagent_subscription":
        return { level: request.params.level };
      case "set_event_options":
        return { messageUpdates: request.params.messageUpdates };
      case "set_host_tools":
        return { toolNames: namesOf(request.params.tools, "name") };
      case "set_host_uri_schemes":
        return { schemes: namesOf(request.params.schemes, "scheme") };
      case "bash":
        return { output: "hi\n", exitCode: 0, cancelled: false, truncated: false };
      default:
        return {};
    }
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

  /** Writes one line of the host's output. */
  send(line: Record<string, unknown>): void {
    const bytes = encoder.encode(`${JSON.stringify(line)}\n`);
    for (const listener of [...this.#chunkListeners]) listener(bytes);
  }

  /** One of omp's session events (or the app's own), as the host streams it. */
  emitEvent(event: Record<string, unknown>): void {
    this.#seq += 1;
    this.send({ kind: "event", seq: this.#seq, event });
  }

  /** A request of the host's own (a dialog, a tool call), which the server answers. */
  emitRequest(id: string, method: string, params: Record<string, unknown>): void {
    this.send({ kind: "request", id, method, params });
  }

  crash(): void {
    const error = new AppFailure({ code: "omp_exited", message: "omp exited", retryable: true });
    this.emitStatus({ status: "exited", processId: this.processId, error: error.appError });
    for (const listener of [...this.#closeListeners]) listener(error);
  }

  /** Sends the host's hello: a process that held it back (`holdHello`) finishes its start from here. */
  sendHello(): void {
    this.send({
      kind: "hello",
      protocol: 1,
      ompVersion: "18.12.6",
      methods: CHAT_HOST_METHODS,
      session: {
        id: this.identity.threadId,
        file: this.identity.sessionFile,
        cwd: this.folder,
      },
    });
    for (const event of this.startupEvents) this.emitEvent(event);
  }

  private emitStatus(event: OmpProcessEvent): void {
    this.#status = event.status;
    for (const listener of [...this.#eventListeners]) listener(event);
  }
}

/** What the fake host reports when it starts: the conversation it restored, if any. */
interface FakeStartup {
  readonly extraState?: Record<string, unknown>;
  readonly startupEvents?: readonly Record<string, unknown>[];
  readonly cancelNewSession?: boolean;
  readonly holdHello?: boolean;
  readonly onCreate?: (process: FakeChatHost) => void;
}

function fakeHost(
  created: FakeChatHost[],
  identity: FakeIdentity = { threadId: authorityThread, sessionFile: authorityFile },
  startup: FakeStartup = {},
): (options: OmpProcessOptions) => FakeChatHost {
  return (options) => {
    const process = new FakeChatHost(options, identity);
    process.extraState = { ...startup.extraState };
    process.startupEvents = [...(startup.startupEvents ?? [])];
    process.cancelNewSession = startup.cancelNewSession ?? false;
    process.holdHello = startup.holdHello ?? false;
    created.push(process);
    startup.onCreate?.(process);
    return process;
  };
}

function context(
  created: FakeChatHost[],
  identity: FakeIdentity = { threadId: authorityThread, sessionFile: authorityFile },
  startup: FakeStartup = {},
): A0PortContext {
  return {
    processRegistry: new OmpProcessRegistry({
      createProcess: fakeHost(created, identity, startup),
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

/**
 * A context whose stop limit runs out at once: a delete that waits on the host's stop is refused as omp not stopping in
 * time, and the stop goes on. Other timers never fire, so the idle close cannot run during a test.
 */
function contextStopLimitAtOnce(
  created: FakeChatHost[],
  overrides: Partial<A0PortContext> = {},
): A0PortContext {
  return {
    ...context(created),
    processRegistry: new OmpProcessRegistry({
      createProcess: fakeHost(created),
      timer: {
        setTimeout: (handler: () => void, delayMs: number) => {
          if (delayMs === 10 * 1000) handler();
          return 0;
        },
        clearTimeout: () => undefined,
      },
    }),
    ...overrides,
  };
}

type Handler = (args: unknown, context: ServerPortHandlerContext) => unknown;
type HandlerSet = Readonly<Record<string, Handler>>;

/** The chat session port's handlers over a context. */
function handlersFor(runtimeContext: A0PortContext): HandlerSet {
  const registration = createA0Runtime(runtimeContext).registrations[0];
  if (registration === undefined) throw new Error("missing registration");
  return registration.handlers as HandlerSet;
}

function getHandler(handlers: HandlerSet, name: string): Handler {
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

function call(
  connectionId: string,
  signal = new AbortController().signal,
): ServerPortHandlerContext {
  return {
    signal,
    connectionId,
    requestId: RequestId.parse(`call-${connectionId}`),
    portContext: undefined,
  };
}

/** A request to a chat by the method's name. */
function request(threadId: ThreadId, method: string, params: Record<string, unknown> = {}) {
  return { threadId, method, params };
}

/** Lets the runtime's promise chains run. */
async function ticks(count = 10): Promise<void> {
  for (let tick = 0; tick < count; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The payloads replayed on a chat's stream from the start. */
function replayed(runtimeContext: A0PortContext, threadId: ThreadId): unknown[] {
  const frames = runtimeContext.replay.replay(chatSessionEventStream(threadId), 0);
  if ("error" in frames) throw new Error("unexpected replay conflict");
  return frames.frames.map((frame) => frame.payload);
}

/** The A0 runtime over a process registry that stops unwatched chats after `idleCloseMs`. */
function runtimeWithIdleClose(created: FakeChatHost[], idleCloseMs: number) {
  const processRegistry = new OmpProcessRegistry({ idleCloseMs, createProcess: fakeHost(created) });
  const runtime = createA0Runtime({ ...context(created), processRegistry });
  const registration = runtime.registrations[0];
  if (registration === undefined) throw new Error("missing registration");
  const handlers = registration.handlers as HandlerSet;
  return { processRegistry, runtime, registration, handlers, open: getHandler(handlers, "open") };
}

/** The params of each request a host got for one method, in order. */
function paramsOf(process: FakeChatHost | undefined, method: string): Record<string, unknown>[] {
  return (process?.requests ?? [])
    .filter((item) => item.method === method)
    .map((item) => item.params);
}

const toolOne = {
  name: "tab_one",
  label: "tab_one",
  description: "First tab tool",
  parameters: { type: "object" },
};
const toolTwo = {
  name: "tab_two",
  label: "tab_two",
  description: "Second tab tool",
  parameters: { type: "object" },
};

/** A host tool or URI scheme registration of one owner. */
function registration(
  method: "set_host_tools" | "set_host_uri_schemes",
  owner: string,
  params: Record<string, unknown>,
) {
  return { ...request(authorityThread, method, params), registrationOwner: owner };
}

/** A process registry whose fake hosts are kept in `created`; `configure` sets each one before it starts. */
function registryKeeping(
  created: FakeChatHost[],
  configure: (process: FakeChatHost) => void = () => undefined,
): OmpProcessRegistry {
  return new OmpProcessRegistry({
    createProcess: (options: OmpProcessOptions) => {
      const process = new FakeChatHost(options, {
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

describe("the chat session runtime: opening a chat", () => {
  test("opens, answers a prompt, and publishes its result and the settle on the chat's stream, with replay", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    const opened = (await getHandler(handlers, "open")(
      { folderPath: folder, start: "new" },
      call("one"),
    )) as { threadId: ThreadId };
    expect(opened.threadId).toBe(authorityThread);
    const process = created[0];
    if (process === undefined) throw new Error("missing fake host");
    expect(process.args).toEqual([]);
    const result = await getHandler(handlers, "request")(
      request(opened.threadId, "prompt", { text: "hello" }),
      call("one"),
    );
    expect(result).toEqual({ resultFollows: true });
    const stream = (await getHandler(handlers, "subscribe")(
      { threadId: opened.threadId },
      call("one"),
    )) as { stream: StreamKey };
    const replay = runtimeContext.replay;
    const all = replay.replay(stream.stream, 0);
    const afterFirst = replay.replay(stream.stream, 1);
    if ("error" in all || "error" in afterFirst) throw new Error("unexpected replay conflict");
    expect(afterFirst.frames.length).toBeLessThan(all.frames.length);
    expect(afterFirst.frames[0]?.seq).toBeGreaterThan(1);
    expect(stream.stream).toContain(opened.threadId);
    expect(payloadKind(all.frames[0]?.payload)).toBe("process");
    const events = all.frames.flatMap((frame) =>
      payloadKind(frame.payload) === "event"
        ? [(frame.payload as { event: { type: string } }).event.type]
        : [],
    );
    expect(events).toEqual(["prompt_result", "session_settled"]);
  });

  test("an open of a chat the app already runs under another key is not refused, though its lease reads held", async () => {
    const created: FakeChatHost[] = [];
    const probed: string[] = [];
    let ownOmpRunning = false;
    const handlers = handlersFor({
      ...context(created),
      leaseProbe: async (sessionId) => {
        probed.push(sessionId);
        return ownOmpRunning ? "active" : "inactive";
      },
    });
    const open = getHandler(handlers, "open");
    await open({ threadId: authorityThread }, call("first"));
    // The app's own host runs this chat now, so its lease reads held. A second key for the same file is not another omp.
    ownOmpRunning = true;
    const otherThread = ThreadId.parse("omp-session-other");
    const outcome = await Promise.resolve(open({ threadId: otherThread }, call("second"))).then(
      () => undefined,
      (error: unknown) => error,
    );
    const message = outcome instanceof AppFailure ? outcome.appError.message : undefined;
    // The second open started its own host: the refusal did not stop it, and the lease was never asked about it.
    expect(created).toHaveLength(2);
    expect(message).not.toBe(
      "This chat is open in another omp, for example in a terminal. Close it there, then open it here.",
    );
    expect(probed).toEqual([authorityThread]);
  });

  test("a chat is busy from agent_start until the host reports it settled, and a yielded run does not end it", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake host");
    const busy = () => runtimeContext.processRegistry.busyOf(authorityThread);
    expect(busy()).toBe(false);

    process.emitEvent({ type: "agent_start" });
    expect(busy()).toBe(true);
    // The run yielded, but a queued message or background job can still wake the session: the chat stays busy.
    process.emitEvent({ type: "agent_end", messages: [] });
    expect(busy()).toBe(true);
    process.emitEvent({ type: "session_settled" });
    expect(busy()).toBe(false);

    process.emitEvent({ type: "agent_start" });
    process.emitEvent({
      type: "prompt_result",
      requestId: "1",
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    });
    expect(busy()).toBe(false);
    await runtimeContext.processRegistry.closeAll();
  });

  test("a chat's pause, as its host reports it, is kept by the registry for the chat list", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake host");
    const paused = () => runtimeContext.processRegistry.pausedIn(folder);
    expect(paused()).toEqual([]);

    process.emitEvent({ type: "pause_changed", pausedAt: 1_000 });
    expect(paused()).toEqual([{ id: authorityThread, pausedAt: 1_000 }]);
    process.emitEvent({ type: "pause_changed", pausedAt: null });
    expect(paused()).toEqual([]);
    await runtimeContext.processRegistry.closeAll();
  });

  describe("a `!` run in the chat's host", () => {
    /** Opens a chat, so the shell events it publishes can be read from its replay. */
    async function openChat() {
      const created: FakeChatHost[] = [];
      const runtimeContext = context(created);
      const handlers = handlersFor(runtimeContext);
      const opened = (await getHandler(handlers, "open")(
        { folderPath: folder, start: "new" },
        call("one"),
      )) as { threadId: ThreadId };
      const process = created[0];
      if (process === undefined) throw new Error("missing fake host");
      const shellEvents = (): unknown[] =>
        replayed(runtimeContext, opened.threadId).filter(
          (payload) => payloadKind(payload) === "shell",
        );
      const run = (command: string) =>
        getHandler(handlers, "request")(request(opened.threadId, "bash", { command }), call("one"));
      return { runtimeContext, threadId: opened.threadId, process, shellEvents, run };
    }

    test("is announced as running, then ended with the host's answer, to the chat's viewers, and the chat is not busy", async () => {
      const { runtimeContext, threadId, process, shellEvents, run } = await openChat();
      let finishCommand: () => void = () => undefined;
      process.holdBash = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      const command = "sleep 12; echo b1-late";
      const running = run(command);
      await ticks();
      expect(shellEvents()).toEqual([
        expect.objectContaining({
          kind: "shell",
          method: "bash",
          status: "running",
          input: command,
        }),
      ]);
      // A `!` run is not a turn: the chat stays not busy, so the turn's stop and queue choices do not change.
      expect(runtimeContext.processRegistry.busyOf(threadId)).toBe(false);

      finishCommand();
      await expect(running).resolves.toMatchObject({ output: "hi\n", exitCode: 0 });
      expect(shellEvents()).toEqual([
        expect.objectContaining({ status: "running", input: command }),
        expect.objectContaining({
          status: "ended",
          input: command,
          result: { output: "hi\n", exitCode: 0, cancelled: false, truncated: false },
        }),
      ]);
      await runtimeContext.processRegistry.closeAll();
    });

    test("a run that fails ends without a result, so no viewer shows output the host never gave", async () => {
      const { runtimeContext, process, shellEvents, run } = await openChat();
      process.failBash = true;
      await expect(run("sleep 1")).rejects.toMatchObject({ appError: { code: "omp_error" } });
      const events = shellEvents();
      expect(events).toEqual([
        expect.objectContaining({ status: "running", input: "sleep 1" }),
        expect.objectContaining({ status: "ended", input: "sleep 1" }),
      ]);
      expect(events[1]).not.toHaveProperty("result");
      await runtimeContext.processRegistry.closeAll();
    });
  });

  describe("New chat when omp restored the last conversation (autoResume)", () => {
    const open = (handlers: HandlerSet, start: "new" | "latest") =>
      getHandler(handlers, "open")({ folderPath: folder, start }, call("one"));
    const methodsOf = (process: FakeChatHost | undefined): string[] => {
      if (process === undefined) throw new Error("missing fake host");
      return process.methods;
    };
    const restored = { messageCount: 4 };
    const restoredEvent = { type: "session_settled" };

    test("asks the host for a fresh session and keeps the restored conversation off the stream", async () => {
      const created: FakeChatHost[] = [];
      const runtimeContext = context(created, undefined, {
        extraState: restored,
        startupEvents: [restoredEvent],
      });
      const handlers = handlersFor(runtimeContext);
      const opened = (await open(handlers, "new")) as { threadId: ThreadId };

      const methods = methodsOf(created[0]);
      const askedAt = methods.indexOf("new_session");
      expect(methods.filter((method) => method === "new_session")).toHaveLength(1);
      expect(methods.indexOf("get_state")).toBeLessThan(askedAt);
      expect(methods.slice(askedAt + 1)).toContain("get_state");
      expect(JSON.stringify(replayed(runtimeContext, opened.threadId))).not.toContain(
        "session_settled",
      );
      await runtimeContext.processRegistry.closeAll();
    });

    test("does not ask for a fresh session when the host opened an empty one", async () => {
      const created: FakeChatHost[] = [];
      const runtimeContext = context(created, undefined, {
        extraState: { messageCount: 0 },
        startupEvents: [restoredEvent],
      });
      const handlers = handlersFor(runtimeContext);
      const opened = (await open(handlers, "new")) as { threadId: ThreadId };

      expect(methodsOf(created[0])).not.toContain("new_session");
      expect(JSON.stringify(replayed(runtimeContext, opened.threadId))).toContain(
        "session_settled",
      );
      await runtimeContext.processRegistry.closeAll();
    });

    test("leaves the conversation alone when the person asked for the latest one", async () => {
      const created: FakeChatHost[] = [];
      const runtimeContext = context(created, undefined, { extraState: restored });
      const handlers = handlersFor(runtimeContext);
      await open(handlers, "latest");

      expect(methodsOf(created[0])).not.toContain("new_session");
      await runtimeContext.processRegistry.closeAll();
    });

    test("fails the open as cancelled when the host refuses the fresh session", async () => {
      const created: FakeChatHost[] = [];
      const runtimeContext = context(created, undefined, {
        extraState: restored,
        cancelNewSession: true,
      });
      const handlers = handlersFor(runtimeContext);

      await expect(open(handlers, "new")).rejects.toMatchObject({
        appError: { code: "cancelled", retryable: false },
      });
      await runtimeContext.processRegistry.closeAll();
    });
  });

  test("uses --continue for latest and --resume for an existing chat", async () => {
    const latestCreated: FakeChatHost[] = [];
    const latestHandlers = handlersFor(context(latestCreated));
    await getHandler(latestHandlers, "open")(
      { folderPath: folder, start: "latest" },
      call("latest"),
    );
    expect(latestCreated[0]?.args).toEqual(["--continue"]);

    const resumeCreated: FakeChatHost[] = [];
    const checkedFiles: SessionFilePath[] = [];
    const resumeHandlers = handlersFor({
      ...context(resumeCreated),
      sessionFileExists: async (sessionFile) => {
        checkedFiles.push(sessionFile);
        return true;
      },
    });
    await getHandler(resumeHandlers, "open")({ threadId: authorityThread }, call("resume"));
    expect(checkedFiles).toEqual([authorityFile]);
    expect(resumeCreated[0]?.args).toEqual(["--resume", authorityFile]);
  });

  test("opening a chat with a model the person picked passes it to omp as --model", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")(
      { threadId: authorityThread, model: { provider: "fake", modelId: "fake-model" } },
      call("picked"),
    );
    expect(created[0]?.args).toEqual(["--resume", authorityFile, "--model", "fake/fake-model"]);
  });

  test("a host that stops at start because a saved model is gone fails the open as model_unavailable, in plain words", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({
      ...context(created),
      processRegistry: registryKeeping(created, (process) => {
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
      }),
    });
    const failure = await Promise.resolve(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("saved")),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(failure instanceof AppFailure)) throw new Error("expected an AppFailure");
    expect(failure.appError).toEqual({
      code: "model_unavailable",
      message:
        "This chat used fake/gone-model, which is not available any more. Pick another model to open it.",
      retryable: false,
    });
  });

  test("a chat whose host exits as it opens opens again with a fresh host, not the exited one", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({
      ...context(created),
      processRegistry: registryKeeping(created, (process) => {
        // The first host starts, then exits on its first request, as one that dies while the chat opens does. The
        // retry must start a new host; it must not reuse the one that exited.
        if (created.length === 0) {
          process.exitOnWrite = true;
          process.stderr = "error: Could not restore model fake/gone-model\n";
        }
      }),
    });
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

  test("a chat opened with a model the person picked starts its host with that model again after a crash", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")(
      { threadId: authorityThread, model: { provider: "fake", modelId: "fake-model" } },
      call("picked"),
    );
    const crashed = created[0];
    if (crashed === undefined) throw new Error("missing fake host");
    crashed.crash();
    await getHandler(handlers, "request")(
      request(authorityThread, "prompt", { text: "after the crash" }),
      call("picked"),
    );
    const revived = created[1];
    if (revived === undefined) throw new Error("the host was not started again");
    expect(revived.args).toEqual(["--resume", authorityFile, "--model", "fake/fake-model"]);
  });

  test("a second connection that asks for the newest chat is refused in plain words, and the first viewer keeps its host", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));

    await expect(
      getHandler(handlers, "open")({ folderPath: folder, start: "latest" }, call("two")),
    ).rejects.toMatchObject({
      appError: { code: "conflict", message: expect.stringContaining("another tab or window") },
    });
    expect(runtimeContext.processRegistry.get(authorityThread)).toBe(created[0]);
  });

  test("a refused open of the newest chat starts no second host, so nothing is written to the chat", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      latestThread: async () => ({ threadId: authorityThread, sessionFile: authorityFile }),
    };
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));

    await expect(
      getHandler(handlers, "open")({ folderPath: folder, start: "latest" }, call("two")),
    ).rejects.toMatchObject({
      appError: { code: "conflict", message: expect.stringContaining("another tab or window") },
    });
    expect(created).toHaveLength(1);
    expect(runtimeContext.processRegistry.get(authorityThread)).toBe(created[0]);
  });

  test("a latest open whose newest chat nobody holds still starts its host with --continue", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({
      ...context(created),
      latestThread: async () => ({ threadId: authorityThread, sessionFile: authorityFile }),
    });

    await getHandler(handlers, "open")({ folderPath: folder, start: "latest" }, call("one"));
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual(["--continue"]);
  });

  test("refuses a host that opened another chat than the one asked for, and stops it", async () => {
    const created: FakeChatHost[] = [];
    const mismatch = { threadId: ThreadId.parse("omp-other-session"), sessionFile: authorityFile };
    const handlers = handlersFor(context(created, mismatch));

    await expect(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("mismatch")),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(created[0]?.status).toBe("stopped");
  });

  test("reports an unknown chat id as not_found before starting a host", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({ ...context(created), resolveThread: async () => undefined });

    await expect(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("unknown")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    expect(created).toHaveLength(0);
  });

  test("starts no host when the chat's session file is missing", async () => {
    const created: FakeChatHost[] = [];
    const missingFile = SessionFilePath.parse("/workspace/a0-7/.omp/deleted.jsonl");
    const missingContext: A0PortContext = {
      ...context(created),
      resolveThread: async (threadId) => ({ ...bootstrap, threadId, sessionFile: missingFile }),
      sessionFileExists: async (sessionFile) => sessionFile !== missingFile,
    };
    const handlers = handlersFor(missingContext);

    await expect(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("missing-file")),
    ).rejects.toMatchObject({
      appError: { code: "not_found", message: `Session file not found: ${missingFile}` },
    });
    expect(created).toHaveLength(0);
    expect(missingContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("two opens of one saved chat at the same moment start its host once", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));

    await Promise.all([
      getHandler(handlers, "open")({ threadId: authorityThread }, call("one")),
      getHandler(handlers, "open")({ threadId: authorityThread }, call("two")),
    ]);

    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual(["--resume", authorityFile]);
  });

  test("two opens at the same moment of a chat whose file is gone both fail and start no host", async () => {
    const created: FakeChatHost[] = [];
    const missingFile = SessionFilePath.parse("/workspace/a0-7/.omp/deleted-twice.jsonl");
    const missingContext: A0PortContext = {
      ...context(created),
      resolveThread: async (threadId) => ({ ...bootstrap, threadId, sessionFile: missingFile }),
      sessionFileExists: async () => false,
    };
    const handlers = handlersFor(missingContext);

    const settled = await Promise.allSettled([
      getHandler(handlers, "open")({ threadId: authorityThread }, call("one")),
      getHandler(handlers, "open")({ threadId: authorityThread }, call("two")),
    ]);

    expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(created).toHaveLength(0);
    expect(missingContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("an open cancelled while its session file is being checked starts no host", async () => {
    const created: FakeChatHost[] = [];
    const check = Promise.withResolvers<boolean>();
    const slowContext: A0PortContext = {
      ...context(created),
      sessionFileExists: () => check.promise,
    };
    const handlers = handlersFor(slowContext);
    const controller = new AbortController();
    const opened = getHandler(handlers, "open")(
      { threadId: authorityThread },
      call("tab", controller.signal),
    );

    controller.abort("connection_closed");
    check.resolve(true);

    await expect(opened).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(created).toHaveLength(0);
    expect(slowContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("an open cancelled after its host started stops that host, when no other view watches it", async () => {
    const created: FakeChatHost[] = [];
    const spawned = Promise.withResolvers<FakeChatHost>();
    const runtimeContext = context(created, undefined, {
      holdHello: true,
      onCreate: (process) => spawned.resolve(process),
    });
    const handlers = handlersFor(runtimeContext);
    const controller = new AbortController();
    const opened = getHandler(handlers, "open")(
      { threadId: authorityThread },
      call("tab", controller.signal),
    );
    // The host is spawned and has not said hello yet: a pick supersedes this open while it starts.
    const host = await spawned.promise;
    controller.abort("superseded");
    host.sendHello();

    await expect(opened).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(host.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("an open cancelled after its host started leaves the host running for another view that opened the chat meanwhile", async () => {
    const created: FakeChatHost[] = [];
    const spawned = Promise.withResolvers<FakeChatHost>();
    const runtimeContext = context(created, undefined, {
      holdHello: true,
      onCreate: (process) => spawned.resolve(process),
    });
    const handlers = handlersFor(runtimeContext);
    const controller = new AbortController();
    const opened = getHandler(handlers, "open")(
      { threadId: authorityThread },
      call("tab", controller.signal),
    );
    const host = await spawned.promise;
    // Another tab opens the same chat while the host starts: it is a second view of that host.
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("other"));
    controller.abort("superseded");
    host.sendHello();

    await expect(opened).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(host.status).not.toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(true);
  });

  test("moves with a branch: the new id opens the same host", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake host");
    const switchedThread = ThreadId.parse("omp-session-branched");
    const switchedFile = SessionFilePath.parse("/workspace/a0-7/.omp/branched.jsonl");
    process.nextIdentity = { threadId: switchedThread, sessionFile: switchedFile };

    await getHandler(handlers, "request")(
      request(authorityThread, "branch", { entryId: "entry-1" }),
      call("one"),
    );
    const reopened = (await getHandler(handlers, "open")(
      { threadId: switchedThread },
      call("two"),
    )) as { threadId: ThreadId; sessionFile: string };

    expect(reopened.threadId).toBe(switchedThread);
    expect(reopened.sessionFile).toBe(switchedFile);
    expect(created).toEqual([process]);
    process.emitEvent({ type: "agent_start" });
    expect(runtimeContext.replay.latestSeq(chatSessionEventStream(switchedThread))).toBeGreaterThan(
      0,
    );
  });

  test("after a branch the old id opens a fresh host on its original file, and the moved host keeps running", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const moved = created[0];
    if (moved === undefined) throw new Error("missing fake host");
    const switchedThread = ThreadId.parse("omp-session-branched");
    const switchedFile = SessionFilePath.parse("/workspace/a0-7/.omp/branched.jsonl");
    moved.nextIdentity = { threadId: switchedThread, sessionFile: switchedFile };
    await getHandler(handlers, "request")(
      request(authorityThread, "branch", { entryId: "entry-1" }),
      call("one"),
    );

    // Opening the old id resumes the original session file, whose chat is still on disk beside the branch.
    const original = (await getHandler(handlers, "open")(
      { threadId: authorityThread },
      call("two"),
    )) as { threadId: ThreadId; sessionFile: string };
    expect(original).toMatchObject({ threadId: authorityThread, sessionFile: authorityFile });
    expect(created).toHaveLength(2);
    expect(created[1]?.identity).toEqual({ threadId: authorityThread, sessionFile: authorityFile });

    // The branch keeps its own host, which nothing stopped; it still answers under its new id.
    expect(moved.status).toBe("running");
    const branch = (await getHandler(handlers, "open")(
      { threadId: switchedThread },
      call("two"),
    )) as { threadId: ThreadId; sessionFile: string };
    expect(branch).toMatchObject({ threadId: switchedThread, sessionFile: switchedFile });
    expect(created).toHaveLength(2);
    expect(
      await getHandler(handlers, "request")(request(switchedThread, "get_state"), call("two")),
    ).toMatchObject({ sessionId: switchedThread });
  });

  test("a moved chat tells the viewers still on the old id, and its events go on in the new stream", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const moved = created[0];
    if (moved === undefined) throw new Error("missing fake host");
    const switchedThread = ThreadId.parse("omp-session-branched");
    const switchedFile = SessionFilePath.parse("/workspace/a0-7/.omp/branched.jsonl");
    moved.nextIdentity = { threadId: switchedThread, sessionFile: switchedFile };
    const { replay } = runtimeContext;
    const oldStream = chatSessionEventStream(authorityThread);
    const newStream = chatSessionEventStream(switchedThread);
    const heard: unknown[] = [];
    const unsubscribe = replay.subscribe(oldStream, (frame) => {
      heard.push(frame.payload);
    });
    const beforeMove = replay.latestSeq(oldStream);

    await getHandler(handlers, "request")(
      request(authorityThread, "branch", { entryId: "entry-1" }),
      call("one"),
    );
    expect(heard).toEqual([{ kind: "moved", threadId: switchedThread, sessionFile: switchedFile }]);
    expect(replay.latestSeq(oldStream)).toBe(0);
    expect(replay.latestSeq(newStream)).toBe(beforeMove + 1);

    // The moved host's next event continues the new stream's numbering, not the old one's.
    moved.emitEvent({ type: "agent_start" });
    expect(replay.latestSeq(newStream)).toBe(beforeMove + 2);
    expect(heard).toHaveLength(1);

    // Opening the old id starts a new run on the old stream, which never replays the move.
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    expect(JSON.stringify(replay.replay(oldStream, 0))).not.toContain(switchedThread);
    expect(moved.status).toBe("running");
    unsubscribe();
  });
});

describe("the chat session runtime: viewers and closes", () => {
  test("two viewers arbitrate the most detailed subagent subscription, and it is worked out again after a close", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
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

    expect(paramsOf(created[0], "set_subagent_subscription").map((params) => params.level)).toEqual(
      ["progress", "events", "progress"],
    );
  });

  test("closing a chat whose host is still starting resolves, and releases its viewer once", async () => {
    const created: FakeChatHost[] = [];
    const processRegistry = registryKeeping(created, (process) => {
      process.holdHello = true;
    });
    const releases = countReleases(processRegistry);
    const handlers = handlersFor({ ...context(created), processRegistry });
    const opening = Promise.resolve(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("one")),
    ).catch(() => undefined);
    for (let turn = 0; turn < 100 && created[0]?.status !== "running"; turn += 1) {
      await Bun.sleep(0);
    }

    await expect(
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    ).resolves.toBeNull();
    expect(releases.count).toBe(1);

    created[0]?.sendHello();
    await opening;
  });

  test("closing a chat whose host crashed resolves, and releases its viewer once", async () => {
    const created: FakeChatHost[] = [];
    const processRegistry = registryKeeping(created);
    const releases = countReleases(processRegistry);
    const handlers = handlersFor({ ...context(created), processRegistry });
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    created[0]?.crash();

    await expect(
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    ).resolves.toBeNull();
    expect(releases.count).toBe(1);
  });

  test("closing a tuned chat whose host crashed resolves, and releases its viewer once", async () => {
    const created: FakeChatHost[] = [];
    const processRegistry = registryKeeping(created);
    const releases = countReleases(processRegistry);
    const handlers = handlersFor({ ...context(created), processRegistry });
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

  test("closing the last view of a ready chat sends its host no subscription or message-update change", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    const sentBefore = created[0]?.requests.length ?? 0;

    await getHandler(handlers, "close")({ threadId: authorityThread }, call("one"));

    const changes = (created[0]?.requests ?? [])
      .slice(sentBefore)
      .filter(
        (item) =>
          item.method === "set_subagent_subscription" || item.method === "set_event_options",
      );
    expect(changes).toEqual([]);
  });

  test("merges host registrations by connection, and gives them to the restarted host", async () => {
    const created: FakeChatHost[] = [];
    const {
      processRegistry,
      registration: chatPort,
      open,
      handlers,
    } = runtimeWithIdleClose(created, 1_000);
    await open({ folderPath: folder, start: "new" }, call("one"));
    await open({ threadId: authorityThread }, call("two"));
    const send = getHandler(handlers, "request");
    const schemeOne = { scheme: "tabone", writable: false };
    const schemeTwo = { scheme: "tabtwo", writable: false };

    await expect(
      send(registration("set_host_tools", "owner-one", { tools: [toolOne] }), call("one")),
    ).resolves.toEqual({ toolNames: ["tab_one"] });
    await expect(
      send(registration("set_host_tools", "owner-two", { tools: [toolTwo] }), call("two")),
    ).resolves.toEqual({ toolNames: ["tab_two"] });
    await send(
      registration("set_host_uri_schemes", "owner-one", { schemes: [schemeOne] }),
      call("one"),
    );
    await send(
      registration("set_host_uri_schemes", "owner-two", { schemes: [schemeTwo] }),
      call("two"),
    );

    await getHandler(handlers, "restart")({ threadId: authorityThread }, call("one"));
    let process = created.at(-1);
    expect(process).not.toBe(created[0]);
    expect(paramsOf(process, "set_host_tools").at(-1)?.tools).toEqual([toolOne, toolTwo]);
    expect(paramsOf(process, "set_host_uri_schemes").at(-1)?.schemes).toEqual([
      schemeOne,
      schemeTwo,
    ]);

    await getHandler(handlers, "close")({ threadId: authorityThread }, call("one"));
    process = created.at(-1);
    expect(paramsOf(process, "set_host_tools").at(-1)?.tools).toEqual([toolTwo]);
    expect(paramsOf(process, "set_host_uri_schemes").at(-1)?.schemes).toEqual([schemeTwo]);

    await chatPort.onConnectionClosed?.("two");
    expect(paramsOf(process, "set_host_tools").at(-1)?.tools).toEqual([]);
    expect(paramsOf(process, "set_host_uri_schemes").at(-1)?.schemes).toEqual([]);
    await processRegistry.closeAll();
  });

  test("releaseViews lets go of one connection's views and its host tools, and keeps the other connection's", async () => {
    const created: FakeChatHost[] = [];
    const { processRegistry, runtime, open, handlers } = runtimeWithIdleClose(created, 1_000);
    const send = getHandler(handlers, "request");
    await open({ threadId: authorityThread }, call("one"));
    await open({ threadId: authorityThread }, call("two"));
    await open({ threadId: authorityThread }, call("one"));
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(2);
    expect(runtime.views.viewsOf(authorityThread, "two")).toBe(1);
    expect(runtime.views.viewsOf(ThreadId.parse("never-opened"), "one")).toBe(0);
    expect(processRegistry.watcherCount(authorityThread)).toBe(3);

    await send(registration("set_host_tools", "owner-one", { tools: [toolOne] }), call("one"));
    await send(registration("set_host_tools", "owner-two", { tools: [toolTwo] }), call("two"));

    await runtime.views.releaseViews(authorityThread, "one");
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);
    expect(runtime.views.viewsOf(authorityThread, "two")).toBe(1);
    expect(processRegistry.watcherCount(authorityThread)).toBe(1);
    expect(created[0]?.status).toBe("running");
    expect(paramsOf(created[0], "set_host_tools").at(-1)?.tools).toEqual([toolTwo]);

    // A connection with no view of the chat has nothing to let go: nothing changes.
    await runtime.views.releaseViews(authorityThread, "one");
    expect(processRegistry.watcherCount(authorityThread)).toBe(1);
    await processRegistry.closeAll();
  });

  test("refuses host registrations from a connection that never opened the chat", async () => {
    const created: FakeChatHost[] = [];
    const { processRegistry, open, handlers } = runtimeWithIdleClose(created, 1_000);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const send = getHandler(handlers, "request");
    const stranger = { ...toolOne, name: "tab_stranger", label: "tab_stranger" };
    await expect(
      send(registration("set_host_tools", "owner-two", { tools: [stranger] }), call("two")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    await expect(
      send(
        registration("set_host_uri_schemes", "owner-two", {
          schemes: [{ scheme: "tabtwo", writable: false }],
        }),
        call("two"),
      ),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    expect(paramsOf(created[0], "set_host_tools")).toEqual([]);
    expect(paramsOf(created[0], "set_host_uri_schemes")).toEqual([]);
    await processRegistry.closeAll();
  });

  test("the ask-dialog opt-in lasts for one host: a restart tells the new host again, and a chat that never opted in is not told", async () => {
    const created: FakeChatHost[] = [];
    const { processRegistry, open, handlers } = runtimeWithIdleClose(created, 1_000);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const send = getHandler(handlers, "request");
    const restart = getHandler(handlers, "restart");
    const optIns = (process: FakeChatHost | undefined) =>
      paramsOf(process, "set_ask_dialog").map((params) => params.enabled);

    // A chat nobody opted in: its restarted host is told nothing about rich ask questions.
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([]);

    await expect(
      send(request(authorityThread, "set_ask_dialog", { enabled: true }), call("one")),
    ).resolves.toEqual({});
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([true]);
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([true]);

    await send(request(authorityThread, "set_ask_dialog", { enabled: false }), call("one"));
    await restart({ threadId: authorityThread }, call("one"));
    expect(optIns(created.at(-1))).toEqual([]);
    await processRegistry.closeAll();
  });

  test("a closed connection releases every chat it opened, and the host stops once nobody watches it", async () => {
    const created: FakeChatHost[] = [];
    const { processRegistry, registration: chatPort, open } = runtimeWithIdleClose(created, 25);
    await open({ folderPath: folder, start: "new" }, call("one"));
    // The same tab opened the chat again (a reload that never said goodbye) and another tab watches it.
    await open({ threadId: authorityThread }, call("one"));
    await open({ threadId: authorityThread }, call("two"));

    await chatPort.onConnectionClosed?.("one");
    await Bun.sleep(80);
    expect(processRegistry.has(authorityThread)).toBe(true);
    expect(created[0]?.status).not.toBe("stopped");

    await chatPort.onConnectionClosed?.("two");
    await Bun.sleep(80);
    expect(processRegistry.has(authorityThread)).toBe(false);
    expect(created[0]?.status).toBe("stopped");

    // A connection that never opened anything, or closes twice, changes nothing.
    await chatPort.onConnectionClosed?.("two");
    await chatPort.onConnectionClosed?.("never-opened");
  });

  test("an unwatched chat keeps its host while omp is still working, is stopped once settled, and opens again on a fresh host", async () => {
    const created: FakeChatHost[] = [];
    const {
      processRegistry,
      registration: chatPort,
      open,
      handlers,
    } = runtimeWithIdleClose(created, 20);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("no host was started");
    first.extraState = { isSettled: false };

    await chatPort.onConnectionClosed?.("one");
    await Bun.sleep(120);
    // Six idle periods passed and the host kept saying it was not settled: the turn was never cut off.
    expect(processRegistry.has(authorityThread)).toBe(true);
    expect(first.status).not.toBe("stopped");

    first.extraState = { isSettled: true };
    await Bun.sleep(80);
    expect(first.status).toBe("stopped");
    expect(processRegistry.has(authorityThread)).toBe(false);

    // The chat opens again on a new host, and requests reach that one, not the stopped one.
    const requestsToFirst = first.requests.length;
    await open({ threadId: authorityThread }, call("two"));
    expect(created).toHaveLength(2);
    await getHandler(handlers, "request")(
      request(authorityThread, "prompt", { text: "hello again" }),
      call("two"),
    );
    expect(created[1]?.methods).toContain("prompt");
    expect(first.requests).toHaveLength(requestsToFirst);
  });
});

describe("the chat session runtime: stops, deletes and chats another omp holds", () => {
  /** The runtime over a plain context, with its chat port's handlers; the chat is opened by connection `one`. */
  async function openedRuntime(
    created: FakeChatHost[],
    runtimeContext: A0PortContext = context(created),
    connectionId = "one",
  ) {
    const runtime = createA0Runtime(runtimeContext);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet | undefined;
    if (handlers === undefined) throw new Error("missing the chat registration");
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call(connectionId));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake host");
    return { runtime, handlers, process };
  }

  /** Waits until the registry counts the chat's host as stopping. */
  async function untilStopping(runtimeContext: A0PortContext, threadId = authorityThread) {
    for (
      let turn = 0;
      turn < 100 && !runtimeContext.processRegistry.isStopping(threadId);
      turn += 1
    ) {
      await Bun.sleep(0);
    }
    expect(runtimeContext.processRegistry.isStopping(threadId)).toBe(true);
  }

  test("opening a chat again while its old host is still exiting waits for it, so two hosts never share a session file", async () => {
    const created: FakeChatHost[] = [];
    const { registration: chatPort, open } = runtimeWithIdleClose(created, 20);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("no host was started");
    const exit = Promise.withResolvers<void>();
    first.stopGate = exit.promise;

    await chatPort.onConnectionClosed?.("one");
    await Bun.sleep(80);
    const reopened = open({ threadId: authorityThread }, call("two"));
    await Bun.sleep(60);
    expect(created).toHaveLength(1);

    exit.resolve();
    await reopened;
    expect(created).toHaveLength(2);
    expect(first.status).toBe("stopped");
  });

  test("opening a chat whose host is still stopping resumes the chat's file, not its first start (issue 2212)", async () => {
    const created: FakeChatHost[] = [];
    const { registration: chatPort, open } = runtimeWithIdleClose(created, 20);
    await open({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("no host was started");
    const exit = Promise.withResolvers<void>();
    const stopCalled = Promise.withResolvers<void>();
    first.stopGate = exit.promise;
    const stopHost = first.stop.bind(first);
    first.stop = () => {
      stopCalled.resolve();
      return stopHost();
    };

    await chatPort.onConnectionClosed?.("one");
    await stopCalled.promise;
    const picked = open({ threadId: authorityThread }, call("two"));
    expect(created).toHaveLength(1);

    exit.resolve();
    await picked;
    expect(created).toHaveLength(2);
    expect(created[1]?.args).toEqual(["--resume", authorityFile]);
  });

  test("release, then reopen at once: the reopen waits for the old host to exit, is not refused, and one host runs at a time (issue 2212)", async () => {
    const created: FakeChatHost[] = [];
    let oldHostRunning = false;
    const processRegistry = new OmpProcessRegistry({
      idleCloseMs: 20,
      createProcess: fakeHost(created),
    });
    const chatPort = createA0Runtime({
      ...context(created),
      processRegistry,
      // The chat's lease reads held while its host runs, and a host that is stopping still runs.
      leaseProbe: async () => (oldHostRunning ? "active" : "inactive"),
    }).registrations[0];
    if (chatPort === undefined) throw new Error("missing registration");
    const open = getHandler(chatPort.handlers as HandlerSet, "open");
    await open({ folderPath: folder, start: "new" }, call("one"));
    const first = created[0];
    if (first === undefined) throw new Error("no host was started");
    oldHostRunning = true;
    const exit = Promise.withResolvers<void>();
    const stopCalled = Promise.withResolvers<void>();
    first.stopGate = exit.promise;
    const stopHost = first.stop.bind(first);
    first.stop = async () => {
      stopCalled.resolve();
      await stopHost();
      oldHostRunning = false;
    };

    await chatPort.onConnectionClosed?.("one");
    await stopCalled.promise;
    // The reopen comes at once, while the old host is still stopping: it waits for that host to exit, then starts one.
    const reopened = open({ threadId: authorityThread }, call("two"));
    expect(created).toHaveLength(1);

    exit.resolve();
    await reopened;
    expect(created).toHaveLength(2);
    expect(created[1]?.args).toEqual(["--resume", authorityFile]);
  });

  test("opening a chat whose old host does not stop in time is refused, and the open does not wait for ever", async () => {
    const created: FakeChatHost[] = [];
    const timer = firingTimer();
    const processRegistry = new OmpProcessRegistry({
      timer,
      idleCloseMs: 20,
      createProcess: fakeHost(created, undefined, {
        // The old host never finishes stopping.
        onCreate: (process) => {
          process.stopGate = new Promise<void>(() => undefined);
        },
      }),
    });
    const handlers = handlersFor({ ...context(created), processRegistry });
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await getHandler(handlers, "close")({ threadId: authorityThread }, call("one"));
    // The idle close asks the host whether it has settled, then starts the stop, which does not finish.
    timer.fireAll();
    for (let turn = 0; turn < 50; turn += 1) await Bun.sleep(0);

    const rejected = Promise.resolve(
      getHandler(handlers, "open")({ threadId: authorityThread }, call("two")),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    // The open waits for the stop only up to its limit, and is then refused.
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
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, process } = await openedRuntime(created, runtimeContext);
    process.stop = () => Promise.reject(new Error("omp could not be signalled"));

    // A delete from this tab stops the chat's host, counting this tab's own view as its own. The stop fails.
    await expect(
      runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message: "omp did not stop, so this chat was not deleted. Try again in a moment.",
      },
    });
    // The chat is still open for this tab: its entry and its view are kept, so its next message reaches the host.
    expect(runtime.commandSessionFor(authorityThread)).toBeDefined();
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(runtimeContext.processRegistry.watcherCount(authorityThread)).toBe(1);
  });

  test("a stop takes the chat's views with its host, and while the host is stopping the views still count for another tab", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, process } = await openedRuntime(created, runtimeContext);
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;

    const stopping = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
    // The host is stopping: its entry has left the registry, but its views still count, so another tab is refused.
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(runtime.views.watcherCount(authorityThread)).toBe(1);

    gate.resolve();
    await stopping;
    // The host has exited: the views on its chat went with it.
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);
    expect(runtime.views.watcherCount(authorityThread)).toBe(0);
    expect(runtime.commandSessionFor(authorityThread)).toBeUndefined();
  });

  test("a stop reaches no viewer and no replay: the stream's latest sequence does not move while the host exits", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    await openedRuntime(created, runtimeContext);
    const stream = chatSessionEventStream(authorityThread);
    const before = runtimeContext.replay.latestSeq(stream);

    await runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);

    expect(created[0]?.status).toBe("stopped");
    expect(runtimeContext.replay.latestSeq(stream)).toBe(before);
  });

  test("a request to a chat whose host is stopping is refused as no open thread, and nothing reaches the host", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { handlers, process } = await openedRuntime(created, runtimeContext);
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;
    const stopping = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
    const sent = process.requests.length;

    await expect(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "too late" }),
        call("one"),
      ),
    ).rejects.toMatchObject({
      appError: { code: "not_found", message: `No open thread ${authorityThread}` },
    });
    expect(process.requests).toHaveLength(sent);

    gate.resolve();
    await stopping;
  });

  test("a delete whose stop runs past the limit is refused, and the chat is opened again for the tab that asked once its host has stopped", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = contextStopLimitAtOnce(created);
    const { handlers, process } = await openedRuntime(created, runtimeContext, "tab");
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;

    // The tab's delete waits on the stop past its limit: the delete is refused, and the host's stop goes on.
    await expect(
      runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    gate.resolve();

    // The host exits; a new host opens the chat again for the tab, and it answers the tab's next message.
    for (let turn = 0; turn < 100 && created.length < 2; turn += 1) await Bun.sleep(0);
    expect(created).toHaveLength(2);
    await getHandler(handlers, "request")(
      request(authorityThread, "prompt", { text: "after the refusal" }),
      call("tab"),
    );
    expect(paramsOf(created[1], "prompt")).toEqual([{ text: "after the refusal" }]);
  });

  test("a refused delete's chat is not opened again while another omp holds it: no host starts", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = contextStopLimitAtOnce(created, { externalOmp: async () => "running" });
    const { process } = await openedRuntime(created, runtimeContext, "tab");
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;
    await expect(
      runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    gate.resolve();
    for (let turn = 0; turn < 100; turn += 1) await Bun.sleep(0);
    expect(created).toHaveLength(1);
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("a delete whose stop ends within the limit opens nothing again", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { process } = await openedRuntime(created, runtimeContext, "tab");
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;
    const deleting = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
    gate.resolve();
    await deleting;
    for (let turn = 0; turn < 100; turn += 1) await Bun.sleep(0);
    expect(created).toHaveLength(1);
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("a request to a chat another omp holds, with no host here, is refused with the sentence and starts no host", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({ ...context(created), externalOmp: async () => "running" });
    await expect(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "hello" }),
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

  test("a request to a chat nobody holds, with no host here, is still refused as no open thread, and starts no host", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await expect(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "hello" }),
        call("tab"),
      ),
    ).rejects.toMatchObject({
      appError: { code: "not_found", message: `No open thread ${authorityThread}` },
    });
    expect(created).toHaveLength(0);
  });

  test("a tab that closes its chat while the host stops is not kept as a watcher when that stop fails", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, handlers, process } = await openedRuntime(created, runtimeContext);
    const gate = Promise.withResolvers<void>();
    process.stop = () =>
      gate.promise.then(() => Promise.reject(new Error("omp could not be signalled")));

    // A delete from this tab starts the stop. While the host stops, this tab moves on and closes the chat.
    const deleting = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
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
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
    expect(runtimeContext.processRegistry.watcherCount(authorityThread)).toBe(0);
  });

  test("a chat whose host is stopping has no session for the command path, and a rename waits for the host to exit", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, handlers, process } = await openedRuntime(created, runtimeContext);
    const gate = Promise.withResolvers<void>();
    process.stop = () =>
      gate.promise.then(() => Promise.reject(new Error("omp could not be signalled")));

    const deleting = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
    expect(runtime.commandSessionFor(authorityThread)).toBeUndefined();

    // A rename sent while the host stops waits for the stop to end, and asks nothing of the stopping host.
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
    expect(process.methods).not.toContain("set_session_name");

    gate.resolve();
    await expect(deleting).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(await renamed).toMatchObject({ appError: { code: "conflict" } });
  });

  /**
   * Tab one holds a host tool, and lets its view go while the host stops: the host's exit ends the stop before the host
   * answers the registration that takes the tool back. Tab two opens the chat meanwhile. Returns tab two's watcher
   * count when it opens, and after the host's late answer; a release that comes after the stop must not reach tab two's
   * watcher.
   */
  async function lateHostAnswerAfterStop(
    letGo: (runtime: ReturnType<typeof createA0Runtime>, handlers: HandlerSet) => unknown,
  ): Promise<{ readonly opened: number; readonly answered: number }> {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, handlers, process } = await openedRuntime(created, runtimeContext);
    await getHandler(handlers, "request")(
      registration("set_host_tools", "owner-one", { tools: [toolOne] }),
      call("one"),
    );
    const stopGate = Promise.withResolvers<void>();
    const hostAnswer = Promise.withResolvers<void>();
    process.stopGate = stopGate.promise;
    process.keepPendingOnStop = true;
    process.holdHostTools = hostAnswer.promise;

    // Tab one's delete stops the host, counting its own view as its own. The stop waits at its gate.
    const stopping = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
    // Tab one lets go while the stop runs. Its registration is not answered yet.
    const letting = Promise.resolve(letGo(runtime, handlers));
    for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(0);
    // The host exits, and tab two opens the chat.
    stopGate.resolve();
    await stopping;
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    const opened = runtimeContext.processRegistry.watcherCount(authorityThread);
    // The host answers tab one's registration only now, after the stop has ended.
    hostAnswer.resolve();
    await letting;
    return { opened, answered: runtimeContext.processRegistry.watcherCount(authorityThread) };
  }

  test("a close during a stop lets its view go before the host answers its registration, so the next tab keeps its watcher", async () => {
    const result = await lateHostAnswerAfterStop((_runtime, handlers) =>
      getHandler(handlers, "close")({ threadId: authorityThread }, call("one")),
    );
    expect(result).toEqual({ opened: 1, answered: 1 });
  });

  test("a connection that closes during a stop lets its views go before the host answers, so the next tab keeps its watcher", async () => {
    const result = await lateHostAnswerAfterStop(async (runtime) => {
      await runtime.registrations[0]?.onConnectionClosed?.("one");
    });
    expect(result).toEqual({ opened: 1, answered: 1 });
  });

  test("releaseViews during a stop lets its views go before the host answers, so the next tab keeps its watcher", async () => {
    const result = await lateHostAnswerAfterStop((runtime) =>
      runtime.views.releaseViews(authorityThread, "one"),
    );
    expect(result).toEqual({ opened: 1, answered: 1 });
  });

  test("a rename sent with a moved chat's old id waits for that chat's stopping host, and reaches neither host", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { handlers, process } = await openedRuntime(created, runtimeContext);
    const switchedThread = ThreadId.parse("omp-session-switched-rename");
    process.nextIdentity = {
      threadId: switchedThread,
      sessionFile: SessionFilePath.parse("/workspace/a0-7/.omp/switched-rename.jsonl"),
    };
    await getHandler(handlers, "request")(
      request(authorityThread, "branch", { entryId: "entry-1" }),
      call("one"),
    );
    // The moved chat is keyed by its new id, and the old id leads to it.
    const gate = Promise.withResolvers<void>();
    process.stop = () =>
      gate.promise.then(() => Promise.reject(new Error("omp could not be signalled")));
    const deleting = runtimeContext.processRegistry.stopIfUnwatched(switchedThread, "deleted", 1);
    await untilStopping(runtimeContext, switchedThread);

    // A rename sent with the old id, while that chat's host stops.
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
    expect(process.methods).not.toContain("set_session_name");

    gate.resolve();
    await expect(deleting).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(await renamed).toMatchObject({ appError: { code: "conflict" } });
    // Neither host was asked to set the name, and no host was started for the file the old id names.
    expect(process.methods).not.toContain("set_session_name");
    expect(created).toHaveLength(1);
  });

  test("closing a chat with no open entry resolves to null, and lets go of nothing", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, handlers } = await openedRuntime(created, runtimeContext);
    await expect(
      getHandler(handlers, "close")({ threadId: ThreadId.parse("chat-never-opened") }, call("one")),
    ).resolves.toBeNull();
    expect(runtimeContext.processRegistry.watcherCount(authorityThread)).toBe(1);
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(created).toHaveLength(1);
  });

  test("restoreViews gives a connection back its view on the host another tab started, once each, and starts no host for a chat nothing serves", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const { runtime, handlers, process } = await openedRuntime(created, runtimeContext);
    const gate = Promise.withResolvers<void>();
    process.stopGate = gate.promise;

    // Tab one's delete stops the host, counting its own view as its own. The stop waits at its gate.
    const deleting = runtimeContext.processRegistry.stopIfUnwatched(authorityThread, "deleted", 1);
    await untilStopping(runtimeContext);
    // Tab two opens the chat while the host stops: the host it starts after the stop serves the chat.
    const second = getHandler(handlers, "open")({ threadId: authorityThread }, call("two"));
    gate.resolve();
    await deleting;
    await second;
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(0);
    expect(runtime.views.watcherCount(authorityThread)).toBe(1);

    // The refused delete gives tab one its view back on that host, once: a second call adds nothing.
    runtime.views.restoreViews(authorityThread, "one", 1);
    runtime.views.restoreViews(authorityThread, "one", 1);
    expect(runtime.views.viewsOf(authorityThread, "one")).toBe(1);
    expect(runtime.views.watcherCount(authorityThread)).toBe(2);
    expect(created).toHaveLength(2);

    // A chat no running host serves gets nothing, and no host is started for it.
    runtime.views.restoreViews(ThreadId.parse("chat-nothing-serves"), "one", 1);
    expect(created).toHaveLength(2);
  });
});

describe("the chat session runtime: the host's requests and UI state", () => {
  /** Opens a new chat and returns its handlers, its host and a read of its replayed frames. */
  async function openChat() {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const process = created[0];
    if (process === undefined) throw new Error("missing fake host");
    const frames = () => {
      const replay = runtimeContext.replay.replay(chatSessionEventStream(authorityThread), 0);
      if ("error" in replay) throw new Error("unexpected replay conflict");
      return replay.frames;
    };
    return { created, runtimeContext, handlers, process, frames };
  }

  /** The sequence of the replayed `host_request` that carries a request; the test fails when none does. */
  function seqOfHostRequest(
    frames: readonly { readonly seq: number; readonly payload: unknown }[],
    id: string,
  ): number {
    const frame = frames.find(
      (item) =>
        payloadKind(item.payload) === "host_request" &&
        (item.payload as { request: { id: string } }).request.id === id,
    );
    if (frame === undefined) throw new Error(`no replayed frame carries ${id}`);
    return frame.seq;
  }

  const confirm = { title: "Go on?", message: "" };

  test("the browser's answers reach the host, and the host's crash is published as a process event", async () => {
    const { handlers, process, frames } = await openChat();
    process.emitRequest("ui-1", "ui.confirm", confirm);
    process.emitRequest("host-1", "tool.call", {
      toolCallId: "tool-1",
      toolName: "echo",
      arguments: {},
    });
    await ticks();
    const answer = getHandler(handlers, "answer");
    answer({ threadId: authorityThread, id: "ui-1", answer: { confirmed: true } }, call("one"));
    answer({ threadId: authorityThread, id: "host-1", answer: { content: [] } }, call("one"));
    await ticks();
    expect(process.responses).toEqual([
      { kind: "response", id: "ui-1", ok: true, result: { confirmed: true } },
      { kind: "response", id: "host-1", ok: true, result: { content: [] } },
    ]);

    process.crash();
    expect(
      frames()
        .map((frame) => processStatus(frame.payload))
        .filter(Boolean),
    ).toContain("exited");
  });

  test("keeps the requests the host waits on until each is answered or given up, each with the sequence that asked it", async () => {
    const { handlers, process, frames } = await openChat();
    const openRequests = () =>
      getHandler(handlers, "openRequests")({ threadId: authorityThread }, call("one")) as Array<{
        seq: number;
        request: { id: string };
      }>;
    process.emitRequest("ui-1", "ui.confirm", confirm);
    // A notice needs no answer: it is an event, never an open request.
    process.emitEvent({ type: "ui_notify", message: "heads up" });
    process.emitRequest("ui-2", "ui.input", { title: "Name?" });
    await ticks();
    const open = openRequests();
    expect(open.map((item) => item.request.id)).toEqual(["ui-1", "ui-2"]);
    expect(open.map((item) => item.seq)).toEqual([
      seqOfHostRequest(frames(), "ui-1"),
      seqOfHostRequest(frames(), "ui-2"),
    ]);

    getHandler(handlers, "answer")(
      { threadId: authorityThread, id: "ui-1", answer: { confirmed: true } },
      call("one"),
    );
    expect(openRequests().map((item) => item.request.id)).toEqual(["ui-2"]);
    // omp gave the input up (its timeout, or an abort): the host says so, and nothing waits any more.
    process.emitEvent({ type: "ui_cancel", requestId: "ui-2" });
    expect(openRequests()).toEqual([]);
  });

  test("a request the host was waiting on is not open once the host has exited", async () => {
    const { handlers, process } = await openChat();
    process.emitRequest("ui-1", "ui.confirm", confirm);
    await ticks();
    const openRequests = getHandler(handlers, "openRequests");
    expect(openRequests({ threadId: authorityThread }, call("one"))).toHaveLength(1);
    process.crash();
    expect(openRequests({ threadId: authorityThread }, call("one"))).toEqual([]);
  });

  test("keeps the status, widget and title the host last set until each is replaced or cleared, and a restart drops them", async () => {
    const { handlers, process, frames } = await openChat();
    const uiState = () =>
      getHandler(handlers, "uiState")({ threadId: authorityThread }, call("one")) as Array<{
        seq: number;
        event: Record<string, unknown>;
      }>;
    const seqOf = (event: Record<string, unknown>): number => {
      const frame = frames().find(
        (item) =>
          payloadKind(item.payload) === "event" &&
          JSON.stringify((item.payload as { event: unknown }).event) === JSON.stringify(event),
      );
      if (frame === undefined)
        throw new Error(`no replayed frame carries ${JSON.stringify(event)}`);
      return frame.seq;
    };
    const running = { type: "ui_status", statusKey: "build", statusText: "Running" };
    const widget = { type: "ui_widget", widgetKey: "build", widgetLines: ["Building"] };
    const done = { type: "ui_status", statusKey: "build", statusText: "Done" };
    const lint = { type: "ui_status", statusKey: "lint", statusText: "Clean" };
    const title = { type: "ui_title", title: "Build status" };
    for (const event of [running, widget, done, lint, title]) process.emitEvent(event);

    // Each key holds its latest event, with the sequence that set it, oldest first.
    expect(uiState().map((item) => item.event)).toEqual([widget, done, lint, title]);
    expect(uiState().map((item) => item.seq)).toEqual([
      seqOf(widget),
      seqOf(done),
      seqOf(lint),
      seqOf(title),
    ]);
    // A status or a widget sent with no text or lines clears what it names.
    process.emitEvent({ type: "ui_status", statusKey: "build" });
    process.emitEvent({ type: "ui_widget", widgetKey: "build" });
    expect(uiState().map((item) => item.event)).toEqual([lint, title]);
    // A later title replaces the earlier one: the title key holds only the latest.
    const later = { type: "ui_title", title: "Build done" };
    process.emitEvent(later);
    expect(uiState().map((item) => item.event)).toEqual([lint, later]);

    await getHandler(handlers, "restart")({ threadId: authorityThread }, call("one"));
    expect(uiState()).toEqual([]);
  });

  test("a restart gives up the requests of the host it replaces, since the new host cannot answer them", async () => {
    const { created, handlers, process } = await openChat();
    process.emitRequest("ui-9", "ui.confirm", confirm);
    await ticks();
    const openRequests = getHandler(handlers, "openRequests");
    expect(openRequests({ threadId: authorityThread }, call("one"))).toHaveLength(1);
    await getHandler(handlers, "restart")({ threadId: authorityThread }, call("one"));
    expect(created).toHaveLength(2);
    expect(openRequests({ threadId: authorityThread }, call("one"))).toEqual([]);
  });
});

describe("the chat session runtime: a host that crashed", () => {
  test("a request sent after the host crashed starts a host again on the same chat and tells it what the old one had been told", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "progress" },
      call("one"),
    );
    const crashed = created[0];
    if (crashed === undefined) throw new Error("missing fake host");
    crashed.crash();

    const result = await getHandler(handlers, "request")(
      request(authorityThread, "prompt", { text: "after the crash" }),
      call("one"),
    );

    expect(result).toEqual({ resultFollows: true });
    expect(created).toHaveLength(2);
    const revived = created[1];
    if (revived === undefined) throw new Error("the host was not started again");
    expect(revived.args).toEqual(["--resume", authorityFile]);
    expect(paramsOf(revived, "prompt")).toEqual([{ text: "after the crash" }]);
    expect(paramsOf(revived, "set_subagent_subscription").map((params) => params.level)).toEqual([
      "progress",
    ]);
    // The chat stays one chat for the browsers watching it: its stream carries the new host.
    const statuses = replayed(runtimeContext, authorityThread)
      .map((payload) => processStatus(payload))
      .filter((status) => status !== undefined);
    expect(statuses).toContain("exited");
    expect(statuses.at(-1)).toBe("ready");
  });

  test("two requests sent at once after a crash start a host only once", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await Promise.all([
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "first" }),
        call("one"),
      ),
      getHandler(handlers, "request")(request(authorityThread, "get_state"), call("one")),
    ]);

    expect(created).toHaveLength(2);
  });

  test("a rename sent after the host crashed starts a host again and renames the chat", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await getHandler(handlers, "rename")(
      { threadId: authorityThread, name: "Renamed after the crash" },
      call("one"),
    );

    expect(created).toHaveLength(2);
    expect(paramsOf(created[1], "set_session_name")).toEqual([{ name: "Renamed after the crash" }]);
  });

  test("a subagent subscription sent after the host crashed starts a host again and applies it", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await getHandler(handlers, "setSubagentSubscription")(
      { threadId: authorityThread, level: "progress" },
      call("one"),
    );

    expect(created).toHaveLength(2);
    expect(paramsOf(created[1], "set_subagent_subscription")).toEqual([{ level: "progress" }]);
  });

  test("message updates asked for after the host crashed start a host again", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await getHandler(handlers, "setEventOptions")(
      { threadId: authorityThread, messageUpdates: "full" },
      call("one"),
    );

    expect(created).toHaveLength(2);
    expect(paramsOf(created[1], "set_event_options")).toEqual([{ messageUpdates: "full" }]);
  });

  test("a chat whose host stopped before the chat was saved is not started again, and says why", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({ ...context(created), sessionFileExists: async () => false });
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await expect(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "hello again" }),
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

  test("a failed start leaves the chat able to try again on the next request", async () => {
    const created: FakeChatHost[] = [];
    const processRegistry = registryKeeping(created, (process) => {
      // The host started for the first request after the crash cannot start; the next one can.
      if (created.length === 1) {
        process.startFailure = new AppFailure({
          code: "omp_exited",
          message: "omp could not start",
          retryable: true,
        });
      }
    });
    const handlers = handlersFor({ ...context(created), processRegistry });
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();

    await expect(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "try" }),
        call("one"),
      ),
    ).rejects.toMatchObject({ appError: { message: "omp could not start" } });
    await expect(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "try again" }),
        call("one"),
      ),
    ).resolves.toEqual({ resultFollows: true });
    expect(created).toHaveLength(3);
  });

  test("a request the browser cancelled while its chat started again is refused as cancelled, and never reaches the new host", async () => {
    const created: FakeChatHost[] = [];
    const processRegistry = registryKeeping(created, (process) => {
      // The host started after the crash holds its hello: the chat is still starting when the browser gives up.
      if (created.length === 1) process.holdHello = true;
    });
    const handlers = handlersFor({ ...context(created), processRegistry });
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    created[0]?.crash();
    const controller = new AbortController();
    const sent = Promise.resolve(
      getHandler(handlers, "request")(
        request(authorityThread, "prompt", { text: "never sent" }),
        call("one", controller.signal),
      ),
    );
    for (let turn = 0; turn < 100 && created.length < 2; turn += 1) await Bun.sleep(0);
    const revived = created[1];
    if (revived === undefined) throw new Error("the host was not started again");

    controller.abort("cancelled");
    revived.sendHello();

    await expect(sent).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(revived.methods).not.toContain("prompt");
  });

  test("an open whose connection closed while it waited adds no viewer and starts no host", async () => {
    const created: FakeChatHost[] = [];
    const processRegistry = registryKeeping(created);
    // The chat's host is still stopping, so the open waits for it to be gone.
    const stop = Promise.withResolvers<void>();
    processRegistry.whenGone = () => stop.promise;
    const chatPort = createA0Runtime({ ...context(created), processRegistry }).registrations[0];
    if (chatPort === undefined) throw new Error("missing A0 registration");
    const controller = new AbortController();
    const opened = getHandler(chatPort.handlers as HandlerSet, "open")(
      { threadId: authorityThread },
      call("tab", controller.signal),
    );

    // The tab closes while the open waits: the dispatcher aborts the call, then releases the connection.
    controller.abort("connection_closed");
    await chatPort.onConnectionClosed?.("tab");
    stop.resolve();

    await expect(opened).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(created).toHaveLength(0);
    expect(processRegistry.has(authorityThread)).toBe(false);
  });
});

describe("the chat session runtime: renames, whether or not the chat is open", () => {
  test("an open chat is renamed by its own host, which stays up", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor(context(created));
    await getHandler(handlers, "open")({ threadId: authorityThread }, call("one"));
    await expect(
      getHandler(handlers, "rename")(
        { threadId: authorityThread, name: "Renamed open" },
        call("one"),
      ),
    ).resolves.toBeNull();
    expect(created).toHaveLength(1);
    expect(paramsOf(created[0], "set_session_name")).toEqual([{ name: "Renamed open" }]);
    expect(created[0]?.status).toBe("running");
  });

  test("a chat nobody has open is renamed by a short-lived host that stops once the title is saved", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
    await expect(
      getHandler(handlers, "rename")(
        { threadId: authorityThread, name: "Closed rename" },
        call("one"),
      ),
    ).resolves.toBeNull();
    const host = created[0];
    expect(created).toHaveLength(1);
    expect(host?.args).toEqual(["--resume", authorityFile]);
    expect(paramsOf(host, "set_session_name")).toEqual([{ name: "Closed rename" }]);
    expect(host?.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("a chat another viewer has open keeps its host when one viewer renames it", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext = context(created);
    const handlers = handlersFor(runtimeContext);
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
    const created: FakeChatHost[] = [];
    const seen: { hosts: number; asked: string[] } = { hosts: 0, asked: [] };
    const runtimeContext: A0PortContext = {
      ...context(created),
      externalOmp: async (threadId, sessionFile, hostPid) => {
        seen.hosts = created.length;
        seen.asked.push(`${threadId} ${sessionFile} host ${hostPid}`);
        return "running";
      },
    };
    const handlers = handlersFor(runtimeContext);
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Busy" }, call("one")),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message: expect.stringMatching(/Another omp is using this chat/),
      },
    });
    // The fake host reports pid 777: the check must be told it, so the host is not taken for another omp.
    expect(seen).toEqual({ hosts: 1, asked: [`${authorityThread} ${authorityFile} host 777`] });
    const host = created[0];
    expect(paramsOf(host, "set_session_name")).toEqual([]);
    expect(host?.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });

  test("refuses to rename a chat while the app can't tell whether another omp is writing it, and writes nothing", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({ ...context(created), externalOmp: async () => "unknown" });
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Unknown" }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    expect(paramsOf(created[0], "set_session_name")).toEqual([]);
    expect(created[0]?.status).toBe("stopped");
  });

  test("a chat that does not exist cannot be renamed", async () => {
    const created: FakeChatHost[] = [];
    const handlers = handlersFor({ ...context(created), resolveThread: async () => undefined });
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Gone" }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    expect(created).toHaveLength(0);
  });

  test("a rename omp saved to a copy of the chat is reported, and the copy's host is stopped", async () => {
    const created: FakeChatHost[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created),
      processRegistry: registryKeeping(created, (process) => {
        // omp writes to a copy when another live process holds the chat's file.
        process.nextIdentity = {
          threadId: ThreadId.parse("omp-copy-a0-7"),
          sessionFile: SessionFilePath.parse("/workspace/a0-7/.omp/copy-a0-7.jsonl"),
        };
      }),
    };
    const handlers = handlersFor(runtimeContext);
    await expect(
      getHandler(handlers, "rename")({ threadId: authorityThread, name: "Copied" }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(paramsOf(created[0], "set_session_name")).toEqual([{ name: "Copied" }]);
    expect(created[0]?.status).toBe("stopped");
    expect(runtimeContext.processRegistry.has(authorityThread)).toBe(false);
  });
});

describe("the chat session runtime: a chat an earlier server left running, on another omp (D2)", () => {
  const spare: FakeIdentity = {
    threadId: ThreadId.parse("omp-session-left-running"),
    sessionFile: SessionFilePath.parse("/workspace/a0-7/.omp/left-running.jsonl"),
  };

  /** This server starts and finds the chat's host running, on an omp of its own: restarted once it settles. */
  function adoptLeftRunning(saved: () => boolean) {
    const created: FakeChatHost[] = [];
    const runtimeContext: A0PortContext = {
      ...context(created, spare),
      sessionFileExists: async () => saved(),
    };
    const left = new FakeChatHost({ threadId: spare.threadId, folder, args: [] }, spare);
    createA0Runtime(runtimeContext).adopt(
      left,
      {
        kind: "hello",
        protocol: 1,
        ompVersion: "18.12.5",
        methods: [...CHAT_HOST_METHODS],
        session: { id: spare.threadId, file: spare.sessionFile, cwd: folder },
      },
      { restartWhenSettled: true },
    );
    return { created, left, registry: runtimeContext.processRegistry };
  }

  test("one omp never saved (a spare kept ready for a new chat) is stopped once settled, not restarted", async () => {
    const { created, left, registry } = adoptLeftRunning(() => false);
    await ticks(30);
    expect(left.status).toBe("stopped");
    expect(created).toHaveLength(0);
    expect(registry.has(spare.threadId)).toBe(false);
  });

  test("a saved one is restarted on this server's omp once settled", async () => {
    const { created, left, registry } = adoptLeftRunning(() => true);
    await ticks(30);
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual(["--resume", spare.sessionFile]);
    expect(left.status).toBe("stopped");
    expect(registry.has(spare.threadId)).toBe(true);
  });

  test("one a page holds before its first reply keeps running, and is restarted once that reply is saved and settled", async () => {
    let saved = false;
    const { created, left, registry } = adoptLeftRunning(() => saved);
    // A page holds the new chat before this server has checked it.
    registry.acquire({ threadId: spare.threadId, folder });
    await ticks(30);
    expect(left.status).not.toBe("stopped");
    expect(created).toHaveLength(0);

    // Its first reply: omp saves the chat, and the host says it has settled.
    saved = true;
    left.emitEvent({ type: "session_settled" });
    await ticks(30);
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual(["--resume", spare.sessionFile]);
    expect(left.status).toBe("stopped");
  });
});

describe("the chat session runtime: a new chat kept ready (#2760)", () => {
  /** A folder shown with new chats kept ready, the refresh's timer driven by the test. */
  async function readyInFolder() {
    const created: FakeChatHost[] = [];
    const timer = firingTimer();
    const handlers = handlersFor({ ...context(created), newChatsReady: true, spareTimer: timer });
    await getHandler(handlers, "prepareNew")({ folderPath: folder }, call("one"));
    await ticks(20);
    return { created, timer, handlers };
  }

  test("is replaced by a fresh one before it ages out, and the next new chat opens on the fresh one (#2768)", async () => {
    const { created, timer, handlers } = await readyInFolder();
    expect(created).toHaveLength(1);
    expect(timer.pending()).toBe(1);

    timer.fireAll();
    await ticks(30);
    expect(created).toHaveLength(2);
    expect(created[0]?.status).toBe("stopped");
    expect(created[1]?.status).toBe("running");
    expect(timer.pending()).toBe(1);

    // The open takes the fresh one, so no omp starts for it; only the next ready chat does.
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await ticks(20);
    expect(created).toHaveLength(3);
    expect(created[1]?.status).toBe("running");
    expect(created[2]?.status).toBe("running");
  });

  test("one taken before its refresh is due is not replaced: its refresh is dropped", async () => {
    const { created, timer, handlers } = await readyInFolder();
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    await ticks(20);
    // The taken one's refresh is cleared; the next ready chat's is the one due.
    expect(created).toHaveLength(2);
    expect(timer.pending()).toBe(1);
    timer.fireAll();
    await ticks(30);
    expect(created).toHaveLength(3);
    expect(created[0]?.status).toBe("running");
    expect(created[1]?.status).toBe("stopped");
    expect(created[2]?.status).toBe("running");
  });
});

describe("the chat session runtime: the app's own continue after a usage limit (#2781)", () => {
  const scratch = join(globalThis.process.cwd(), ".data", `usage-resume-${crypto.randomUUID()}`);
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** A runtime whose continues run on a clock and a timer the test moves; `idleCloseMs` stops unwatched chats. */
  function continuing(created: FakeChatHost[], idleCloseMs?: number) {
    const timer = firingTimer();
    const clock = { now: 1_790_000_000_000 };
    const runtimeContext: A0PortContext = {
      ...context(created),
      ...(idleCloseMs === undefined
        ? {}
        : {
            processRegistry: new OmpProcessRegistry({
              idleCloseMs,
              createProcess: fakeHost(created),
            }),
          }),
      usageResumeFile: join(scratch, crypto.randomUUID(), "usage-resume.json"),
      usageResumeClock: { now: () => clock.now, timer },
    };
    const runtime = createA0Runtime(runtimeContext);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet;
    return { runtimeContext, runtime, handlers, timer, clock };
  }

  /** omp's events for a turn a usage limit refused: its retry says it waits `waitMs`, then gives up at once. */
  function refusedTurn(host: FakeChatHost, waitMs: number): void {
    host.emitEvent({ type: "agent_start" });
    host.emitEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: waitMs,
      errorMessage: "429 rate_limit_error",
    });
    host.emitEvent({ type: "auto_retry_end", success: false, attempt: 1, finalError: "429" });
    host.emitEvent({ type: "agent_end", messages: [] });
    host.emitEvent({ type: "session_settled" });
  }

  test("a chat a usage limit stopped is retried as its Retry does once the wait is over, and the list hears when", async () => {
    const created: FakeChatHost[] = [];
    const { runtimeContext, runtime, handlers, timer, clock } = continuing(created);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const host = created[0];
    if (host === undefined) throw new Error("missing fake host");
    const heard: unknown[] = [];
    const stop = runtime.continuing.onContinueChange((id, where, at) =>
      heard.push([id, where, at]),
    );

    refusedTurn(host, 9_385_000);
    await ticks();
    const due = clock.now + 9_385_000 + 60_000;
    expect(runtime.continuing.continuingIn(folder)).toEqual([
      { id: authorityThread, continuesAt: due },
    ]);
    expect(heard).toEqual([[authorityThread, folder, due]]);
    expect(paramsOf(host, "prompt")).toEqual([]);

    timer.fireAll();
    await ticks();
    expect(paramsOf(host, "prompt")).toEqual([{ text: "/retry" }]);
    expect(runtime.continuing.continuingIn(folder)).toEqual([]);
    expect(heard.at(-1)).toEqual([authorityThread, folder, null]);
    stop();
    await runtimeContext.processRegistry.closeAll();
  });

  test("Stop and Don't continue drop it, and a paused chat is not retried", async () => {
    const created: FakeChatHost[] = [];
    const { runtimeContext, runtime, handlers, timer } = continuing(created);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const host = created[0];
    if (host === undefined) throw new Error("missing fake host");
    const due = () => runtime.continuing.continuingIn(folder).length;

    refusedTurn(host, 3_600_000);
    await ticks();
    expect(due()).toBe(1);
    await getHandler(handlers, "request")(request(authorityThread, "abort"), call("one"));
    expect(due()).toBe(0);

    refusedTurn(host, 3_600_000);
    await ticks();
    expect(due()).toBe(1);
    await getHandler(handlers, "cancelContinue")({ threadId: authorityThread }, call("one"));
    expect(due()).toBe(0);

    refusedTurn(host, 3_600_000);
    host.emitEvent({ type: "pause_changed", pausedAt: 1_000 });
    await ticks();
    timer.fireAll();
    await ticks();
    expect(paramsOf(host, "prompt")).toEqual([]);
    await runtimeContext.processRegistry.closeAll();
  });

  test("a chat waiting to be continued keeps its omp with nobody watching it", async () => {
    const created: FakeChatHost[] = [];
    const { runtimeContext, runtime, handlers } = continuing(created, 20);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const host = created[0];
    if (host === undefined) throw new Error("missing fake host");
    refusedTurn(host, 3_600_000);
    await ticks();

    await runtime.views.releaseViews(authorityThread, "one");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await ticks();
    // Still held: `busyOf` is undefined once the registry stopped the chat's omp.
    expect(runtimeContext.processRegistry.busyOf(authorityThread)).toBe(false);
    await runtimeContext.processRegistry.closeAll();
  });

  test("a refusal while a background job keeps the session unsettled is still retried once due: the host says no turn runs", async () => {
    const created: FakeChatHost[] = [];
    const { runtimeContext, handlers, timer } = continuing(created);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const host = created[0];
    if (host === undefined) throw new Error("missing fake host");
    // As on 2026-11-01 at 18:32: a job runs on, so omp never reports the session settled after the refused turn.
    host.emitEvent({ type: "agent_start" });
    host.emitEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 3_600_000,
      errorMessage: "429 rate_limit_error",
    });
    host.emitEvent({ type: "auto_retry_end", success: false, attempt: 1, finalError: "429" });
    host.emitEvent({ type: "agent_end", messages: [] });
    await ticks();
    expect(runtimeContext.processRegistry.busyOf(authorityThread)).toBe(true);

    timer.fireAll();
    await ticks();
    expect(paramsOf(host, "prompt")).toEqual([{ text: "/retry" }]);
    await runtimeContext.processRegistry.closeAll();
  });

  test("a turn running when it comes due is looked at again a minute later, and retried once none runs", async () => {
    const created: FakeChatHost[] = [];
    const { runtimeContext, runtime, handlers, timer } = continuing(created);
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const host = created[0];
    if (host === undefined) throw new Error("missing fake host");
    refusedTurn(host, 3_600_000);
    await ticks();

    host.extraState = { ...host.extraState, isStreaming: true };
    timer.fireAll();
    await ticks();
    expect(paramsOf(host, "prompt")).toEqual([]);
    expect(runtime.continuing.continuingIn(folder)).toHaveLength(1);

    host.extraState = { ...host.extraState, isStreaming: false };
    timer.fireAll();
    await ticks();
    expect(paramsOf(host, "prompt")).toEqual([{ text: "/retry" }]);
    expect(runtime.continuing.continuingIn(folder)).toEqual([]);
    await runtimeContext.processRegistry.closeAll();
  });
});

describe("the chat session runtime: the usage pause (#2781 part 3)", () => {
  const scratch = join(globalThis.process.cwd(), ".data", `usage-pause-${crypto.randomUUID()}`);
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** One provider's 5-hour window at `usedPercent`, resetting at `resetsAt` (epoch ms). */
  function fiveHour(providerId: string, usedPercent: number, resetsAt: number): UsageLimitsResult {
    return {
      state: "ready",
      fetchedAt: new Date(0).toISOString(),
      providers: [
        {
          providerId,
          windows: [
            {
              label: "5 Hour",
              usedPercent,
              resetsAt: new Date(resetsAt).toISOString(),
              accounts: 1,
              durationMs: 5 * 3_600_000,
            },
          ],
        },
      ],
    };
  }

  test("a chat marked through the port pauses at its limit on its model's provider, resumes at the reset, and the list hears each change", async () => {
    const created: FakeChatHost[] = [];
    const timer = firingTimer();
    const clock = { now: 1_790_000_000_000 };
    let read: (result: UsageLimitsResult) => void = () => undefined;
    const runtimeContext: A0PortContext = {
      ...context(created),
      usageResumeClock: { now: () => clock.now, timer },
      usagePauseFile: join(scratch, crypto.randomUUID(), "usage-pause.json"),
      usageLimits: {
        subscribe: (listener) => {
          read = listener;
          return () => {
            read = () => undefined;
          };
        },
      },
    };
    const runtime = createA0Runtime(runtimeContext);
    const handlers = runtime.registrations[0]?.handlers as HandlerSet;
    await getHandler(handlers, "open")({ folderPath: folder, start: "new" }, call("one"));
    const host = created[0];
    if (host === undefined) throw new Error("missing fake host");
    host.extraState = { model: { provider: "anthropic", id: "claude-sonnet" } };
    const heard: unknown[] = [];
    runtime.usagePauses.onUsagePauseChange((id, where, percent, hold) =>
      heard.push([id, where, percent, hold]),
    );

    await getHandler(handlers, "setUsagePause")(
      { threadId: authorityThread, percent: 90 },
      call("one"),
    );
    expect(runtime.usagePauses.usagePausesIn(folder)).toEqual([
      { id: authorityThread, percent: 90, hold: null },
    ]);

    const reset = clock.now + 3_600_000;
    read(fiveHour("anthropic", 89, reset));
    // Another provider past the limit is not this chat's.
    read(fiveHour("openai-codex", 99, reset));
    await ticks();
    expect(paramsOf(host, "pause")).toEqual([]);

    read(fiveHour("anthropic", 91, reset));
    await ticks();
    expect(paramsOf(host, "pause")).toEqual([{}]);
    host.emitEvent({ type: "pause_changed", pausedAt: clock.now });
    await ticks();
    const hold = { providerId: "anthropic", until: reset + 60_000 };
    expect(runtime.usagePauses.usagePausesIn(folder)).toEqual([
      { id: authorityThread, percent: 90, hold },
    ]);

    timer.fireAll();
    await ticks();
    expect(paramsOf(host, "resume")).toEqual([{}]);
    expect(heard).toEqual([
      [authorityThread, folder, 90, null],
      [authorityThread, folder, 90, hold],
      [authorityThread, folder, 90, null],
    ]);
    await runtimeContext.processRegistry.closeAll();
  });

  test("a chat that is not open can't be marked, and says so", async () => {
    const created: FakeChatHost[] = [];
    const runtime = createA0Runtime({
      ...context(created),
      usagePauseFile: join(scratch, crypto.randomUUID(), "usage-pause.json"),
    });
    const handlers = runtime.registrations[0]?.handlers as HandlerSet;
    await expect(
      getHandler(handlers, "setUsagePause")({ threadId: authorityThread, percent: 90 }, call("one")),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
  });
});

import { describe, expect, test } from "bun:test";
import {
  AppFailure,
  FolderPath,
  HostCallId,
  OmpProcessId,
  type OmpProcessId as OmpProcessIdType,
  RequestId,
  SessionFilePath,
  type StreamKey,
  ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import {
  type OmpProcess,
  type OmpProcessEvent,
  type OmpProcessOptions,
  OmpProcessRegistry,
} from "../../process";
import type { PortHandlerContext as ServerPortHandlerContext } from "../../registry/ports";
import { EventReplayHub } from "../../replay";
import { type A0PortContext, createA0PortRegistrations, type ThreadBootstrap } from "./index";

const encoder = new TextEncoder();
const folder = FolderPath.parse("/workspace/a0-7");
const authorityThread = ThreadId.parse("omp-session-a0-7");
const authorityFile = SessionFilePath.parse("/workspace/a0-7/.omp/authoritative.jsonl");
const bootstrap: ThreadBootstrap = {
  threadId: ThreadId.parse("thread-a0-7"),
  folderPath: folder,
  sessionFile: authorityFile,
};

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
    return "";
  }

  start(): Promise<void> {
    this.emitEvent({ status: "running", processId: this.processId });
    this.emit({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864,
    });
    return Promise.resolve();
  }

  async restart(): Promise<void> {
    this.emitEvent({ status: "restarting", processId: this.processId });
    this.emitEvent({ status: "running", processId: this.processId });
  }

  async stop(): Promise<void> {
    this.emitEvent({ status: "stopped", processId: this.processId });
    for (const listener of [...this.#closeListeners]) listener();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  writeLine(line: string): Promise<void> {
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
              : command === "branch"
                ? { text: "", cancelled: false }
                : command === "get_state"
                  ? { sessionId: this.identity.threadId, sessionFile: this.identity.sessionFile }
                  : {};
    this.emit({ type: "response", id: frame.id, command, success: true, data });
    if (command === "branch" && this.nextIdentity !== undefined) this.identity = this.nextIdentity;
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
function call(connectionId: string): ServerPortHandlerContext {
  return {
    signal: new AbortController().signal,
    connectionId,
    requestId: RequestId.parse(`call-${connectionId}`),
    portContext: undefined,
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

  test("rekeys after branch and keeps the old id as an alias", async () => {
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
});

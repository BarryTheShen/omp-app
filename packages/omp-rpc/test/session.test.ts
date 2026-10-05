import { describe, expect, test } from "bun:test";
import { AppFailure, HostCallId, type RpcSessionEvent, UiRequestId } from "@omp-app/contracts";
import { type RpcDuplex, RpcSession, type RpcSessionTimer } from "../src/session";

const encoder = new TextEncoder();
const uiId = UiRequestId.parse("ui-1");
const hostId = HostCallId.parse("host-1");
const uriId = HostCallId.parse("uri-1");

type Frame = Record<string, unknown>;

class FakeDuplex implements RpcDuplex {
  readonly writes: string[] = [];
  #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  #closeListeners = new Set<(cause?: unknown) => void>();

  writeLine(line: string): void {
    this.writes.push(line);
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    return () => this.#chunkListeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  emit(frame: Frame): void {
    const bytes = encoder.encode(`${JSON.stringify(frame)}\n`);
    for (const listener of [...this.#chunkListeners]) listener(bytes);
  }

  closeFromPeer(cause?: unknown): void {
    for (const listener of [...this.#closeListeners]) listener(cause);
  }
}

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

function writeAt(duplex: FakeDuplex, index: number): Frame {
  const line = duplex.writes[index];
  if (line === undefined) throw new Error(`missing write ${index}`);
  return JSON.parse(line) as Frame;
}

function lastWrite(duplex: FakeDuplex): Frame {
  return writeAt(duplex, duplex.writes.length - 1);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function readySession(
  duplex: FakeDuplex,
  timer: ManualTimer,
  supportsV2 = false,
): Promise<RpcSession> {
  const session = new RpcSession(duplex, { timer });
  const start = session.start();
  duplex.emit({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: supportsV2 ? [1, 2] : [1],
    maxFrameBytes: 1024 * 1024,
    maxReassembledFrameBytes: 64 * 1024 * 1024,
  });
  await flush();
  if (supportsV2) {
    const negotiate = lastWrite(duplex);
    expect(negotiate.type).toBe("negotiate_protocol");
    duplex.emit({
      type: "response",
      id: negotiate.id,
      command: "negotiate_protocol",
      success: true,
      data: { protocolVersion: 2 },
    });
  }
  await start;
  return session;
}

describe("RpcSession startup and command correlation", () => {
  test("emits process lifecycle, negotiates v2, and correlates out-of-order responses", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const events: RpcSessionEvent[] = [];
    const session = new RpcSession(duplex, { timer });
    session.onEvent((event) => events.push(event));
    const start = session.start();
    duplex.emit({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1024 * 1024,
      maxReassembledFrameBytes: 64 * 1024 * 1024,
    });
    await flush();
    const negotiation = lastWrite(duplex);
    expect(negotiation).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 });
    duplex.emit({
      type: "response",
      id: negotiation.id,
      command: "negotiate_protocol",
      success: true,
      data: { protocolVersion: 2 },
    });
    await start;
    expect(session.protocolVersion).toBe(2);

    const bash = session.send({ type: "bash", command: "printf one" });
    const state = session.send({ type: "get_state" });
    await flush();
    const bashCommand = writeAt(duplex, 1);
    const stateCommand = writeAt(duplex, 2);
    duplex.emit({
      type: "response",
      id: stateCommand.id,
      command: "get_state",
      success: true,
      data: { sessionId: "session-1", isStreaming: false },
    });
    duplex.emit({
      type: "response",
      id: bashCommand.id,
      command: "bash",
      success: true,
      data: {
        output: "one",
        cancelled: false,
        truncated: false,
        totalLines: 1,
        totalBytes: 3,
        outputLines: 1,
        outputBytes: 3,
        exitCode: 0,
      },
    });
    const stateResult = await state;
    const bashResult = await bash;
    expect(stateResult).toMatchObject({ sessionId: "session-1", isStreaming: false });
    expect(bashResult).toMatchObject({ output: "one", exitCode: 0 });
    expect(events.map((event) => event.kind)).toEqual(["process", "process"]);
  });

  test("honors schema timeouts, leaves null-timeout commands running, and rejects omp failures", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);
    const prompt = session.send({ type: "prompt", message: "long-running" });
    await flush();
    expect(timer.callbacks.size).toBe(0);
    const promptCommand = lastWrite(duplex);
    duplex.emit({
      type: "response",
      id: promptCommand.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    duplex.emit({
      type: "prompt_result",
      id: promptCommand.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: false,
    });
    await expect(prompt).resolves.toEqual({ agentInvoked: true });

    const login = session.send({ type: "login", providerId: "provider" });
    await flush();
    expect(timer.callbacks.size).toBe(1);
    timer.fireAll();
    await expect(login).rejects.toBeInstanceOf(AppFailure);

    const failure = session.send({ type: "set_fast_mode", enabled: true });
    await flush();
    const command = lastWrite(duplex);
    duplex.emit({
      type: "response",
      id: command.id,
      command: "set_fast_mode",
      success: false,
      error: "not available",
      code: "unsupported",
    });
    try {
      await failure;
      throw new Error("expected command failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFailure);
      expect((error as AppFailure).appError).toMatchObject({ code: "omp_error", retryable: false });
    }
  });
});

describe("RpcSession prompt completion and event separation", () => {
  test("waits for prompt_result while keeping session_settled separate", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);
    const events: RpcSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    const prompt = session.send({ type: "prompt", message: "hello" });
    await flush();
    const command = lastWrite(duplex);
    duplex.emit({
      type: "response",
      id: command.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    await expect(prompt.admitted).resolves.toEqual({ agentInvoked: true });
    await flush();
    let resolved = false;
    void prompt.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);

    duplex.emit({
      type: "prompt_result",
      id: command.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: false,
    });
    await expect(prompt).resolves.toEqual({ agentInvoked: true });
    duplex.emit({ type: "session_settled" });
    expect(events.map((event) => event.kind)).toEqual(["prompt_result", "session_settled"]);
  });

  test("resolves locally completed prompts without waiting for prompt_result", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);
    const prompt = session.send({ type: "prompt", message: "/local" });
    await flush();
    const command = lastWrite(duplex);
    duplex.emit({
      type: "response",
      id: command.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    await expect(prompt.admitted).resolves.toEqual({ agentInvoked: false });
    await expect(prompt).resolves.toEqual({ agentInvoked: false });
  });
  test("settles abort_and_prompt after a prompt_result that arrives before its response", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);
    const prompt = session.send({ type: "abort_and_prompt", message: "replace" });
    await flush();
    const command = lastWrite(duplex);
    duplex.emit({
      type: "prompt_result",
      id: command.id,
      agentInvoked: true,
      status: "aborted",
      sessionSettled: false,
    });
    duplex.emit({
      type: "response",
      id: command.id,
      command: "abort_and_prompt",
      success: true,
      data: undefined,
    });
    await expect(prompt.admitted).resolves.toBeUndefined();
    await expect(prompt).resolves.toBeUndefined();
  });
});

describe("RpcSession UI and host request correlation", () => {
  test("forwards and answers extension UI, host tool, and host URI requests", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);
    const requests: Array<Record<string, unknown>> = [];
    const notifications: RpcSessionEvent[] = [];
    session.onRequest((request) => requests.push(request as unknown as Record<string, unknown>));
    session.onEvent((event) => notifications.push(event));

    duplex.emit({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Continue?",
      message: "Continue?",
    });
    await session.answerExtensionUi({ type: "extension_ui_response", id: uiId, confirmed: true });
    expect(lastWrite(duplex)).toEqual({
      type: "extension_ui_response",
      id: "ui-1",
      confirmed: true,
    });

    duplex.emit({
      type: "host_tool_call",
      id: "host-1",
      toolCallId: "tool-1",
      toolName: "echo",
      arguments: { value: "x" },
    });
    await session.answerHostTool({
      type: "host_tool_update",
      id: hostId,
      partialResult: { content: [] },
    });
    await session.answerHostTool({
      type: "host_tool_result",
      id: hostId,
      result: { content: [] },
    });

    duplex.emit({
      type: "host_uri_request",
      id: "uri-1",
      operation: "read",
      url: "db://row/1",
    });
    await session.answerHostUri({
      type: "host_uri_result",
      id: uriId,
      content: "value",
      contentType: "text/plain",
    });

    expect(requests.map((request) => request.type)).toEqual([
      "extension_ui_request",
      "host_tool_call",
      "host_uri_request",
    ]);
    expect(
      notifications.map((event) => (event.kind === "notification" ? event.frame.type : event.kind)),
    ).toEqual(["extension_ui_request", "host_tool_call", "host_uri_request"]);
    await expect(
      session.answerExtensionUi({ type: "extension_ui_response", id: uiId, confirmed: true }),
    ).rejects.toBeInstanceOf(AppFailure);
  });
});

describe("RpcSession event controls", () => {
  test("correlates subagent subscription and event-filter commands", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);

    const subscription = session.setSubagentSubscription("events");
    await flush();
    const subscriptionCommand = lastWrite(duplex);
    duplex.emit({
      type: "response",
      id: subscriptionCommand.id,
      command: "set_subagent_subscription",
      success: true,
      data: { level: "events" },
    });
    await expect(subscription).resolves.toEqual({ level: "events" });

    const filter = session.setEventFilter(["message_update"], "delta");
    await flush();
    const filterCommand = lastWrite(duplex);
    duplex.emit({
      type: "response",
      id: filterCommand.id,
      command: "set_event_filter",
      success: true,
      data: { events: ["message_update"], messageUpdates: "delta" },
    });
    await expect(filter).resolves.toEqual({ events: ["message_update"], messageUpdates: "delta" });
  });
});

describe("RpcSession shutdown", () => {
  test("rejects pending commands and reports process exit without leaking the close cause", async () => {
    const duplex = new FakeDuplex();
    const timer = new ManualTimer();
    const session = await readySession(duplex, timer);
    const events: RpcSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    const pending = session.send({ type: "get_state" });
    duplex.closeFromPeer(new Error("secret path /home/user/private"));

    try {
      await pending;
      throw new Error("expected close failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFailure);
      expect((error as AppFailure).appError).toMatchObject({ code: "omp_exited" });
      expect(JSON.stringify((error as AppFailure).appError)).not.toContain("/home/user/private");
    }
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toMatchObject({ kind: "process", status: "exited" });
  });
});

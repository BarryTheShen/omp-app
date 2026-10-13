import { describe, expect, test } from "bun:test";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { type RpcDuplex, RpcSession, type RpcSessionTimer } from "@omp-app/omp-rpc";
import {
  type CommandParserContext,
  createOmpCommandGateway,
  OmpCommandGatewayService,
} from "./gateway";

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
    const bytes = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
    for (const listener of [...this.#chunkListeners]) listener(bytes);
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
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

function writesAfter(duplex: FakeDuplex, index: number): Frame[] {
  return duplex.writes.slice(index).map((line) => JSON.parse(line) as Frame);
}

async function readySession(duplex: FakeDuplex, timer: ManualTimer): Promise<RpcSession> {
  const session = new RpcSession(duplex, { timer });
  const start = session.start();
  duplex.emit({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1],
    maxFrameBytes: 1024 * 1024,
    maxReassembledFrameBytes: 64 * 1024 * 1024,
  });
  await start;
  return session;
}

const threadId = ThreadId.parse("thread-1");

function availableCommandsResponse(id: string, names: string[]): Frame {
  return {
    type: "response",
    id,
    command: "get_available_commands",
    success: true,
    data: { commands: names.map((name) => ({ name, source: "builtin" })) },
  };
}

interface Harness {
  readonly duplex: FakeDuplex;
  readonly timer: ManualTimer;
  readonly session: RpcSession;
  readonly gateway: OmpCommandGatewayService;
  readonly errors: AppFailure[];
}

async function createHarness(): Promise<Harness> {
  const duplex = new FakeDuplex();
  const timer = new ManualTimer();
  const session = await readySession(duplex, timer);
  const errors: AppFailure[] = [];
  const gateway = new OmpCommandGatewayService({
    resolveSession: () => session,
    onError: (error) => errors.push(error),
  });
  return { duplex, timer, session, gateway, errors };
}

async function answerAvailability(
  duplex: FakeDuplex,
  fromIndex: number,
  names: string[],
): Promise<number> {
  await flush();
  const writes = writesAfter(duplex, fromIndex);
  const availabilityWrite = writes[0];
  if (availabilityWrite?.type !== "get_available_commands") {
    throw new Error(
      `expected a get_available_commands write, got ${JSON.stringify(availabilityWrite)}`,
    );
  }
  duplex.emit(availableCommandsResponse(availabilityWrite.id as string, names));
  await flush();
  return fromIndex + 1;
}

describe("OmpCommandGatewayService", () => {
  test("resolves only at prompt_result settlement, not at admission", async () => {
    const { duplex, gateway } = await createHarness();
    const future = gateway.run({ threadId, command: "/compact" });
    const afterAvailability = await answerAvailability(duplex, 0, ["compact"]);

    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    await flush();
    await expect(future.admitted).resolves.toEqual({ agentInvoked: true });

    let settled = false;
    void future.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    duplex.emit({
      type: "prompt_result",
      id: promptWrite.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: false,
    });
    const result = await future;
    expect(settled).toBe(true);
    expect(result).toMatchObject({
      command: "/compact",
      status: "completed",
      agentInvoked: true,
      promptSettled: false,
      sessionSettled: false,
      outputs: [],
      sessionUpdates: [],
      configUpdates: [],
    });
  });

  test("a prompt response without data (omp's real reply to an idle /fresh) completes and crashes nothing", async () => {
    // Captured from omp 18.7.0 (`prompt "/fresh"` on an idle session over `--mode rpc-ui`): the
    // response is `{success: true}` with no `data`, then a prompt_result marked aborted.
    // omp 18.6.1 sends the same data-less response for every normally admitted prompt
    // (rpc-mode.ts: `return success(id, "prompt")`). The server used to read `ack.agentInvoked`
    // from the missing object inside a promise callback, an unhandled rejection that killed the
    // whole server and every open session with it.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { duplex, gateway } = await createHarness();
      const future = gateway.run({ threadId, command: "/fresh" });
      const afterAvailability = await answerAvailability(duplex, 0, ["fresh"]);
      const promptWrite = writesAfter(duplex, afterAvailability)[0];
      if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
      duplex.emit({
        type: "command_output",
        text: "Fresh provider session started (0 provider states pruned).",
      });
      duplex.emit({ type: "response", id: promptWrite.id, command: "prompt", success: true });
      await flush();
      await expect(future.admitted).resolves.toEqual({ agentInvoked: true });
      duplex.emit({
        type: "prompt_result",
        id: promptWrite.id,
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      });
      const result = await future;
      expect(result).toMatchObject({
        command: "/fresh",
        agentInvoked: true,
        outputs: [{ text: "Fresh provider session started (0 provider states pruned)." }],
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("correlates command_output/session_info_update/config_update and ignores interleaved frames", async () => {
    const { duplex, gateway } = await createHarness();
    const future = gateway.run({ threadId, command: "/compact" });
    const afterAvailability = await answerAvailability(duplex, 0, ["compact"]);
    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    await flush();

    const liveOutputs: unknown[] = [];
    gateway.onOutput((event) => liveOutputs.push(event));

    duplex.emit({ type: "command_output", text: "Compacting…" });
    duplex.emit({ type: "notice", level: "info", message: "unrelated" });
    duplex.emit({ type: "session_info_update", sessionId: threadId, title: "Compacted session" });
    duplex.emit({ type: "config_update", thinkingLevel: "low" });
    duplex.emit({ type: "command_output", text: "Done." });
    await flush();

    duplex.emit({
      type: "prompt_result",
      id: promptWrite.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    });
    const result = await future;

    expect(result.outputs.map((output) => output.text)).toEqual(["Compacting…", "Done."]);
    expect(result.sessionUpdates).toEqual([{ sessionId: threadId, title: "Compacted session" }]);
    expect(result.configUpdates).toEqual([{ thinkingLevel: "low" }]);
    expect(result.promptSettled).toBe(true);
    expect(liveOutputs).toEqual([
      { threadId, output: { text: "Compacting…" } },
      { threadId, output: { text: "Done." } },
    ]);
  });

  test("runs a second command for the same thread only after the first settles", async () => {
    const { duplex, gateway } = await createHarness();
    const first = gateway.run({ threadId, command: "/compact" });
    const afterFirstAvailability = await answerAvailability(duplex, 0, ["compact", "model"]);
    const firstPromptWrite = writesAfter(duplex, afterFirstAvailability)[0];
    if (firstPromptWrite?.type !== "prompt") throw new Error("expected the first prompt write");
    duplex.emit({
      type: "response",
      id: firstPromptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    await flush();

    const second = gateway.run({ threadId, command: "/model" });
    await flush();
    expect(writesAfter(duplex, afterFirstAvailability + 1)).toEqual([]);

    duplex.emit({
      type: "prompt_result",
      id: firstPromptWrite.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    });
    await first;

    const afterSecondAvailability = await answerAvailability(duplex, afterFirstAvailability + 1, [
      "compact",
      "model",
    ]);
    const secondPromptWrite = writesAfter(duplex, afterSecondAvailability)[0];
    if (secondPromptWrite?.type !== "prompt") throw new Error("expected the second prompt write");
    expect(secondPromptWrite.message).toBe("/model");
    duplex.emit({
      type: "response",
      id: secondPromptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    const secondResult = await second;
    expect(secondResult).toMatchObject({
      command: "/model",
      agentInvoked: false,
      promptSettled: true,
    });
  });

  test("an unrecognized command returns its raw correlated frames as data", async () => {
    const { duplex, gateway } = await createHarness();
    const future = gateway.runWithParser({ threadId, command: "/model gpt-5" });
    const afterAvailability = await answerAvailability(duplex, 0, ["model"]);
    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    const { result, data } = await future;
    expect(result.command).toBe("/model gpt-5");
    const raw = data as CommandParserContext;
    expect(raw.outputs).toEqual([]);
    expect(raw.sessionUpdates).toEqual([]);
    expect(raw.configUpdates).toEqual([]);
  });

  test("an unavailable command fails before its prompt is sent", async () => {
    const { duplex, gateway } = await createHarness();
    const run = gateway.run({ threadId, command: "/not-a-real-command" });
    await answerAvailability(duplex, 0, ["compact"]);
    let rejection: unknown;
    try {
      await run;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError.code).toBe("unavailable");
    const writes = writesAfter(duplex, 0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.type).toBe("get_available_commands");
  });

  test("a colon form is checked by the name omp reads, and omp gets the text as typed", async () => {
    const { duplex, gateway } = await createHarness();
    const future = gateway.run({ threadId, command: "/force:read summarize" });
    const afterAvailability = await answerAvailability(duplex, 0, ["force"]);
    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    expect(promptWrite).toMatchObject({ type: "prompt", message: "/force:read summarize" });
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    await expect(future).resolves.toMatchObject({ command: "/force:read summarize" });
  });

  test("a colon name omp does not list is unavailable, and nothing is sent", async () => {
    const { duplex, gateway } = await createHarness();
    const run = gateway.run({ threadId, command: "/nosuch:read summarize" });
    await answerAvailability(duplex, 0, ["force"]);
    let rejection: unknown;
    try {
      await run;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError.code).toBe("unavailable");
    expect(writesAfter(duplex, 0)).toHaveLength(1);
  });

  test("cancels a running command and rejects with AppFailure cancelled", async () => {
    const { duplex, gateway } = await createHarness();
    const controller = new AbortController();
    const future = gateway.run({ threadId, command: "/compact" }, { signal: controller.signal });
    const afterAvailability = await answerAvailability(duplex, 0, ["compact"]);
    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    await flush();

    controller.abort();
    let rejection: unknown;
    try {
      await future;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError.code).toBe("cancelled");
  });

  test("propagates an omp prompt error as AppFailure omp_error", async () => {
    const { duplex, gateway } = await createHarness();
    const future = gateway.run({ threadId, command: "/compact" });
    const afterAvailability = await answerAvailability(duplex, 0, ["compact"]);
    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    await flush();
    duplex.emit({
      type: "prompt_result",
      id: promptWrite.id,
      agentInvoked: true,
      status: "error",
      sessionSettled: true,
      error: { message: "model unavailable", retryable: true },
    });
    let rejection: unknown;
    try {
      await future;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError).toMatchObject({
      code: "omp_error",
      retryable: true,
    });
  });

  test("a parser that throws is reported and rejects without crashing", async () => {
    const { duplex, gateway, errors } = await createHarness();
    gateway.registerCommandParser("compact", () => {
      throw new Error("parser exploded");
    });
    const future = gateway.runWithParser({ threadId, command: "/compact" });
    const afterAvailability = await answerAvailability(duplex, 0, ["compact"]);
    const promptWrite = writesAfter(duplex, afterAvailability)[0];
    if (promptWrite?.type !== "prompt") throw new Error("expected a prompt write");
    duplex.emit({
      type: "response",
      id: promptWrite.id,
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    let rejection: unknown;
    try {
      await future;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError).toMatchObject({
      code: "internal",
      retryable: false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.appError.code).toBe("internal");
  });

  test("rejects a duplicate parser registration for the same command name", () => {
    const gateway = new OmpCommandGatewayService({
      resolveSession: () => {
        throw new Error("not used in this test");
      },
    });
    gateway.registerCommandParser("compact", () => "first");
    expect(() => gateway.registerCommandParser("compact", () => "second")).toThrow(
      /Duplicate command parser registration/,
    );
  });

  test("the app's gateway already has the typed /share and /dump parsers registered", () => {
    const gateway = createOmpCommandGateway({
      resolveSession: () => {
        throw new Error("not used in this test");
      },
    });
    expect(() => gateway.registerCommandParser("share", () => "again")).toThrow(
      /Duplicate command parser registration for share/,
    );
    expect(() => gateway.registerCommandParser("dump", () => "again")).toThrow(
      /Duplicate command parser registration for dump/,
    );
  });
});

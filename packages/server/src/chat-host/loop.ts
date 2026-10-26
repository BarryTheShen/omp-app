/**
 * The chat host's loop (SDK plan H5.1): reads the server's requests, answers each with exactly one response, and writes
 * the session's events, all in order through the stdout writer. It starts with `hello`.
 *
 * Ordering follows omp's own protocol loop (18.12.6 `modes/rpc/rpc-mode.ts:416-566`):
 * - a prompt runs in the background, so a later abort or state read is answered while it is still being admitted;
 * - prompts are admitted in the order they were read, and an abort invalidates every prompt read before it that has
 *   not started;
 * - other requests are answered one at a time, in the order they were read.
 */
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
  CHAT_HOST_METHODS,
  CHAT_HOST_PROTOCOL_VERSION,
  type ChatHostErrorCode,
  type ChatHostHello,
  type ChatHostMethodMap,
  type ChatHostState,
  isChatHostMethod,
  type PromptAnswer,
  type PromptParams,
  parseChatHostParams,
  parseServerLine,
} from "@omp-app/contracts/chat-host";
import { type ChatEvent, SessionEventStream } from "./events";
import { InputGate } from "./input";
import type { LineWriter } from "./output";
import {
  ExtensionMessageTracker,
  PromptResults,
  type PromptTicket,
  startPrompt,
} from "./prompt-results";
import type { ChatSession } from "./session-factory";

export interface ChatLoopOptions {
  readonly chat: ChatSession;
  /** The server's lines, in order; the loop ends when they end. */
  readonly lines: AsyncIterable<string>;
  readonly writer: LineWriter;
  readonly ompVersion: string;
  /** Diagnostics for the server's stderr tail. */
  readonly log: (message: string) => void;
  /** Ends the server's lines: an extension asked the chat to shut down. */
  readonly stopInput: () => void;
}

/** Runs the chat until the server's lines end (or an extension shuts the chat down). */
export async function runChatLoop(options: ChatLoopOptions): Promise<void> {
  const { chat, writer, log } = options;
  const { session } = chat;
  let seq = 0;
  let shutdownRequested = false;

  const writeMessage = (message: object): boolean => {
    let text: string;
    try {
      text = JSON.stringify(message);
    } catch (error) {
      log(`chat host: a message could not be written: ${errorMessage(error)}`);
      return false;
    }
    writer.write(text);
    return true;
  };
  const emit = (event: ChatEvent): void => {
    if (writeMessage({ kind: "event", seq: seq + 1, event })) seq++;
  };
  const respond = (id: string, result: unknown): void => {
    writeMessage({ kind: "response", id, ok: true, result });
  };
  const respondError = (id: string, code: ChatHostErrorCode, message: string): void => {
    writeMessage({ kind: "response", id, ok: false, error: { code, message } });
  };

  const events = new SessionEventStream(emit);
  const results = new PromptResults(session, emit);
  const tracker = new ExtensionMessageTracker();
  const gate = new InputGate();

  const hello: ChatHostHello = {
    kind: "hello",
    protocol: CHAT_HOST_PROTOCOL_VERSION,
    ompVersion: options.ompVersion,
    methods: [...CHAT_HOST_METHODS],
    session: {
      id: session.sessionId,
      file: session.sessionFile ?? null,
      cwd: session.sessionManager.getCwd(),
    },
  };
  writeMessage(hello);

  await initializeExtensions(session, {
    mode: "rpc",
    reportSendError: (action, error) =>
      emit({
        type: "notice",
        level: "error",
        message: `${action}: ${error.message}`,
        source: "extension",
      }),
    reportRuntimeError: (error) =>
      emit({
        type: "notice",
        level: "error",
        message: `${error.extensionPath} (${error.event}): ${error.error}`,
        source: "extension",
      }),
    onShutdown: () => {
      shutdownRequested = true;
      options.stopInput();
    },
    trackAgentInvokingMessage: (task) => tracker.track(task),
    wrapSessionChange: async (change, { detachesRun }) => {
      const result = await change();
      if (!result.cancelled && detachesRun) results.abortOpen();
      return result;
    },
  });
  session.subscribe((event) => {
    events.forward(event);
    results.observe(event);
  });

  const handlers: {
    readonly [M in Exclude<keyof ChatHostMethodMap, "prompt">]: (
      params: ChatHostMethodMap[M]["params"],
    ) => Promise<ChatHostMethodMap[M]["result"]>;
  } = {
    abort: async () => {
      await session.abort({ reason: USER_INTERRUPT_LABEL });
      return {};
    },
    get_state: async () => readState(session),
    set_event_options: async (params) => events.setOptions(params),
  };

  const runPrompt = async (id: string, params: PromptParams, sequence: number): Promise<void> => {
    const ticket = results.begin(id);
    const sessionId = session.sessionId;
    const isCurrent = (): boolean =>
      gate.isCurrent(sequence) && !shutdownRequested && session.sessionId === sessionId;
    try {
      const outcome = await gate.enqueue(() => admitPrompt(session, params, ticket, isCurrent));
      switch (outcome.kind) {
        case "local":
          results.discard(ticket);
          respond(id, { resultFollows: false } satisfies PromptAnswer);
          return;
        case "cancelled":
          // Reported as aborted: nothing ran for it.
          results.settle(ticket);
          respond(id, { resultFollows: true } satisfies PromptAnswer);
          return;
        case "admitted":
          respond(id, { resultFollows: true } satisfies PromptAnswer);
          return;
        case "failed":
          results.discard(ticket);
          respondError(id, "failed", outcome.error.message);
          return;
      }
    } catch (error) {
      results.discard(ticket);
      respondError(id, "failed", errorMessage(error));
    }
  };

  const admitPrompt = async (
    target: AgentSession,
    params: PromptParams,
    ticket: PromptTicket,
    isCurrent: () => boolean,
  ): Promise<PromptOutcome> => {
    if (!isCurrent()) return { kind: "cancelled" };
    let text = params.text;
    let images = params.images;
    const runner = target.extensionRunner;
    if (runner?.hasHandlers("input")) {
      const input = await runner.emitInput(text, images, "rpc");
      if (!isCurrent()) return { kind: "cancelled" };
      if (input.handled) return { kind: "local" };
      if (input.text !== undefined) text = input.text;
      if (input.images !== undefined) images = input.images;
    }
    if (!isCurrent()) return { kind: "cancelled" };
    if (!text.trim() && !images?.length) return { kind: "local" };
    const start = await startPrompt({
      ticket,
      results,
      tracker,
      run: (onPromptAdmitted) =>
        target.prompt(text, {
          images,
          ...(params.streamingBehavior ? { streamingBehavior: params.streamingBehavior } : {}),
          onPromptAdmitted,
        }),
    });
    return start.admitted ? { kind: "admitted" } : { kind: "failed", error: start.error };
  };

  let serial: Promise<void> = Promise.resolve();
  for await (const line of options.lines) {
    if (shutdownRequested) break;
    if (line.trim() === "") continue;
    const parsed = parseServerLine(line);
    if (!parsed.ok) {
      log(`chat host: skipped a line from the server: ${parsed.error.message}`);
      continue;
    }
    const { id, method } = parsed.value;
    if (!isChatHostMethod(method)) {
      respondError(id, "unknown_method", `Unknown method: ${method}`);
      continue;
    }
    if (method === "prompt") {
      const params = parseChatHostParams("prompt", parsed.value.params);
      if (!params.ok) {
        respondError(id, "invalid_params", params.error.message);
        continue;
      }
      void runPrompt(id, params.value, gate.accept("input"));
      continue;
    }
    if (method === "abort") gate.accept("abort");
    const params = parseChatHostParams(method, parsed.value.params);
    if (!params.ok) {
      respondError(id, "invalid_params", params.error.message);
      continue;
    }
    const handler = handlers[method] as (params: unknown) => Promise<unknown>;
    serial = serial.then(async () => {
      try {
        respond(id, await handler(params.value));
      } catch (error) {
        respondError(id, "failed", errorMessage(error));
      }
    });
  }
  await serial;
}

type PromptOutcome =
  | { readonly kind: "local" | "cancelled" | "admitted" }
  | { readonly kind: "failed"; readonly error: Error };

function readState(session: AgentSession): ChatHostState {
  const model = session.model;
  return {
    model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
    thinkingLevel: session.thinkingLevel ?? null,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? null,
    sessionName: session.sessionName ?? null,
    messageCount: session.messages.length,
    queuedMessageCount: session.queuedMessageCount,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

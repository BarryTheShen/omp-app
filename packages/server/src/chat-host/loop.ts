/**
 * The chat host's loop (SDK plan H5.1, H5.2a): reads the server's requests, answers each with exactly one response, and
 * writes the session's events, all in order through the stdout writer. It starts with `hello`.
 *
 * Ordering follows omp's own protocol loop (18.12.6 `modes/rpc/rpc-mode.ts:416-566`):
 * - a prompt runs in the background, so a later abort or state read is answered while it is still being admitted;
 * - prompts are admitted in the order they were read, and an abort invalidates every prompt read before it that has
 *   not started;
 * - `bash` and `python` run in the background too, so the reply can be stopped while a command runs;
 * - other requests are answered one at a time, in the order they were read.
 *
 * A prompt is, in omp's order (`rpc-mode.ts:1764-1878`): an extension's `input` hook, then `/skill:<name>`, then a
 * built-in slash command (omp's own executor, shared with its ACP host), then `session.prompt`.
 */
import {
  clearPluginRootsAndCaches,
  resolveActiveProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
  buildSkillPromptMessage,
  parseSkillInvocation,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { reconnectMcpManagerServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  SKILL_PROMPT_MESSAGE_TYPE,
  USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
  CHAT_HOST_METHODS,
  CHAT_HOST_PROTOCOL_VERSION,
  type ChatHostCommand,
  type ChatHostErrorCode,
  type ChatHostHello,
  type ChatHostMethod,
  type ChatHostMethodMap,
  type ChatHostState,
  type ConfigUpdateEvent,
  isChatHostMethod,
  type PromptAnswer,
  type PromptParams,
  parseChatHostParams,
  parseServerLine,
  type QueuedMessage,
  type ShellRunResult,
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

/** Methods answered as soon as they finish, outside the one-at-a-time order: a long run must not hold up an abort. */
const BACKGROUND_METHODS: ReadonlySet<ChatHostMethod> = new Set(["bash", "python"]);

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
  /** Built-in commands whose work outlives their prompt's answer (`/mcp reauth`'s browser wait): stopped by an abort. */
  const builtinCommands = new Set<AbortController>();
  const abortBuiltinCommands = (): void => {
    for (const controller of builtinCommands) controller.abort(new Error(USER_INTERRUPT_LABEL));
    builtinCommands.clear();
  };

  const listCommands = async (): Promise<readonly ChatHostCommand[]> =>
    await buildAvailableSlashCommands(session);
  const emitAvailableCommands = async (): Promise<void> => {
    emit({ type: "available_commands", commands: await listCommands() });
  };
  const reloadPlugins = async (): Promise<void> => {
    const projectPath = await resolveActiveProjectRegistryPath(session.sessionManager.getCwd());
    clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
    await session.refreshSkillsAndCommands();
    await emitAvailableCommands();
  };

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
  session.subscribeCommandMetadataChanged(() => {
    void emitAvailableCommands().catch((error: unknown) =>
      log(`chat host: the command list could not be read: ${errorMessage(error)}`),
    );
  });
  await emitAvailableCommands();

  const handlers: {
    readonly [M in Exclude<ChatHostMethod, "prompt">]: (
      params: ChatHostMethodMap[M]["params"],
    ) => Promise<ChatHostMethodMap[M]["result"]>;
  } = {
    abort: async () => {
      abortBuiltinCommands();
      await session.abort({ reason: USER_INTERRUPT_LABEL });
      return {};
    },
    get_state: async () => readState(session),
    set_event_options: async (params) => events.setOptions(params),
    remove_queued_message: async ({ message, queue }) => {
      const taken = session.takeQueuedMessage(message, queue);
      return taken ? { removed: true, ...queuedMessage(taken) } : { removed: false };
    },
    promote_queued_message: async ({ message }) => ({
      promoted: session.promoteQueuedMessage(message),
    }),
    abort_and_restore_queue: async () => {
      // As omp's Escape: the queue is taken back before the abort, so neither the stopped run nor the abort's own drain
      // of the queue can send it (`rpc-mode.ts:1963-1972`).
      const restored = session.clearQueue({ forInterrupt: true });
      abortBuiltinCommands();
      await session.abort({ reason: USER_INTERRUPT_LABEL });
      return {
        steering: restored.steering.map(queuedMessage),
        followUp: restored.followUp.map(queuedMessage),
      };
    },
    get_available_commands: async () => ({ commands: await listCommands() }),
    bash: async ({ command, excludeFromContext }) =>
      shellRun(await session.executeBash(command, undefined, { excludeFromContext })),
    python: async ({ code, excludeFromContext }) =>
      shellRun(await session.executePython(code, undefined, { excludeFromContext })),
  };

  const runPrompt = async (id: string, params: PromptParams, sequence: number): Promise<void> => {
    const ticket = results.begin(id);
    const sessionId = session.sessionId;
    const isCurrent = (): boolean =>
      gate.isCurrent(sequence) && !shutdownRequested && session.sessionId === sessionId;
    try {
      const outcome = await gate.enqueue(() => admitPrompt(params, ticket, isCurrent));
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

  /** The runtime omp's built-in commands run with: their output and changes become events. */
  const builtinRuntime = (
    signal: AbortSignal,
    onBackground: (task: () => Promise<void>) => void,
  ): SlashCommandRuntime => ({
    session,
    sessionManager: session.sessionManager,
    settings: session.settings,
    cwd: session.sessionManager.getCwd(),
    signal,
    output: (text) => emit({ type: "command_output", text }),
    refreshCommands: emitAvailableCommands,
    reloadPlugins,
    mcpManager: chat.mcpManager,
    reconnectMcpServer: chat.mcpManager
      ? async (name, selected) => {
          const manager = chat.mcpManager;
          if (!manager) return undefined;
          const state = await reconnectMcpManagerServer(manager, name, selected);
          // No tools-changed callback is wired here: refresh the session's tools so later prompts see the server.
          if (state) await session.refreshMCPTools(manager.getTools());
          return state;
        }
      : undefined,
    runCommandInBackground: onBackground,
    notifyTitleChanged: () =>
      emit({
        type: "session_info_update",
        sessionId: session.sessionId,
        title: session.sessionName ?? null,
      }),
    notifyConfigChanged: () => emit(configUpdate(session)),
  });

  const admitPrompt = async (
    params: PromptParams,
    ticket: PromptTicket,
    isCurrent: () => boolean,
  ): Promise<PromptOutcome> => {
    if (!isCurrent()) return { kind: "cancelled" };
    let text = params.text;
    let images = params.images;
    const runner = session.extensionRunner;
    if (runner?.hasHandlers("input")) {
      const input = await runner.emitInput(text, images, "rpc");
      if (!isCurrent()) return { kind: "cancelled" };
      if (input.handled) return { kind: "local" };
      if (input.text !== undefined) text = input.text;
      if (input.images !== undefined) images = input.images;
    }
    if (!isCurrent()) return { kind: "cancelled" };
    if (!text.trim() && !images?.length) return { kind: "local" };

    const skill = resolveSkillInvocation(session, text);
    if (skill) {
      // Reading the skill file can fail (a removed SKILL.md): that is the prompt's failure, before admission.
      const built = await buildSkillPromptMessage(skill.skill, skill, "user");
      if (!isCurrent()) return { kind: "cancelled" };
      const start = await startPrompt({
        ticket,
        results,
        tracker,
        run: (onPromptAdmitted) =>
          session.promptCustomMessage(
            {
              customType: SKILL_PROMPT_MESSAGE_TYPE,
              content: images?.length
                ? [{ type: "text", text: built.message }, ...images]
                : built.message,
              display: true,
              details: built.details,
              attribution: "user",
            },
            {
              streamingBehavior: params.streamingBehavior ?? "steer",
              queueChipText: text,
              onPromptAdmitted,
            },
          ),
      });
      return start.admitted ? { kind: "admitted" } : { kind: "failed", error: start.error };
    }

    const command = new AbortController();
    builtinCommands.add(command);
    let backgrounded = false;
    const builtin = await executeAcpBuiltinSlashCommand(
      text,
      builtinRuntime(command.signal, (task) => {
        backgrounded = true;
        void task()
          .catch((error: unknown) => emit({ type: "command_output", text: errorMessage(error) }))
          .finally(() => builtinCommands.delete(command));
      }),
    );
    if (!backgrounded) builtinCommands.delete(command);
    if (!isCurrent()) return { kind: "cancelled" };
    if (builtin !== false) {
      if (!("prompt" in builtin)) {
        if (builtin.agentInvoked === true) {
          // The command started the agent itself (`/retry`): its result is the run's.
          void session.waitForIdle().then(
            () => results.settle(ticket),
            (error: unknown) => results.fail(ticket, errorMessage(error)),
          );
          return { kind: "admitted" };
        }
        return { kind: "local" };
      }
      text = builtin.prompt;
    }

    const start = await startPrompt({
      ticket,
      results,
      tracker,
      run: (onPromptAdmitted) =>
        session.prompt(text, {
          images,
          ...(params.streamingBehavior ? { streamingBehavior: params.streamingBehavior } : {}),
          onPromptAdmitted,
        }),
    });
    return start.admitted ? { kind: "admitted" } : { kind: "failed", error: start.error };
  };

  const answer = async (id: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      respond(id, await run());
    } catch (error) {
      respondError(id, "failed", errorMessage(error));
    }
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
    if (method === "abort" || method === "abort_and_restore_queue") gate.accept("abort");
    const params = parseChatHostParams(method, parsed.value.params);
    if (!params.ok) {
      respondError(id, "invalid_params", params.error.message);
      continue;
    }
    // The handler table is typed per method; the request's method and its checked params belong together.
    const handler = handlers[method] as (params: unknown) => Promise<unknown>;
    if (BACKGROUND_METHODS.has(method)) {
      void answer(id, () => handler(params.value));
      continue;
    }
    serial = serial.then(() => answer(id, () => handler(params.value)));
  }
  await serial;
}

type PromptOutcome =
  | { readonly kind: "local" | "cancelled" | "admitted" }
  | { readonly kind: "failed"; readonly error: Error };

/** A `/skill:<name>` the session can run, as omp resolves it (`rpc-mode.ts:263-270`); otherwise null. */
function resolveSkillInvocation(session: AgentSession, text: string) {
  if (!session.skillsSettings?.enableSkillCommands) return null;
  const parsed = parseSkillInvocation(text);
  if (!parsed) return null;
  const skill = session.skills.find((candidate) => candidate.name === parsed.name);
  if (!skill) return null;
  return { skill, args: parsed.args, prompt: parsed.prompt };
}

/** omp's `RestoredQueuedMessage`, as the protocol sends it: the images only when there are some. */
function queuedMessage(message: QueuedMessage): QueuedMessage {
  return message.images?.length
    ? { text: message.text, images: message.images }
    : { text: message.text };
}

/** The fields of omp's `BashResult` and `PythonResult` the app reads. */
function shellRun(result: ShellRunResult): ShellRunResult {
  return {
    output: result.output,
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    truncated: result.truncated,
    ...(result.artifactId ? { artifactId: result.artifactId } : {}),
  };
}

function configUpdate(session: AgentSession): ConfigUpdateEvent {
  const { model, thinkingLevel } = readState(session);
  return { type: "config_update", model, thinkingLevel };
}

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

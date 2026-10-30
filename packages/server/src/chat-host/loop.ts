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
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { cfgCycleOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import {
  clearPluginRootsAndCaches,
  resolveActiveProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
  buildSkillPromptMessage,
  parseSkillInvocation,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { reconnectMcpManagerServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import {
  formatPersistenceFailure,
  formatPersistenceNotice,
} from "@oh-my-pi/pi-coding-agent/modes/persistence-failure";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
  type AgentSession,
  SessionBusyError,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  SKILL_PROMPT_MESSAGE_TYPE,
  USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
  CHAT_HOST_METHODS,
  CHAT_HOST_PROTOCOL_VERSION,
  type ChatEvent,
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
  type QueuedInputParams,
  type QueuedMessage,
  type RoleModel,
  type ShellRunResult,
} from "@omp-app/contracts/chat-host";
import { SessionEventStream } from "./events";
import { GoalController } from "./goal";
import { pageMessages, selectEntries } from "./history";
import { checkHostTools, HostTools, HostUriSchemes } from "./host-tools";
import { InputGate } from "./input";
import { LiveVoice } from "./live";
import { HostMethodError } from "./method-error";
import type { LineWriter } from "./output";
import { PlanMode } from "./plan";
import {
  ExtensionMessageTracker,
  PromptResults,
  type PromptTicket,
  startPrompt,
} from "./prompt-results";
import type { ChatSession } from "./session-factory";
import { isSessionSettled, SettleWatcher } from "./settle";
import { cancelSubagent, readSubagentTranscript, SubagentRoster, steerSubagent } from "./subagents";
import { HostRequests, HostUIContext } from "./ui-context";

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

/**
 * Methods answered as soon as they finish, outside the one-at-a-time order: a long run must not hold up an abort, a
 * sign-in that waits for the browser must not hold up the chat, and a host tool's progress must reach its call while
 * other work runs.
 */
const BACKGROUND_METHODS: ReadonlySet<ChatHostMethod> = new Set([
  "bash",
  "python",
  "login",
  "host_tool_update",
  // A subagent's answer to a message can take a step; omp answers it outside the command order too.
  "steer_subagent",
  // A live session connects before it answers; omp starts it outside the command order too.
  "live_start",
]);

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
  // A decided goal continuation keeps the session unsettled, and its stretch ends with `session_settled` even if it is
  // dropped (omp's `watchedScheduledTurnProbe`).
  const goal = new GoalController(session, log, () => void settle.check());
  const scheduledTurn = (): boolean => {
    const pending = goal.continuationPending;
    if (pending) settle.markActive();
    return pending;
  };
  const results = new PromptResults(session, emit, scheduledTurn);
  const settle = new SettleWatcher(session, emit, log, scheduledTurn);
  /** Prompts being admitted and answers outside the command order: drained before the chat ends. */
  const background = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>): void => {
    background.add(task);
    void task.finally(() => background.delete(task));
  };
  const tracker = new ExtensionMessageTracker();
  const gate = new InputGate();
  /** Dialogs, host tool calls and host URI reads wait here for the server's answers. */
  const requests = new HostRequests(writeMessage);
  const ui = new HostUIContext(requests, emit);
  const hostTools = new HostTools(requests, emit);
  const hostUris = new HostUriSchemes(requests, emit);
  const subagents = new SubagentRoster(chat.subagentEventBus, emit);
  const plan = new PlanMode(session, (message) =>
    emit({ type: "notice", level: "warning", message, source: "plan-mode" }),
  );
  const live = new LiveVoice(session, emit);
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

  // omp's persistence surface (`registerRpcPersistenceSurface`): a store failure and a session move, mirrored on
  // stderr. Kept through the session's dispose, when a failure latched in its close still needs reporting.
  session.sessionManager.onPersistenceError((error) => {
    const message = formatPersistenceFailure(error.message);
    emit({ type: "notice", level: "error", message, source: "session-persistence" });
    log(message);
  });
  session.sessionManager.onPersistenceNotice((notice) => {
    const message = formatPersistenceNotice(notice);
    emit({ type: "notice", level: "warning", message, source: "session-persistence" });
    log(message);
  });

  chat.setToolUIContext(ui, true);
  await initializeExtensions(session, {
    mode: "rpc",
    reportSendError: (action, error) =>
      emit({
        type: "notice",
        level: "error",
        message: `${action}: ${error.message}`,
        source: "extension",
      }),
    // As omp's RPC reports it, so the app names the extension that failed.
    reportRuntimeError: (error) =>
      emit({
        type: "extension_error",
        extensionPath: error.extensionPath,
        event: error.event,
        error: error.error,
      }),
    onShutdown: () => {
      shutdownRequested = true;
      options.stopInput();
    },
    trackAgentInvokingMessage: (task) => tracker.track(task),
    wrapSessionChange: async (change, { detachesRun }) => {
      // An extension's session change gets the same goal hold and reattach as the host's.
      await goal.beginSessionChange();
      // Unknown until the change returns: one that throws counts as detached, as in omp.
      let cancelled: boolean | undefined;
      try {
        const result = await change();
        cancelled = result.cancelled;
        return result;
      } finally {
        await goal.endSessionChange({ detachedRun: detachesRun && cancelled !== true });
        if (cancelled === false) {
          if (detachesRun) results.abortOpen();
          // A detached run sends no terminal `agent_end` to settle on.
          void settle.check();
        }
      }
    },
    uiContext: ui,
  });
  session.subscribe((event) => {
    events.forward(event);
    // Before the prompt results and the settle report, so a continuation decided at this `agent_end` counts as pending.
    goal.observe(event);
    results.observe(event);
    settle.observe(event);
  });
  // A goal journaled in the session comes back (paused if it was active, as omp's terminal does at start).
  await goal.reconcile();
  await goal.settled();
  // Plan mode as in omp's terminal: the session reconciles it after a new chat, a switch and a branch; at start a chat
  // left in plan mode comes back in it, and omp's "Start in Plan Mode" opens a fresh chat in it.
  session.setSessionSwitchReconciler(() => plan.reconcile());
  await plan.reconcile();
  await plan.applyStartupDefault();
  session.subscribeCommandMetadataChanged(() => {
    void emitAvailableCommands().catch((error: unknown) =>
      log(`chat host: the command list could not be read: ${errorMessage(error)}`),
    );
  });
  await emitAvailableCommands();

  /**
   * A session change (`new_session`, `branch`, `fork`), in omp's order (`rpc-mode.ts:1994-2032`). Once made, input read
   * before it does not reach the new session, and a new chat ends the open prompts (a branch or fork keeps a live run,
   * which streams to its own end). The command list is sent again for the new session.
   */
  const changeSession = async <Result extends { readonly cancelled: boolean }>(
    sequence: number,
    change: () => Promise<Result>,
    options: { readonly endsOpenPrompts: boolean },
  ): Promise<Result> => {
    let result: Result | undefined;
    await goal.beginSessionChange();
    try {
      result = await change();
    } catch (error) {
      // omp's fork refuses when work started while it waited.
      if (error instanceof SessionBusyError)
        throw new HostMethodError("session_busy", error.message);
      throw error;
    } finally {
      // A branch or fork leaves its run streaming; a new chat detaches it.
      await goal.endSessionChange({
        detachedRun: options.endsOpenPrompts && result?.cancelled !== true,
      });
      await goal.settled();
    }
    if (!result.cancelled) {
      gate.commitSessionChange(sequence);
      if (options.endsOpenPrompts) results.abortOpen();
      // The old session's subagents are not this one's (omp clears its registry the same way).
      subagents.clear();
      // A detached run sends no terminal `agent_end` to settle on.
      void settle.check();
      await emitAvailableCommands();
    }
    return result;
  };
  /** Refuses while a turn, a user command, a compaction or a retry could still write into the transcript. */
  const refuseWhileBusy = (action: string): void => {
    if (session.isBusyForSnapshot) {
      throw new HostMethodError("session_busy", new SessionBusyError(action).message);
    }
  };

  const handlers: {
    readonly [M in Exclude<ChatHostMethod, "prompt" | "steer" | "follow_up">]: (
      params: ChatHostMethodMap[M]["params"],
      sequence: number,
    ) => Promise<ChatHostMethodMap[M]["result"]>;
  } = {
    abort: async () => {
      // Before the abort, so the stopped run's own `agent_end` schedules no goal turn.
      goal.stopForHostAbort();
      abortBuiltinCommands();
      await session.abort({ reason: USER_INTERRUPT_LABEL });
      return {};
    },
    get_state: async () => {
      // A goal exit the last turn started restores the tools first.
      await goal.settled();
      return readState(session);
    },
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
      goal.stopForHostAbort();
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
    set_model: async ({ provider, modelId }) => {
      const model = await findModel(session, provider, modelId);
      if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
      await session.setModel(model);
      return model;
    },
    get_available_models: async () => {
      await session.modelRegistry.awaitBackgroundRefresh();
      return { models: session.getAvailableModels() };
    },
    // Both read the catalog as it is, as omp's Ctrl+P does: they run in the command order, and waiting there for omp's
    // background model refresh (seconds, or a network timeout) held up every request behind them.
    get_role_models: async () => {
      const order = cfgCycleOrder.get(session.settings);
      const cycle = session.getRoleModelCycle(order);
      // omp falls back to the first role when the live model is none of them; the app shows no role then.
      const at = cycle?.models[cycle.currentIndex];
      const live = session.model;
      return {
        order: [...order],
        roles: cycle?.models.map(roleModel) ?? [],
        current:
          at !== undefined && live !== undefined && modelsMatch(at.model, live) ? at.role : null,
      };
    },
    cycle_role_models: async ({ direction }) => {
      const order = cfgCycleOrder.get(session.settings);
      const result = await session.cycleRoleModels(order, direction);
      if (result === undefined) return null;
      const entry = session
        .getRoleModelCycle(order)
        ?.models.find((each) => each.role === result.role);
      return roleModel(
        entry ?? { role: result.role, model: result.model, explicitThinkingLevel: false },
      );
    },
    set_thinking_level: async ({ level }) => {
      // omp's own parser turns the name into its level (an `Effort` member, `off`, `inherit` or `auto`).
      const parsed = parseConfiguredThinkingLevel(level);
      if (parsed === undefined) throw new Error(`Unknown thinking level: ${level}`);
      session.setThinkingLevel(parsed);
      return {};
    },
    cycle_thinking_level: async () => {
      const level = session.cycleThinkingLevel();
      return level ? { level } : null;
    },
    get_available_thinking_levels: async () => ({
      levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()],
    }),
    set_fast_mode: async ({ enabled }) => {
      if (!session.setFastMode(enabled) && enabled) {
        throw new Error("Fast mode is unavailable for the current model.");
      }
      return { enabled: session.isFastModeEnabled(), active: session.isFastModeActive() };
    },
    set_slow_mode: async ({ enabled }) => {
      if (!session.setSlowMode(enabled) && enabled) {
        throw new Error("Slow mode is unavailable for the current model.");
      }
      return { enabled: session.isSlowModeEnabled() };
    },
    compact: async ({ customInstructions }) => session.compact(customInstructions),
    set_auto_compaction: async ({ enabled }) => {
      session.setAutoCompactionEnabled(enabled);
      return {};
    },
    set_session_name: async ({ name }) => {
      const trimmed = name.trim();
      if (!trimmed || !(await session.setSessionName(trimmed, "user"))) {
        throw new Error("Session name cannot be empty");
      }
      return {};
    },
    get_session_stats: async () => session.getSessionStats(),
    export_html: async ({ outputPath }) => ({ path: await session.exportToHtml(outputPath) }),
    handoff: async ({ customInstructions }) => {
      // A handoff tears the session down: a live turn would keep writing into it (omp's `/handoff` guard).
      if (session.isStreaming) throw new Error("Cannot hand off while a response is in progress");
      const result = await session.handoff(customInstructions);
      return result ? { savedPath: result.savedPath } : null;
    },
    set_todos: async ({ phases }) => {
      session.setTodoPhases(phases);
      const todoPhases = session.getTodoPhases();
      // Recorded as the user's edit, so a reload and the model see the list the user set.
      session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: todoPhases });
      return { todoPhases };
    },
    get_entries: async ({ since }) => ({
      entries: selectEntries(session.sessionManager.getEntries(), since),
      leafId: session.sessionManager.getLeafId(),
    }),
    get_tree: async () => ({
      tree: session.sessionManager.getTree(),
      leafId: session.sessionManager.getLeafId(),
    }),
    get_messages_page: async ({ cursor, limit }) => {
      if (session.isStreaming || session.isCompacting) {
        throw new HostMethodError(
          "session_busy",
          "Cannot page messages while the session is changing",
        );
      }
      const messages = session.messages;
      const snapshot = {
        sessionId: session.sessionId,
        leafId: session.sessionManager.getLeafId(),
        messageCount: messages.length,
      };
      return pageMessages(messages, snapshot, { cursor, limit });
    },
    get_branch_messages: async () => ({ messages: session.getUserMessagesForBranching() }),
    new_session: async ({ parentSession }, sequence) => {
      const result = await changeSession(
        sequence,
        async () => ({
          cancelled: !(await session.newSession(parentSession ? { parentSession } : undefined)),
        }),
        { endsOpenPrompts: true },
      );
      // omp's "Start in Plan Mode" holds for a new chat the user asked for, as for `/new` in the terminal.
      if (!result.cancelled) await plan.applyStartupDefault();
      return result;
    },
    branch: async ({ entryId }, sequence) =>
      changeSession(
        sequence,
        async () => {
          const { selectedText, cancelled } = await session.branch(entryId);
          return { text: selectedText, cancelled };
        },
        { endsOpenPrompts: false },
      ),
    fork: async ({ entryId }, sequence) => {
      refuseWhileBusy("fork the session");
      return changeSession(
        sequence,
        // A fork is a snapshot: omp checks again after each of its own waits.
        async () => ({ cancelled: !(await session.fork(entryId, { requireIdle: true })) }),
        { endsOpenPrompts: false },
      );
    },
    navigate_tree: async ({ entryId }) => {
      // omp's rewind (`selector-controller.ts:1393-1442`): the leaf moves in the same session file, the later turns
      // stay as a branch, and a picked prompt rewinds past itself and comes back for the composer.
      refuseWhileBusy("rewind the session");
      // A tree move is a session change for the goal: held during it, and the running goal stays.
      await goal.beginSessionChange();
      let moved: Awaited<ReturnType<typeof session.navigateTree>>;
      try {
        moved = await session.navigateTree(entryId, { summarize: false });
      } finally {
        await goal.endSessionChange();
        await goal.settled();
      }
      const { cancelled, editorText, editorImages } = moved;
      return {
        cancelled,
        ...(editorText !== undefined ? { editorText } : {}),
        ...(editorImages !== undefined ? { editorImages } : {}),
        leafId: session.sessionManager.getLeafId(),
      };
    },
    set_ask_dialog: async ({ enabled }) => {
      ui.askDialogEnabled = enabled;
      return { enabled };
    },
    get_login_providers: async () => ({
      providers: getOAuthProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        available: provider.available,
        authenticated:
          session.modelRegistry.authStorage.keys.source(
            provider.storeCredentialsAs ?? provider.id,
          ) !== undefined,
      })),
    }),
    login: async ({ providerId }) => {
      // omp's RPC sign-in (`rpc-mode.ts:2533-2590`): the page opens without an answer, progress is a notice, and a
      // pasted code is an input. A secret, or a question before any page, needs omp's terminal.
      const provider = getOAuthProviders().find((candidate) => candidate.id === providerId);
      if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
      let pageOpened = false;
      await session.modelRegistry.authStorage.oauth.login(providerId, {
        onAuth: ({ url, launchUrl, instructions }) => {
          pageOpened = true;
          emit({
            type: "ui_open_url",
            url,
            ...(launchUrl !== undefined ? { launchUrl } : {}),
            ...(instructions !== undefined ? { instructions } : {}),
          });
        },
        onProgress: (message) => ui.notify(message, "info"),
        onPrompt: async (prompt) => {
          if (prompt.secret) {
            throw new Error(
              `Provider '${providerId}' asks for secret input, which the app cannot hide. Sign in from omp's terminal.`,
            );
          }
          if (!pageOpened) {
            throw new Error(
              `Provider '${providerId}' asks questions before its sign-in page, which the app does not support. Sign in from omp's terminal.`,
            );
          }
          return (await ui.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
        },
      });
      // The stored sign-in runs the provider's model discovery again instead of reusing the cached list (omp #5780).
      await session.modelRegistry.refreshProvider(
        provider.storeCredentialsAs ?? provider.id,
        "online",
      );
      return { providerId };
    },
    set_host_tools: async ({ tools }) => {
      const definitions = checkHostTools(tools);
      // The session's own method for host-provided tools; the name is omp's.
      await session.refreshRpcHostTools(hostTools.tools(definitions));
      return { toolNames: definitions.map((tool) => tool.name) };
    },
    set_host_uri_schemes: async ({ schemes }) => ({ schemes: hostUris.set(schemes) }),
    host_tool_update: async ({ callId, partialResult }) => ({
      delivered: hostTools.update(callId, partialResult),
    }),
    set_subagent_subscription: async ({ level }) => {
      subagents.setLevel(level);
      return { level: subagents.level };
    },
    get_subagents: async () => ({ subagents: subagents.list() }),
    get_subagent_messages: async (selector) =>
      readSubagentTranscript(subagents.transcriptFile(selector), selector.fromByte),
    cancel_subagent: async ({ subagentId }) => ({
      cancelled: await cancelSubagent(subagents, subagentId),
    }),
    steer_subagent: async ({ subagentId, message }) => {
      await steerSubagent(subagents, subagentId, message, log);
      return {};
    },
    goal: async (params) => goal.handle(params),
    get_plan_mode: async () => plan.status(),
    set_plan_mode: async ({ enabled }) => {
      // A goal still being restored or left for the previous session must not decide the answer.
      await goal.settled();
      return plan.set(enabled);
    },
    get_plan: async ({ planFilePath }) => plan.read(planFilePath),
    approve_plan: async ({ planFilePath, title }) => plan.approve(planFilePath, title ?? ""),
    live_start: async (params) => live.start(params),
    live_stop: async () => {
      await live.stop();
      return {};
    },
    live_mute: async ({ muted }) => live.setMuted(muted),
    abort_bash: async () => {
      session.abortBash();
      return {};
    },
    // For this chat only (`persist: false`), as omp's RPC (#11555): omp's settings and later chats keep theirs.
    set_steering_mode: async ({ mode }) => {
      session.setSteeringMode(mode, false);
      return {};
    },
    set_follow_up_mode: async ({ mode }) => {
      session.setFollowUpMode(mode, false);
      return {};
    },
    set_interrupt_mode: async ({ mode }) => {
      session.setInterruptMode(mode, false);
      return {};
    },
  };

  /** Whether input read as `sequence` still counts: no abort or session change since, and the chat is not closing. */
  const stillCurrent = (sequence: number): (() => boolean) => {
    const sessionId = session.sessionId;
    return () => gate.isCurrent(sequence) && !shutdownRequested && session.sessionId === sessionId;
  };

  /**
   * omp's first steps for every message (`rpc-mode.ts:1772-1784`): the extensions' `input` hooks may take it or change
   * it, and an empty message goes nowhere.
   */
  const readMessage = async (
    params: QueuedInputParams,
    isCurrent: () => boolean,
  ): Promise<
    | { readonly kind: "cancelled" | "local" }
    | {
        readonly kind: "message";
        readonly text: string;
        readonly images: QueuedInputParams["images"];
      }
  > => {
    if (!isCurrent()) return { kind: "cancelled" };
    let { text, images } = params;
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
    return { kind: "message", text, images };
  };

  /**
   * `steer` and `follow_up`, as omp's (`rpc-mode.ts:1768-1792`): in order with prompts through the input gate, past the
   * extensions' input hooks, then into omp's queue. The answer is `{}` whatever became of the message, and no prompt
   * result follows.
   */
  const runQueuedInput = async (
    id: string,
    queue: "steer" | "follow_up",
    params: QueuedInputParams,
    sequence: number,
  ): Promise<void> => {
    const isCurrent = stillCurrent(sequence);
    await answer(id, () =>
      gate.enqueue(async () => {
        const message = await readMessage(params, isCurrent);
        if (message.kind !== "message") return {};
        if (queue === "steer") await session.steer(message.text, message.images);
        else await session.followUp(message.text, message.images);
        return {};
      }),
    );
  };

  const runPrompt = async (id: string, params: PromptParams, sequence: number): Promise<void> => {
    const ticket = results.begin(id);
    const isCurrent = stillCurrent(sequence);
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
          // omp refuses a prompt that came while a turn runs and named no delivery; the app tells it apart.
          respondError(
            id,
            outcome.error instanceof AgentBusyError ? "agent_busy" : "failed",
            outcome.error.message,
          );
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
    const message = await readMessage(params, isCurrent);
    if (message.kind !== "message") return message;
    let text = message.text;
    const images = message.images;

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
      respondError(
        id,
        error instanceof HostMethodError ? error.code : "failed",
        errorMessage(error),
      );
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
    if (parsed.value.kind === "response") {
      if (!requests.settle(parsed.value)) {
        log(`chat host: an answer to no waiting dialog: ${parsed.value.id}`);
      }
      continue;
    }
    const { id, method } = parsed.value;
    if (!isChatHostMethod(method)) {
      respondError(id, "unknown_method", `Unknown method: ${method}`);
      continue;
    }
    // Numbered as read: an abort invalidates the prompts read before it, and so does a session change once made.
    const sequence = gate.accept(
      method === "abort" || method === "abort_and_restore_queue" ? "abort" : "input",
    );
    if (method === "prompt") {
      const params = parseChatHostParams("prompt", parsed.value.params);
      if (!params.ok) {
        respondError(id, "invalid_params", params.error.message);
        continue;
      }
      track(runPrompt(id, params.value, sequence));
      continue;
    }
    if (method === "steer" || method === "follow_up") {
      const params = parseChatHostParams(method, parsed.value.params);
      if (!params.ok) {
        respondError(id, "invalid_params", params.error.message);
        continue;
      }
      track(runQueuedInput(id, method, params.value, sequence));
      continue;
    }
    const params = parseChatHostParams(method, parsed.value.params);
    if (!params.ok) {
      respondError(id, "invalid_params", params.error.message);
      continue;
    }
    // The handler table is typed per method; the request's method and its checked params belong together.
    const handler = handlers[method] as (params: unknown, sequence: number) => Promise<unknown>;
    if (BACKGROUND_METHODS.has(method)) {
      track(answer(id, () => handler(params.value, sequence)));
      continue;
    }
    serial = serial.then(() => answer(id, () => handler(params.value, sequence)));
  }
  // omp's order when its client goes (`rpc-mode.ts:2727-2745`). Nobody is left to answer: waiting dialogs and tool
  // calls fail instead of holding omp, and the app's schemes leave omp's process-wide router. Then accepted work drains,
  // built-in work that outlives its prompt stops, and the answers outside the command order drain; the session itself
  // is disposed by the entry.
  requests.closeAll("The app closed the chat");
  hostUris.clear();
  // The live call (microphone, socket) ends before the session it hands work to, as in omp.
  await live.stop();
  await serial;
  abortBuiltinCommands();
  while (background.size > 0) await Promise.allSettled([...background]);
  subagents.dispose();
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
  return {
    type: "config_update",
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * The available model with this provider and id. One that is not in the catalog yet waits for omp's background
 * discovery first (a discovery-backed provider fills in seconds after start), as omp's own lookup does
 * (`rpc-mode.ts:959-965`).
 */
async function findModel(session: AgentSession, provider: string, modelId: string) {
  const find = () =>
    session
      .getAvailableModels()
      .find((model) => model.provider === provider && model.id === modelId);
  const model = find();
  if (model) return model;
  await session.modelRegistry.awaitBackgroundRefresh();
  return find();
}

/** A role of omp's Ctrl+P cycle (`getRoleModelCycle`), as resolved now. */
type ResolvedRoleModel = NonNullable<
  ReturnType<AgentSession["getRoleModelCycle"]>
>["models"][number];

/** A role's model as the app shows it: the thinking level only when the role names one, as omp applies it then. */
function roleModel(entry: ResolvedRoleModel): RoleModel {
  return {
    role: entry.role,
    provider: entry.model.provider,
    modelId: entry.model.id,
    name: entry.model.name,
    thinkingLevel:
      entry.explicitThinkingLevel && entry.thinkingLevel !== undefined
        ? `${entry.thinkingLevel}`
        : null,
  };
}

function modelsMatch(
  a: { readonly provider: string; readonly id: string },
  b: { readonly provider: string; readonly id: string },
): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/** The chat's state, as omp's session reports it (the fields of omp's own `get_state`, `rpc-mode.ts:2064-2107`). */
function readState(session: AgentSession): ChatHostState {
  const { model, thinkingLevel, sessionFile, sessionName } = session;
  const slowModeScope = session.getSlowModeScope();
  const usageLimit = session.getUsageLimitState();
  const contextUsage = session.getContextUsage();
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    interruptMode: session.interruptMode,
    sessionId: session.sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionName ? { sessionName } : {}),
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    queuedMessageCount: session.queuedMessageCount,
    hasPendingAsyncWork: session.hasPendingAsyncWork(),
    isSettled: isSessionSettled(session),
    queuedMessages: session.getQueuedMessages(),
    todoPhases: session.getTodoPhases(),
    fastModeEnabled: session.isFastModeEnabled(),
    fastModeActive: session.isFastModeActive(),
    tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
    slowModeSupported: session.isSlowModeSupported(),
    slowModeEnabled: session.isSlowModeEnabled(),
    ...(slowModeScope ? { slowModeScope } : {}),
    ...(usageLimit ? { usageLimit } : {}),
    systemPrompt: session.systemPrompt,
    dumpTools: session.agent.state.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toolWireSchema(tool),
      ...(tool.examples !== undefined ? { examples: tool.examples } : {}),
    })),
    ...(contextUsage ? { contextUsage } : {}),
    goal: session.getGoalModeState() ?? null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

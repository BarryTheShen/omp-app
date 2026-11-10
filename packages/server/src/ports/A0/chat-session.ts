/**
 * A0's runtime for chats on the chat host (SDK plan H5.3, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.3 design"): one chat
 * host process per chat, the protocol's requests and events, and the duties A0's RPC runtime had until H5.6b removed it.
 * H5.3a has the core:
 * - opening a chat: new, resumed from its file, the folder's newest (`--continue`), with a picked model;
 * - requests;
 * - the chat's stream;
 * - viewers per connection;
 * - the registry's busy and settled marks;
 * - restart, and the repair before a request.
 * H5.3b adds the host's requests (dialogs, approvals, tools, URIs) and the host registrations; H5.3c the arbitration,
 * `!` and `$` runs, and session switches; H5.3d rename and the reopen after a refused delete.
 */
import { join } from "node:path";
import {
  type AbortSignalLike,
  type AnswerHostRequestArgs,
  type AppError,
  AppFailure,
  type ChatOpenResult,
  type ChatRequestArgs,
  type ChatSessionEvent,
  ChatSessionPort,
  chatSessionEventStream,
  type FirstPromptsArgs,
  type FirstPromptsResult,
  FolderPath,
  firstPromptTextOf,
  isUiStateEvent,
  type ModelChoice,
  type OpenHostRequests,
  type OpenThreadArgs,
  type OrderUsageQueueArgs,
  type PauseAllArgs,
  type PauseAllResult,
  type PrepareNewChatArgs,
  type RemoveUsageRuleArgs,
  RequestId,
  SessionFilePath,
  type SessionRenameArgs,
  type SetEventOptionsArgs,
  type SetEventOptionsResult,
  type SetSubagentSubscriptionArgs,
  type SetSubagentSubscriptionResult,
  type SetUsagePauseArgs,
  type StreamKey,
  type SubscribeArgs,
  ThreadId,
  type UiState,
  type UiStateEvent,
  type UsageActivityResult,
  type UsagePauseHold,
  type UsageQueueResult,
  type UsageRule,
  type UsageRulesResult,
} from "@omp-app/contracts";
import {
  type ChatEvent,
  type ChatHostHello,
  type ChatHostMethod,
  type ChatHostMethodMap,
  HOST_METHOD_ANSWERS,
  type HostRequest,
  type HostToolDefinition,
  type HostUriSchemeDefinition,
  isHostDialogRequest,
  isHostToolCall,
  isHostUriCall,
  isOmpQuestion,
  type OmpQuestionRequest,
  type PromptResultEvent,
  parseChatHostParams,
  type ShellRunResult,
} from "@omp-app/contracts/chat-host";
import { z } from "zod";
import { ChatHostClient, ChatHostRequestError } from "../../chat-host/client";
import {
  type CommandPromptFuture,
  type CommandPromptOutcome,
  type CommandSession,
  type CommandSessionEvent,
  withAdmission,
} from "../../modules/A1/gateway/command-session";
import { newestCopy } from "../../modules/A1/sessions/continuation";
import type { OmpProcess, OmpProcessOptions, ProcessTimer } from "../../process";
import type { PortHandler, PortHandlerContext } from "../../registry/ports";
import type { A0PortContext, ThreadBootstrap } from "./context";
import { modelUnavailableFailure, savedModelFromOmpText } from "./model-restore";
import { startupReason } from "./startup-reason";
import { UsagePause, usagePauseFile } from "./usage-pause";
import { type ResumeOutcome, UsageResume, usageResumeFile } from "./usage-resume";

interface ChatEntry {
  bootstrap: ThreadBootstrap;
  process: OmpProcess;
  client: ChatHostClient;
  stream: StreamKey;
  unsubscribe: () => void;
  /** Views per connection: what its opens took, less what its closes let go. */
  readonly viewers: Map<string, number>;
  /** Events before the chat's own id is known (`#rekey`); published once it is. */
  readonly startupEvents: ChatSessionEvent[];
  rekeyed: boolean;
  /** The methods the chat's host answers (`hello.methods`). */
  methods: readonly string[];
  /** When the chat's current process started: an entry written before it belongs to an earlier process. */
  startedAt: number;
  /** Set while the chat's process is being started again; everyone who needs it waits on it. */
  respawning?: Promise<void>;
  /** The host's requests waiting for the browser's answer: omp reports none of them once answered. */
  readonly openRequests: Map<string, OpenRequest>;
  /** The UI state omp sends once (statuses, widgets, the title), by key, with the sequence that set it. */
  readonly uiState: Map<string, { readonly seq: number; readonly event: UiStateEvent }>;
  /** The app's tools and URI schemes, per connection and owner; the host gets them merged into one set. */
  hostTools: Registrations<HostToolDefinition>;
  hostUriSchemes: Registrations<HostUriSchemeDefinition>;
  /** Registrations are written one after another. */
  hostRegistrations: Promise<void>;
  /** The app turned omp's ask dialog on; a replaced process is told again. */
  askDialogOptedIn: boolean;
  /** The app turned omp's form card on (`set_form_dialog`); a replaced process that answers the method is told again. */
  formDialogOptedIn: boolean;
  /** Each connection's subagent level and message updates; the chat's host gets them as one (`#arbitrate`). */
  readonly preferences: Map<string, Preference>;
  /** What the chat's host was told; undefined until it is, and again once its process is replaced. */
  appliedLevel?: SubagentLevel;
  appliedMessageUpdates?: MessageUpdates;
  /** Arbitrations run one after another. */
  arbitration: Promise<void>;
  /** What the server itself watches on the chat's stream (the A1 gateway's commands): told every payload published. */
  readonly payloadListeners: Set<(payload: ChatSessionEvent) => void>;
  /** A host an earlier server left running on another omp (D2): restarted on this server's omp once the chat settles. */
  restartWhenSettled?: boolean;
  /** The first message sent to the chat through this server, cut short: other pages name the chat by it (#2825). */
  firstPrompt?: string;
}

type SubagentLevel = SetSubagentSubscriptionArgs["level"];
type MessageUpdates = SetEventOptionsArgs["messageUpdates"];

interface Preference {
  readonly level: SubagentLevel;
  readonly messageUpdates?: MessageUpdates;
}

const LEVEL_RANK: Readonly<Record<SubagentLevel, number>> = { off: 0, progress: 1, events: 2 };

/** How many folders keep a new chat ready (#2760): the ones new chats were opened in last. */
const SPARE_FOLDERS = 2;
/** A ready new chat older than this is started again when taken: omp reads its settings and extensions as it starts. */
const SPARE_MAX_AGE_MS = 10 * 60_000;
/** A ready new chat is replaced by a fresh one this long after it started, so one within its age always waits (#2768). */
const SPARE_REFRESH_MS = 9 * 60_000;
/** An open at least this long logs when each of its steps ended (`chat_session.open_steps`, #2768). */
const SLOW_OPEN_MS = 1_000;
/** How much of a chat's first message other pages get to name it by (#2825): a row shows one line of it. */
const FIRST_PROMPT_CHARS = 200;
/** The global timer, which does not keep the server running by itself: a spare's refresh, a continue after a limit. */
const SPARE_TIMER: ProcessTimer = {
  setTimeout: (handler, delayMs) => {
    const handle = globalThis.setTimeout(handler, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number | Timer),
};

/**
 * A new chat started ahead, for the next "New chat" in its folder (#2760): its process and host are up and its id is
 * known (`ready`, undefined when it failed), but it is in no listing and no browser holds it; its own registry view keeps
 * it from the idle rule until it is taken or let go. `refresh` starts its replacement, until it is taken or let go.
 */
interface Spare {
  readonly entry: ChatEntry;
  readonly startedAt: number;
  readonly ready: Promise<{ threadId: ThreadId; sessionFile: SessionFilePath } | undefined>;
  /** The timer's handle for the replacement, while it is due. */
  refresh: unknown;
}

/** The methods that move the chat to another session; omp's own id for the chat changes with them. */
const SESSION_SWITCH_METHODS: ReadonlySet<ChatHostMethod> = new Set([
  "new_session",
  "branch",
  "fork",
]);

/** One kind of host registration: per connection, then per owner. */
type Registrations<T> = ReadonlyMap<string, ReadonlyMap<string, readonly T[]>>;

interface OpenRequest {
  readonly request: HostRequest;
  /** When the host asked it. */
  readonly at: number;
  /** The sequence of the event that asked it, once published. */
  seq?: number;
  readonly resolve: (answer: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** A chat's questions from omp that stop it until you answer, for the dashboard (`waiting.asks`). */
export interface WaitingAsks {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
  /** Oldest first. */
  readonly requests: readonly OmpQuestionRequest[];
  /** When the newest of them was asked. */
  readonly at: number;
}

/** The registrations with one owner's set replaced. */
function withOwner<T>(
  registrations: Registrations<T>,
  connectionId: string,
  owner: string,
  items: readonly T[],
): Registrations<T> {
  const next = new Map(registrations);
  const owners = new Map(next.get(connectionId) ?? []);
  owners.set(owner, items);
  next.set(connectionId, owners);
  return next;
}

/** Every owner's items in one set: a later owner's item replaces an earlier one's of the same key. */
function merged<T>(registrations: Registrations<T>, key: (item: T) => string): T[] {
  const all = new Map<string, T>();
  for (const owners of registrations.values()) {
    for (const items of owners.values()) {
      for (const item of items) all.set(key(item), item);
    }
  }
  return [...all.values()];
}

/** The connection whose item named `name` the host has: the last one, as in `merged`; none when no one registered it. */
function registeredBy<T>(
  registrations: Registrations<T>,
  key: (item: T) => string,
  name: string,
): string | undefined {
  let found: string | undefined;
  for (const [connectionId, owners] of registrations) {
    for (const items of owners.values()) {
      if (items.some((item) => key(item) === name)) found = connectionId;
    }
  }
  return found;
}

/**
 * The connection that alone may answer a host request: the one that gave the tool or the URI scheme it calls (a host
 * page's tools act in that page, for that chat only). `null` for a dialog, which any page that shows the chat answers;
 * `undefined` when the tool or scheme is no one's any more.
 */
function answererOf(entry: ChatEntry, request: HostRequest): string | null | undefined {
  if (isHostToolCall(request)) {
    return registeredBy(entry.hostTools, toolName, request.params.toolName);
  }
  if (isHostUriCall(request)) {
    const scheme = request.params.url.split(":", 1)[0]?.toLowerCase() ?? "";
    return registeredBy(entry.hostUriSchemes, schemeName, scheme);
  }
  return null;
}

const toolName = (tool: HostToolDefinition): string => tool.name;
/** The host names schemes in lower case. */
const schemeName = (scheme: HostUriSchemeDefinition): string => scheme.scheme.toLowerCase();

/** The key a UI state event replaces: a status or a widget by its key, the title alone. */
function uiStateKey(event: UiStateEvent): string {
  switch (event.type) {
    case "ui_status":
      return `status:${event.statusKey}`;
    case "ui_widget":
      return `widget:${event.widgetKey}`;
    case "ui_title":
      return "title";
  }
}

/** omp clears a status or a widget by sending it with no text or lines. */
function clearsUiState(event: UiStateEvent): boolean {
  if (event.type === "ui_status") return !event.statusText;
  if (event.type === "ui_widget") return !event.widgetLines?.length;
  return false;
}

/** The arguments that open a chat with a model the person picked: omp's `--model`, as `provider/modelId`. */
function modelArgs(model: ModelChoice | undefined): string[] {
  return model === undefined ? [] : ["--model", `${model.provider}/${model.modelId}`];
}

function notFound(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}

function cancelled(message: string): AppFailure {
  return new AppFailure({ code: "cancelled", message, retryable: false });
}

function unavailable(message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: true });
}

/** A chat event the A1 gateway reads, as plain data; undefined for any other event. */
function commandEvent(event: ChatEvent): CommandSessionEvent | undefined {
  switch (event.type) {
    case "command_output":
      return { type: "command_output", text: event.text };
    case "session_info_update":
      return {
        type: "session_info_update",
        sessionId: event.sessionId,
        ...(event.title === null ? {} : { title: event.title }),
      };
    case "config_update":
      return {
        type: "config_update",
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.thinkingLevel === undefined ? {} : { thinkingLevel: event.thinkingLevel }),
      };
    case "session_settled":
      return { type: "session_settled" };
    default:
      return undefined;
  }
}

/** A chat whose process ended before its host's hello: a failed start, in the words omp's RPC port used. */
function failedStart(): AppError {
  return {
    code: "omp_exited",
    message: "omp stopped while it was starting. Try again.",
    retryable: true,
  };
}

/** A chat another tab or window of this app holds open: said in plain words, not in the registry's own text. */
function chatOpenElsewhere(cause?: unknown): AppFailure {
  return new AppFailure(
    {
      code: "conflict",
      message:
        "This chat is already open in another tab or window. Close it there, then try again.",
      retryable: true,
    },
    cause === undefined ? undefined : { cause },
  );
}

/** A rename refused because another omp (a terminal's, say) has the chat: what was not done, and what to do. */
function renameRefusedForAnotherOmp(): AppFailure {
  return new AppFailure({
    code: "conflict",
    message:
      "Another omp is using this chat, so it can't be renamed right now. Close that omp, then try again.",
    retryable: true,
  });
}

/**
 * The port's failure for a host's refusal. The host's own code stays in `omp.code`, so a page can tell plan mode's
 * refusals and the busy session apart; a host that ended reads as omp's exit, which a retry can mend.
 */
function requestFailure(method: string, error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  if (!(error instanceof ChatHostRequestError)) {
    return new AppFailure({
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }
  const omp = { command: method, error: error.message, code: error.code };
  switch (error.code) {
    case "closed":
      return new AppFailure({
        code: "omp_exited",
        message: "omp stopped before it answered. Try again.",
        retryable: true,
        omp,
      });
    case "invalid_params":
    case "unknown_method":
      return new AppFailure({
        code: "invalid_args",
        message: error.message,
        retryable: false,
        omp,
      });
    case "agent_busy":
      // The words A0's RPC port used for omp's refusal: plain words, never omp's own text.
      return new AppFailure({
        code: "agent_busy",
        message: "omp is still working on something.",
        retryable: true,
        omp,
      });
    case "session_busy":
    case "stale_cursor":
    case "unknown_since":
      return new AppFailure({ code: "conflict", message: error.message, retryable: true, omp });
    default:
      return new AppFailure({ code: "omp_error", message: error.message, retryable: false, omp });
  }
}

/** A0's stateful bridge between the chat session port and one chat host process per chat. */
export class ChatSessionPortRuntime {
  readonly #context: A0PortContext;
  readonly #entries = new Map<ThreadId, ChatEntry>();
  /** A chat's earlier ids, after a session switch moved it: each names the id it moved to. */
  readonly #aliases = new Map<ThreadId, ThreadId>();
  /** The connections a refused delete's chat is opening again for, until that open ends: `closed` once they close. */
  readonly #pendingReopens = new Map<string, { closed: boolean }>();
  /** The renames of each chat, one after another: a second rename waits for the first to finish. */
  readonly #renames = new Map<ThreadId, Promise<void>>();
  /** Chats whose process is starting and whose host has not said hello yet: an exit now is a failed start. */
  readonly #awaitingHello = new Set<ChatEntry>();
  /** Chats whose host, on another protocol, was asked to hand them back as this server started (D2, `handingBack`). */
  readonly #handingBack = new Set<ThreadId>();
  /** The new chats kept ready, by folder; the folder used last comes last (`#prepareSpare`). */
  readonly #spares = new Map<FolderPath, Spare>();
  #closed = false;
  /** The app's own continue after a usage limit (#2781); absent without its file. */
  readonly #usageResume: UsageResume | undefined;
  /** The usage pause of the chats marked for it (#2781 part 3); absent without its file. */
  readonly #usagePause: UsagePause | undefined;
  /** Stops following the usage watch. */
  readonly #stopUsageWatch: () => void;

  constructor(context: A0PortContext) {
    this.#context = context;
    this.#usageResume =
      context.usageResumeFile === undefined
        ? undefined
        : new UsageResume({
            now: context.usageResumeClock?.now ?? Date.now,
            timer: context.usageResumeClock?.timer ?? SPARE_TIMER,
            ...usageResumeFile(context.usageResumeFile),
            resume: (threadId) => this.#continueAfterLimit(threadId),
            ...(context.logger === undefined ? {} : { logger: context.logger }),
          });
    void this.#usageResume?.restore();
    this.#usagePause =
      context.usagePauseFile === undefined
        ? undefined
        : new UsagePause({
            now: context.usageResumeClock?.now ?? Date.now,
            timer: context.usageResumeClock?.timer ?? SPARE_TIMER,
            ...usagePauseFile(context.usagePauseFile),
            providerOf: (threadId) => this.#providerOf(threadId),
            pause: (threadId) => this.#holdAgents(threadId, "pause"),
            resume: (threadId) => this.#holdAgents(threadId, "resume"),
            isPaused: (threadId) => (context.processRegistry.pausedOf(threadId) ?? null) !== null,
            folderOf: (threadId) => context.processRegistry.folderOf(threadId),
            ...(context.usagePace === undefined ? {} : { pace: context.usagePace }),
            ...(context.logger === undefined ? {} : { logger: context.logger }),
          });
    const usagePause = this.#usagePause;
    const restored = usagePause?.restore() ?? Promise.resolve();
    // The usage reads are judged once the kept marks and holds are back.
    this.#stopUsageWatch =
      usagePause === undefined || context.usageLimits === undefined
        ? () => undefined
        : context.usageLimits.subscribe((result) => {
            void restored.then(() => usagePause.onUsage(result));
          });
    context.processRegistry.setIdleHooks({
      // A chat the app continues after a usage limit keeps its omp until then, watched or not (#2781).
      isSettled: async (threadId) =>
        this.#usageResume?.isWaiting(threadId) !== true && (await this.#isSettled(threadId)),
      stopped: (threadId, process, refusedDelete) =>
        this.#forgetStopped(threadId, process, refusedDelete),
    });
  }

  readonly handlers: Readonly<Record<string, PortHandler>> = {
    // The dispatcher parses each method's zod args before invoking this boundary.
    open: (args, call) => this.open(args as OpenThreadArgs, call),
    prepareNew: (args) => this.prepareNew(args as PrepareNewChatArgs),
    request: (args, call) => this.request(args as ChatRequestArgs, call),
    subscribe: (args) => this.subscribe(args as SubscribeArgs),
    restart: (args) => this.restart(args as { threadId: ThreadId }),
    close: (args, call) => this.close(args as { threadId: ThreadId }, call),
    rename: (args, call) => this.rename(args as SessionRenameArgs, call),
    answer: (args, call) => this.answer(args as AnswerHostRequestArgs, call),
    openRequests: (args) => this.openRequests(args as { threadId: ThreadId }),
    uiState: (args) => this.uiState(args as { threadId: ThreadId }),
    setSubagentSubscription: (args, call) =>
      this.setSubagentSubscription(args as SetSubagentSubscriptionArgs, call),
    setEventOptions: (args, call) => this.setEventOptions(args as SetEventOptionsArgs, call),
    pauseAll: (args) => this.pauseAll(args as PauseAllArgs),
    cancelContinue: (args) => this.cancelContinue(args as { threadId: ThreadId }),
    setUsagePause: (args) => this.setUsagePause(args as SetUsagePauseArgs),
    usageRules: () => this.usageRules(),
    setUsageRule: (args) => this.setUsageRule(args as UsageRule),
    removeUsageRule: (args) => this.removeUsageRule(args as RemoveUsageRuleArgs),
    usageQueue: () => this.usageQueue(),
    orderUsageQueue: (args) => this.orderUsageQueue(args as OrderUsageQueueArgs),
    continueHeld: (args) => this.continueHeld(args as { threadId: ThreadId }),
    skipHeld: (args) => this.skipHeld(args as { threadId: ThreadId }),
    usageActivity: () => this.usageActivity(),
    firstPrompts: (args) => this.firstPrompts(args as FirstPromptsArgs),
  };

  /** A page shows the folder: a new chat is kept ready there, if this server keeps them (#2760). */
  prepareNew(args: PrepareNewChatArgs): null {
    this.#prepareSpare(args.folderPath);
    return null;
  }

  /**
   * The first message of each chat, as this server sent it to omp: a page that did not send it names the chat by it, as
   * the page that did, until omp writes the chat's file and its title (#2825).
   */
  firstPrompts(args: FirstPromptsArgs): FirstPromptsResult {
    return args.threadIds.flatMap((threadId) => {
      const text = this.#entryOrUndefined(threadId)?.firstPrompt;
      return text === undefined ? [] : [{ threadId, text }];
    });
  }

  /** "Don't continue": the app does not continue the chat after its usage limit (#2781). */
  cancelContinue(args: { threadId: ThreadId }): null {
    this.#usageResume?.cancel(args.threadId);
    return null;
  }

  /** Marks the chat to pause at its share of its provider's 5-hour limit, or unmarks it (#2781 part 3). */
  async setUsagePause(args: SetUsagePauseArgs): Promise<null> {
    const usagePause = this.#usagePause;
    if (usagePause === undefined) {
      throw new AppFailure({
        code: "unavailable",
        message: "This app server can't pause chats at a usage limit.",
        retryable: false,
      });
    }
    const threadId = this.#aliases.get(args.threadId) ?? args.threadId;
    const folder = this.#context.processRegistry.folderOf(threadId);
    if (folder === undefined) throw notFound("Open the chat, then set its usage pause.");
    await usagePause.setMark(threadId, folder, args.percent);
    return null;
  }

  /** The usage pause, or the reason this server has none. */
  #usagePauseOrFail(): UsagePause {
    if (this.#usagePause !== undefined) return this.#usagePause;
    throw new AppFailure({
      code: "unavailable",
      message: "This app server can't pause chats at a usage limit.",
      retryable: false,
    });
  }

  /** The usage rules, each with the chats it holds, and the time zone of their hours (#2836). */
  usageRules(): UsageRulesResult {
    const usagePause = this.#usagePauseOrFail();
    return {
      rules: usagePause.rules().map(({ rule, held }) => ({ rule, held: [...held] })),
      timeZone: usagePause.timeZone,
    };
  }

  /** Adds a usage rule or replaces the one with its id; chats are named by the ids the pages know (#2836). */
  async setUsageRule(rule: UsageRule): Promise<null> {
    const usagePause = this.#usagePauseOrFail();
    await usagePause.setRule({
      ...rule,
      chats: [...new Set(rule.chats.map((id) => this.#aliases.get(id) ?? id))],
    });
    return null;
  }

  /** Removes a usage rule; the chats it held continue unless another rule holds them (#2836). */
  async removeUsageRule(args: RemoveUsageRuleArgs): Promise<null> {
    await this.#usagePauseOrFail().removeRule(args.id);
    return null;
  }

  /** The held chats in the queue's order, and when each continues (#2836). */
  usageQueue(): UsageQueueResult {
    return { chats: [...this.#usagePauseOrFail().queue()] };
  }

  /** Puts the held chats in a new order, named by the ids the pages know (#2836). */
  async orderUsageQueue(args: OrderUsageQueueArgs): Promise<null> {
    await this.#usagePauseOrFail().setOrder(
      args.threadIds.map((id) => this.#aliases.get(id) ?? id),
    );
    return null;
  }

  /** Continues a held chat now, out of its turn (#2836). */
  async continueHeld(args: { threadId: ThreadId }): Promise<null> {
    await this.#usagePauseOrFail().continueNow(this.#aliases.get(args.threadId) ?? args.threadId);
    return null;
  }

  /** Skips a held chat's continuing: it stays paused, and the rules let it be (#2836). */
  async skipHeld(args: { threadId: ThreadId }): Promise<null> {
    await this.#usagePauseOrFail().skip(this.#aliases.get(args.threadId) ?? args.threadId);
    return null;
  }

  /** What the usage pause did, newest first (#2836). */
  usageActivity(): UsageActivityResult {
    return { entries: [...this.#usagePauseOrFail().activity()] };
  }

  /** The chats marked to pause at their usage limit, by folder, and each change with the chat's folder (#2781). */
  readonly usagePauses = {
    usagePausesIn: (folder: string) => this.#usagePause?.marksIn(folder) ?? [],
    onUsagePauseChange: (
      listener: (
        threadId: ThreadId,
        folder: string,
        percent: number | null,
        hold: UsagePauseHold | null,
      ) => void,
    ): (() => void) => this.#usagePause?.onChange(listener) ?? (() => undefined),
  };

  /** The provider of the model a running chat uses now; null when its omp is not running. */
  async #providerOf(threadId: ThreadId): Promise<string | null> {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || entry.bootstrap.threadId !== threadId || !this.#isRunning(entry)) {
      return null;
    }
    return (await entry.client.request("get_state", {})).model?.provider ?? null;
  }

  /** Pauses or resumes a running chat's agents as omp's `/pause` does; false when its omp is not running. */
  async #holdAgents(threadId: ThreadId, method: "pause" | "resume"): Promise<boolean> {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || entry.bootstrap.threadId !== threadId || !this.#isRunning(entry)) {
      return false;
    }
    await this.#send(entry, method, {});
    return true;
  }

  /** The chats the app continues after a usage limit, by folder, and each change with the chat's folder (#2781). */
  readonly continuing = {
    continuingIn: (
      folder: string,
    ): readonly { readonly id: ThreadId; readonly continuesAt: number }[] => {
      const registry = this.#context.processRegistry;
      return [...(this.#usageResume?.due() ?? [])]
        .filter(([threadId]) => registry.folderOf(threadId) === folder)
        .map(([id, continuesAt]) => ({ id, continuesAt }));
    },
    onContinueChange: (
      listener: (
        threadId: ThreadId,
        folder: string | undefined,
        continuesAt: number | null,
      ) => void,
    ): (() => void) =>
      this.#usageResume?.onChange((threadId, continuesAt) =>
        listener(threadId, this.#context.processRegistry.folderOf(threadId), continuesAt),
      ) ?? (() => undefined),
  };

  readonly #waitingListeners = new Set<() => void>();

  /**
   * Whether a chat waits for an answer from you (an approval or a question), and each change: the running list (D1);
   * and omp's questions that wait in each chat, for the dashboard's questions (D7).
   */
  readonly waiting = {
    // A call of a page's tool waits for that page, not for you.
    waitingFor: (threadId: ThreadId): boolean =>
      [
        ...(this.#entries.get(this.#aliases.get(threadId) ?? threadId)?.openRequests.values() ??
          []),
      ].some(({ request }) => isHostDialogRequest(request)),
    /** Each chat with omp's questions that stop it until you answer (`isOmpQuestion`), oldest first. */
    asks: (): readonly WaitingAsks[] => {
      const chats: WaitingAsks[] = [];
      for (const entry of this.#entries.values()) {
        const requests: OmpQuestionRequest[] = [];
        let at = 0;
        for (const open of [...entry.openRequests.values()].sort(
          (left, right) => left.at - right.at,
        )) {
          if (!isOmpQuestion(open.request)) continue;
          requests.push(open.request);
          at = open.at;
        }
        if (requests.length === 0) continue;
        chats.push({
          threadId: entry.bootstrap.threadId,
          folder: entry.bootstrap.folderPath,
          requests,
          at,
        });
      }
      return chats;
    },
    onWaitingChange: (listener: () => void): (() => void) => {
      this.#waitingListeners.add(listener);
      return () => {
        this.#waitingListeners.delete(listener);
      };
    },
  };

  #waitingChanged(): void {
    for (const listener of this.#waitingListeners) {
      try {
        listener();
      } catch {
        // A running-list observer must not break a chat's requests or other observers.
      }
    }
  }

  /** The session file an open chat runs, known before omp writes it (a new chat writes its file after its first reply). */
  sessionFileOf(threadId: ThreadId): SessionFilePath | undefined {
    return this.#entryOrUndefined(threadId)?.bootstrap.sessionFile;
  }

  /**
   * The chat as a command session for the A1 gateway; undefined for a chat no host here serves. Its events follow the
   * chat across a restart and a session switch.
   */
  commandSessionFor(threadId: ThreadId): CommandSession | undefined {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || this.#context.processRegistry.isStopping(entry.bootstrap.threadId)) {
      return undefined;
    }
    return {
      availableCommands: async () => {
        await this.#ensureRunning(entry);
        return (await this.#send(entry, "get_available_commands", {})).commands;
      },
      prompt: (text, signal) => this.#commandPrompt(entry, text, signal),
      onEvent: (listener) =>
        this.#watchPayloads(entry, (payload) => {
          const event = payload.kind === "event" ? commandEvent(payload.event) : undefined;
          if (event !== undefined) listener(event);
        }),
    };
  }

  async open(args: OpenThreadArgs, call: PortHandlerContext): Promise<ChatOpenResult> {
    const registry = this.#context.processRegistry;
    // A slow open says where its time went (#2768): when each step ended, from the open's start.
    const began = Date.now();
    const steps: Record<string, number> = {};
    const step = (name: string): void => {
      steps[`${name}_ms`] = Date.now() - began;
    };
    /** A count a slow open logs beside its steps' times. */
    const count = (name: string, value: number): void => {
      steps[name] = value;
    };
    const slow = (how: "spare" | "joined" | "started", threadId: ThreadId): void => {
      const total = Date.now() - began;
      if (total >= SLOW_OPEN_MS)
        this.#context.logger?.info("chat_session.open_steps", {
          threadId,
          how,
          total_ms: total,
          ...steps,
        });
    };
    if (this.#context.health.status !== "ok") {
      throw new AppFailure({
        code: "unavailable",
        message: this.#context.health.detail ?? "omp is unavailable",
        retryable: true,
      });
    }
    // A new chat in a folder with one ready takes it: no omp to start, no wait (#2760).
    if ("start" in args && args.start === "new") {
      const taken = await this.#takeSpare(args.folderPath, call, step, count);
      if (taken !== undefined) {
        slow("spare", taken.threadId);
        return taken;
      }
      step("spare");
    }
    // A chat whose process is stopping keeps its entry with the bootstrap of its first start: the stop is waited for
    // first, so the open resumes the chat's file (issue 2212).
    if ("threadId" in args) await registry.whenGone(args.threadId, "opened");
    step("stopped");
    const bootstrap = await this.#resolveBootstrap(args, call.signal);
    step("resolved");
    await registry.whenGone(bootstrap.threadId, "opened");
    step("gone");
    // A connection that closed while this open waited released its views before this one was added; nothing awaits
    // between this check and the view, so an open that passes it is released by its connection's close.
    if (call.signal.aborted) throw cancelled("Opening the chat was cancelled.");
    const existing = this.#entries.get(bootstrap.threadId);
    if (existing !== undefined) {
      if (existing.bootstrap.folderPath !== bootstrap.folderPath) {
        throw new AppFailure({
          code: "conflict",
          message: "The thread is already open in a different folder",
          retryable: false,
        });
      }
      registry.acquire(this.#processOptions(bootstrap));
      this.#addViewer(existing, call.connectionId);
      slow("joined", bootstrap.threadId);
      return this.#openResult(existing);
    }

    await this.#refuseChatHeldElsewhere(bootstrap);
    step("lease");
    const process = registry.acquire(this.#processOptions(bootstrap));
    const entry = this.#newEntry(bootstrap, process);
    entry.unsubscribe = this.#listen(entry);
    this.#entries.set(bootstrap.threadId, entry);
    this.#addViewer(entry, call.connectionId);
    try {
      await this.#start(entry);
      step("started");
      // A newer pick superseded this open while the chat started: the open ends here, and the catch lets its view go.
      if (call.signal.aborted) throw cancelled("Opening the chat was cancelled.");
      let identity = await this.#identity(entry);
      if ("start" in args && args.start === "new" && identity.messageCount > 0) {
        // A new chat starts without --continue, but omp's auto-resume can still restore the folder's newest one. Its
        // startup events are dropped before the new session, so New chat never shows the old transcript.
        entry.startupEvents.length = 0;
        const result = await entry.client.request("new_session", {});
        if (result.cancelled) throw cancelled("Starting a new chat was cancelled.");
        identity = await this.#identity(entry);
      }
      // A chat opened by its id opens as the bootstrap says: its newest copy, when omp moved it (`#resolveBootstrap`).
      this.#rekey(entry, "threadId" in args ? entry.bootstrap.threadId : undefined, identity);
      step("identified");
    } catch (error) {
      // A cancelled open leaves a chat another view still watches running: only this open's view goes.
      const otherViews = [...entry.viewers].reduce(
        (sum, [id, count]) => sum + (id === call.connectionId ? count - 1 : count),
        0,
      );
      if (call.signal.aborted && otherViews > 0) {
        this.#releaseView(entry, call.connectionId);
        throw error;
      }
      entry.client.dispose();
      this.#dropEntry(entry);
      // The failed process is stopped and forgotten: the next open starts the chat again. A stop that fails is logged
      // where it happens; the open's own failure is what the caller hears.
      await registry.stopIfUnwatched(entry.bootstrap.threadId, "opened").catch(() => undefined);
      const failure = requestFailure("open", error);
      if (failure.appError.code === "omp_exited") {
        // The chat stopped before it was ready, and its last words say why: a saved model it could not restore offers
        // another model; any other reason reaches the browser as a typed reason.
        await process.stderrSettled?.();
        const savedModel = savedModelFromOmpText(process.stderrTail);
        if (savedModel !== undefined) throw modelUnavailableFailure(savedModel);
        if ("threadId" in args) throw notFound(failure.appError.message);
        throw new AppFailure({ ...failure.appError, startup: startupReason(process.stderrTail) });
      }
      throw failure;
    }
    // The next new chat in this folder is made ready now.
    if ("start" in args && args.start === "new") this.#prepareSpare(entry.bootstrap.folderPath);
    slow("started", entry.bootstrap.threadId);
    return this.#openResult(entry);
  }

  /** Opens a new chat from the spare ready in the folder, or undefined when none is usable (#2760). */
  async #takeSpare(
    folderPath: FolderPath,
    call: PortHandlerContext,
    step: (name: string) => void,
    count: (name: string, value: number) => void,
  ): Promise<ChatOpenResult | undefined> {
    const spare = this.#spares.get(folderPath);
    if (spare === undefined) return undefined;
    this.#spares.delete(folderPath);
    const identity = await spare.ready;
    step("spare_ready");
    const { entry } = spare;
    if (call.signal.aborted && identity !== undefined && entry.process.status === "running") {
      this.#spares.set(folderPath, spare);
      throw cancelled("Opening the chat was cancelled.");
    }
    if (
      identity === undefined ||
      entry.process.status !== "running" ||
      Date.now() - spare.startedAt > SPARE_MAX_AGE_MS
    ) {
      await this.#discardSpare(spare);
      return undefined;
    }
    // The spare's own registry view becomes this open's; its events, held since it started, go out with its id.
    this.#stopRefresh(spare);
    this.#entries.set(entry.bootstrap.threadId, entry);
    this.#addViewer(entry, call.connectionId);
    count("spare_held_events", entry.startupEvents.length);
    this.#rekey(entry, undefined, identity);
    step("spare_rekey");
    this.#prepareSpare(folderPath);
    step("spare_next");
    return this.#openResult(entry);
  }

  /**
   * Starts a new chat in the folder and keeps it ready for the next "New chat" there (#2760), unless one is; the
   * folders used least recently, past `SPARE_FOLDERS`, lose theirs.
   */
  #prepareSpare(folderPath: FolderPath): void {
    if (this.#closed || this.#context.newChatsReady !== true) return;
    const kept = this.#spares.get(folderPath);
    this.#spares.delete(folderPath);
    if (kept !== undefined) {
      this.#spares.set(folderPath, kept);
      return;
    }
    this.#spares.set(folderPath, this.#newSpare(folderPath));
    for (const [folder, spare] of this.#spares) {
      if (this.#spares.size <= SPARE_FOLDERS) break;
      this.#spares.delete(folder);
      void this.#discardSpare(spare);
    }
  }

  /** Starts a new chat in the folder to keep ready, with its replacement due before it ages out. */
  #newSpare(folderPath: FolderPath): Spare {
    const bootstrap = this.#provisionalBootstrap(folderPath, []);
    const process = this.#context.processRegistry.acquire(this.#processOptions(bootstrap));
    const entry = this.#newEntry(bootstrap, process);
    entry.unsubscribe = this.#listen(entry);
    const spare: Spare = {
      entry,
      startedAt: Date.now(),
      ready: this.#startSpare(entry),
      refresh: undefined,
    };
    spare.refresh = (this.#context.spareTimer ?? SPARE_TIMER).setTimeout(
      () => void this.#refreshSpare(folderPath, spare),
      SPARE_REFRESH_MS,
    );
    return spare;
  }

  /**
   * Replaces the folder's ready new chat with a fresh one before it ages out (#2768): the fresh one takes its place once
   * it is up, and the old one goes, so a "New chat" never waits for an omp to start. One taken or let go meanwhile is
   * left alone, and so is the folder's place among the folders used last.
   */
  async #refreshSpare(folderPath: FolderPath, old: Spare): Promise<void> {
    old.refresh = undefined;
    if (this.#closed || this.#spares.get(folderPath) !== old) return;
    const fresh = this.#newSpare(folderPath);
    const identity = await fresh.ready;
    if (identity === undefined || this.#closed || this.#spares.get(folderPath) !== old) {
      await this.#discardSpare(fresh);
      return;
    }
    this.#spares.set(folderPath, fresh);
    await this.#discardSpare(old);
  }

  /** Starts a spare as an open starts a new chat: its host's hello, then its id, on a new session of its own. */
  async #startSpare(
    entry: ChatEntry,
  ): Promise<{ threadId: ThreadId; sessionFile: SessionFilePath } | undefined> {
    try {
      await this.#start(entry);
      let identity = await this.#identity(entry);
      if (identity.messageCount > 0) {
        // omp's auto-resume restored the folder's newest chat: a new chat never shows it (see `open`).
        entry.startupEvents.length = 0;
        const result = await entry.client.request("new_session", {});
        if (result.cancelled) return undefined;
        identity = await this.#identity(entry);
      }
      return identity;
    } catch (error) {
      this.#context.logger?.warn("chat_session.spare_failed", {
        folder: entry.bootstrap.folderPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** The spare's replacement is no longer due: it is taken or let go. */
  #stopRefresh(spare: Spare): void {
    if (spare.refresh !== undefined)
      (this.#context.spareTimer ?? SPARE_TIMER).clearTimeout(spare.refresh);
    spare.refresh = undefined;
  }

  /** Lets a spare go: its host is stopped (nobody holds it, and it has no turn). */
  async #discardSpare(spare: Spare): Promise<void> {
    this.#stopRefresh(spare);
    const { entry } = spare;
    entry.unsubscribe();
    entry.client.dispose();
    const registry = this.#context.processRegistry;
    registry.release(entry.bootstrap.threadId);
    await registry.stopIfUnwatched(entry.bootstrap.threadId, "opened").catch(() => undefined);
  }

  /**
   * Takes over a chat whose host an earlier server left running (D2), as this server starts: the chat is served here
   * before any browser opens it again, so a turn under way runs on, the idle rule asks its host whether it has settled,
   * and a browser that opens it adds a view. The chat is registered at once; its host is asked for what is live and who
   * it is after (`#takeOver`), so a host busy with a long command holds up only its own chat. A host on another omp is
   * restarted on this server's once the chat settles, between turns, never during one.
   */
  adopt(
    process: OmpProcess,
    hello: ChatHostHello,
    options: { readonly restartWhenSettled: boolean },
  ): void {
    const threadId = ThreadId.parse(hello.session.id);
    const registry = this.#context.processRegistry;
    if (hello.session.file === null || this.#entries.has(threadId) || registry.has(threadId)) {
      void process.release?.();
      return;
    }
    const sessionFile = SessionFilePath.parse(hello.session.file);
    const bootstrap: ThreadBootstrap = {
      threadId,
      folderPath: FolderPath.parse(hello.session.cwd),
      sessionFile,
      args: ["--resume", sessionFile],
    };
    registry.adopt(threadId, hello.session.cwd, process);
    const entry = this.#newEntry(bootstrap, process);
    entry.unsubscribe = this.#listen(entry);
    this.#entries.set(threadId, entry);
    void this.#takeOver(entry, options);
  }

  async #takeOver(
    entry: ChatEntry,
    options: { readonly restartWhenSettled: boolean },
  ): Promise<void> {
    const { threadId } = entry.bootstrap;
    try {
      await this.#start(entry, { replayLive: true });
      this.#rekey(entry, threadId, await this.#identity(entry));
    } catch (error) {
      this.#context.logger?.warn("chat_session.adopt_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      entry.client.dispose();
      this.#forget(entry);
      await this.#context.processRegistry
        .stopIfUnwatched(threadId, "opened")
        .catch(() => undefined);
      return;
    }
    if (options.restartWhenSettled) {
      entry.restartWhenSettled = true;
      await this.#restartIfSettled(entry);
    }
  }

  /**
   * Notes a chat whose host, on a protocol this server does not speak, was asked to hand it back (D2): it finishes the
   * turn it runs, then ends. Until then the chat is held, and an open says why in those words.
   */
  handingBack(threadId: ThreadId): void {
    this.#handingBack.add(threadId);
  }

  /**
   * A request by a method's name: its params are checked against the method before the host sees them. A host tool or
   * URI scheme registration is merged with every other owner's; only a viewer of the chat may make one.
   */
  async request(args: ChatRequestArgs, call: PortHandlerContext): Promise<unknown> {
    // Stop also stops the app's own continue after a usage limit (#2781).
    if (args.method === "abort" || args.method === "abort_and_restore_queue") {
      this.#usageResume?.cancel(args.threadId);
    }
    // A chat that is not running has nothing to hold: pausing or resuming it answers so and starts nothing.
    if (args.method === "pause" || args.method === "resume") {
      const held = this.#entryOrUndefined(args.threadId);
      if (held === undefined || !this.#isRunning(held)) return { pausedAt: null };
      // Who asked: a hold that stops a chat for no visible reason can be traced to its page (`pause_changed` says when).
      this.#context.logger?.info("chat_session.pause_asked", {
        threadId: args.threadId,
        method: args.method,
        connection: call.connectionId,
      });
    }
    // A chat no host here serves may still be open in another omp: the request is refused with the sentence that says so.
    if (this.#entryOrUndefined(args.threadId) === undefined) {
      await this.#refuseWhenHeldElsewhere(args.threadId, call.signal);
    }
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    // A call the browser gave up while its chat started again reaches no host: the browser was told it was cancelled,
    // as omp's RPC port refused a cancelled command before writing it.
    if (call.signal.aborted) throw cancelled("The command was cancelled.");
    const method = args.method as ChatHostMethod;
    const params = parseChatHostParams(method, args.params);
    if (!params.ok) {
      throw new AppFailure({
        code: "invalid_args",
        message: params.error.message,
        retryable: false,
      });
    }
    if (method === "prompt" && entry.firstPrompt === undefined) {
      // As a saved chat's first prompt is listed: what was typed, never a pasted text's wrapper or the paragraph that
      // names attached files (#2830), on one line.
      const sent = (params.value as ChatHostMethodMap["prompt"]["params"]).text;
      const text = firstPromptTextOf(sent).replace(/\s+/g, " ").trim();
      if (text !== "") entry.firstPrompt = text.slice(0, FIRST_PROMPT_CHARS);
    }
    if (method === "set_host_tools" || method === "set_host_uri_schemes") {
      const owner = args.registrationOwner;
      if (owner === undefined) {
        throw new AppFailure({
          code: "invalid_args",
          message: "A host registration owner is required.",
          retryable: false,
        });
      }
      this.#requireViewer(entry, call.connectionId);
      return method === "set_host_tools"
        ? this.#registerTools(
            entry,
            call.connectionId,
            owner,
            (params.value as ChatHostMethodMap["set_host_tools"]["params"]).tools,
          )
        : this.#registerUriSchemes(
            entry,
            call.connectionId,
            owner,
            (params.value as ChatHostMethodMap["set_host_uri_schemes"]["params"]).schemes,
          );
    }
    // omp reports a `!` or `$` run only to its caller: every viewer hears it start and end.
    if (method === "bash" || method === "python") {
      return this.#shellRun(
        entry,
        method,
        params.value as ChatHostMethodMap[typeof method]["params"],
      );
    }
    const result = await this.#send(
      entry,
      method,
      params.value as ChatHostMethodMap[typeof method]["params"],
    );
    // The opt-in lasts for one process: a replaced one is told again (`#reapply`).
    if (method === "set_ask_dialog") {
      entry.askDialogOptedIn = (
        params.value as ChatHostMethodMap["set_ask_dialog"]["params"]
      ).enabled;
    }
    if (method === "set_form_dialog") {
      entry.formDialogOptedIn = (
        params.value as ChatHostMethodMap["set_form_dialog"]["params"]
      ).enabled;
    }
    if (SESSION_SWITCH_METHODS.has(method)) {
      // Another session: its first message is still to come.
      entry.firstPrompt = undefined;
      await this.#refreshIdentity(entry);
    }
    return result;
  }

  /** One connection's subagent level: the chat's host gets the highest of its viewers'. */
  async setSubagentSubscription(
    args: SetSubagentSubscriptionArgs,
    call: PortHandlerContext,
  ): Promise<SetSubagentSubscriptionResult> {
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    entry.preferences.set(call.connectionId, {
      ...this.#preference(entry, call.connectionId),
      level: args.level,
    });
    await this.#arbitrate(entry);
    return { level: entry.appliedLevel ?? "off" };
  }

  /** One connection's message updates: the chat's host gets `full` when any viewer asks for it, else `delta`. */
  async setEventOptions(
    args: SetEventOptionsArgs,
    call: PortHandlerContext,
  ): Promise<SetEventOptionsResult> {
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    entry.preferences.set(call.connectionId, {
      ...this.#preference(entry, call.connectionId),
      messageUpdates: args.messageUpdates,
    });
    await this.#arbitrate(entry);
    return entry.appliedMessageUpdates === undefined
      ? {}
      : { messageUpdates: entry.appliedMessageUpdates };
  }

  /**
   * Renames a chat. An open chat is renamed by its own host. A chat nobody has open, or whose host is stopping, is
   * renamed by a short-lived host: opened, checked for another omp's lease, asked to set the name, and stopped again at
   * once, whatever the outcome.
   */
  async rename(args: SessionRenameArgs, call: PortHandlerContext): Promise<null> {
    await this.#serializeRename(args.threadId, async () => {
      const entry = this.#entryOrUndefined(args.threadId);
      // A chat whose host is stopping is renamed as a closed one: the rename waits for that host to exit and writes
      // nothing into it. The wait is keyed by the entry's own id, since no stop is keyed by a switched chat's old id.
      if (
        entry === undefined ||
        this.#context.processRegistry.isStopping(entry.bootstrap.threadId)
      ) {
        await this.#renameClosed(
          { ...args, threadId: entry?.bootstrap.threadId ?? args.threadId },
          call,
        );
        return;
      }
      await this.#ensureRunning(entry);
      await this.#send(entry, "set_session_name", { name: args.name });
    });
    return null;
  }

  async #renameClosed(args: SessionRenameArgs, call: PortHandlerContext): Promise<void> {
    const resolved = await this.#context.resolveThread(args.threadId, call.signal);
    if (resolved === undefined) throw notFound(`Thread ${args.threadId} was not found`);
    // A host this server is still stopping holds the chat's file until it exits.
    await this.#context.processRegistry.whenGone(args.threadId, "renamed");
    // The open refuses a chat another omp holds (omp's lease) before it starts a host here; a rename says what it did not
    // do, rather than the open's sentence.
    const opened = await this.open({ threadId: args.threadId }, call).catch((error: unknown) => {
      if (error instanceof AppFailure && error.appError.conflictReason === "held_elsewhere") {
        throw renameRefusedForAnotherOmp();
      }
      throw error;
    });
    try {
      // Checked once this host is up and before it writes. omp takes a chat's lease only when it writes, so another omp
      // that has written the chat shows up here, and a refusal leaves the chat as it was.
      const hostPid = this.#context.processRegistry.get(args.threadId)?.pid;
      const other = await this.#context.externalOmp(args.threadId, opened.sessionFile, hostPid);
      if (other === "running") throw renameRefusedForAnotherOmp();
      if (other === "unknown") {
        throw unavailable(
          "The app can't tell whether another omp is using this chat, so nothing was renamed.",
        );
      }
      const entry = this.#entry(args.threadId);
      await this.#send(entry, "set_session_name", { name: args.name });
      // Another omp can start writing between the check and this write; omp then moves the chat to a copy.
      const identity = await this.#identity(entry);
      if (identity.threadId !== args.threadId || identity.sessionFile !== opened.sessionFile) {
        throw new AppFailure({
          code: "conflict",
          message:
            "Another omp started writing this chat during the rename, so the new title went to a copy. The original keeps its old title, and the copy is listed as its own chat.",
          retryable: false,
        });
      }
    } finally {
      await this.close({ threadId: args.threadId }, call);
      // A stop that fails is logged where it happens. The rename does not fail for its host's stop, and the next open or
      // delete waits for the host to be gone.
      await this.#context.processRegistry
        .stopIfUnwatched(args.threadId, "renamed")
        .catch(() => undefined);
    }
  }

  #serializeRename(threadId: ThreadId, operation: () => Promise<void>): Promise<void> {
    const previous = this.#renames.get(threadId) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#renames.set(threadId, settled);
    void settled.then(() => {
      if (this.#renames.get(threadId) === settled) this.#renames.delete(threadId);
    });
    return current;
  }

  /**
   * The browser's answer to a host request, checked against the request's method before the host gets it. A call of a
   * page's tool or URI scheme is answered only by the connection that gave it.
   */
  answer(args: AnswerHostRequestArgs, call: PortHandlerContext): null {
    const entry = this.#entry(args.threadId);
    const open = entry.openRequests.get(args.id);
    if (open === undefined) {
      throw notFound(
        "Nothing waits for that answer: the request was answered, given up, or its chat restarted.",
      );
    }
    const answerer = answererOf(entry, open.request);
    if (answerer !== null && answerer !== call.connectionId) {
      throw new AppFailure({
        code: "permission",
        message: "Only the page that gave this tool to the chat can answer its calls.",
        retryable: false,
      });
    }
    const answer = HOST_METHOD_ANSWERS[open.request.method].safeParse(args.answer);
    if (!answer.success) {
      throw new AppFailure({
        code: "invalid_args",
        message: `The answer does not fit ${open.request.method}: ${z.prettifyError(answer.error)}`,
        retryable: false,
      });
    }
    entry.openRequests.delete(args.id);
    this.#waitingChanged();
    open.resolve(answer.data);
    // The other pages that show the chat close it too (#2809). An event a page does not know is passed over, so a page
    // still running an older build keeps working.
    this.#receive(entry, { kind: "event", event: { type: "ui_answered", requestId: args.id } });
    return null;
  }

  /** The host requests still waiting, oldest first: a page that opens the chat again shows them. */
  openRequests(args: { threadId: ThreadId }): OpenHostRequests {
    const open: OpenHostRequests = [];
    for (const { request, seq } of this.#entry(args.threadId).openRequests.values()) {
      if (seq !== undefined) open.push({ seq, request });
    }
    return open.sort((left, right) => left.seq - right.seq);
  }

  /** The UI state the chat holds (statuses, widgets, the title), oldest first. */
  uiState(args: { threadId: ThreadId }): UiState {
    return [...this.#entry(args.threadId).uiState.values()].sort(
      (left, right) => left.seq - right.seq,
    );
  }

  subscribe(args: SubscribeArgs): { stream: StreamKey } {
    return { stream: this.#entry(args.threadId).stream };
  }

  /** Starts the chat's process again, resumed from its file; a running process is stopped first, ending its turn. */
  async restart(args: { threadId: ThreadId }): Promise<null> {
    await this.#startRespawn(this.#entry(args.threadId));
    return null;
  }

  /** Pauses or resumes every chat this server runs; a chat whose omp started before pause existed stays as it is. */
  async pauseAll(args: PauseAllArgs): Promise<PauseAllResult> {
    const method = args.paused ? "pause" : "resume";
    this.#context.logger?.info("chat_session.pause_all_asked", { method });
    const answers = await Promise.allSettled(
      [...this.#entries.values()]
        .filter((entry) => this.#isRunning(entry))
        .map((entry) => this.#send(entry, method, {})),
    );
    return { chats: answers.filter((answer) => answer.status === "fulfilled").length };
  }

  /** The chat's process is up, and no restart of it is under way. */
  #isRunning(entry: ChatEntry): boolean {
    const status = entry.process.status;
    return (
      entry.respawning === undefined &&
      status !== "exited" &&
      status !== "error" &&
      status !== "stopped"
    );
  }

  async close(args: { threadId: ThreadId }, call: PortHandlerContext): Promise<null> {
    const entry = this.#entryOrUndefined(args.threadId);
    if (entry === undefined) return null;
    const viewed = (entry.viewers.get(call.connectionId) ?? 0) > 0;
    this.#releaseView(entry, call.connectionId);
    if (!viewed) return null;
    entry.preferences.delete(call.connectionId);
    // The connection's last view of the chat takes its tools and URI schemes with it.
    if (!entry.viewers.has(call.connectionId)) {
      await this.#releaseRegistrations(entry, call.connectionId);
    }
    // Only a chat others still watch is told the viewers' preferences again: the last view leaving tells the host nothing.
    if (entry.viewers.size > 0) await this.#arbitrateQuietly(entry);
    return null;
  }

  /**
   * A browser connection closed (a tab closed or reloaded, the network lost): every view it held is released, as if it
   * had closed each one, with its tools, URI schemes and preferences. A process nobody watches is stopped by the
   * registry after its idle time, unless it is working.
   */
  async releaseConnection(connectionId: string): Promise<void> {
    // A refused delete's chat opening again for this connection gives it no view back.
    const pending = this.#pendingReopens.get(connectionId);
    if (pending !== undefined) pending.closed = true;
    const stillWatched: ChatEntry[] = [];
    for (const entry of [...new Set(this.#entries.values())]) {
      const count = entry.viewers.get(connectionId) ?? 0;
      if (count === 0) continue;
      entry.viewers.delete(connectionId);
      entry.preferences.delete(connectionId);
      for (let view = 0; view < count; view += 1) {
        this.#context.processRegistry.release(entry.bootstrap.threadId);
      }
      await this.#releaseRegistrations(entry, connectionId);
      if (entry.viewers.size > 0) stillWatched.push(entry);
    }
    await Promise.all(stillWatched.map((entry) => this.#arbitrateQuietly(entry)));
  }

  /** How many views one connection holds on a chat. */
  viewsOf(threadId: ThreadId, connectionId: string): number {
    return this.#entryOrUndefined(threadId)?.viewers.get(connectionId) ?? 0;
  }

  /** How many views every connection holds on a chat together: the count the chat's process is watched by. */
  watcherCount(threadId: ThreadId): number {
    let total = 0;
    for (const count of this.#entryOrUndefined(threadId)?.viewers.values() ?? []) total += count;
    return total;
  }

  /** Lets go of every view one connection holds on a chat, as deleting the chat does; other connections keep theirs. */
  async releaseViews(threadId: ThreadId, connectionId: string): Promise<void> {
    const entry = this.#entryOrUndefined(threadId);
    const count = entry?.viewers.get(connectionId) ?? 0;
    if (entry === undefined || count === 0) return;
    entry.viewers.delete(connectionId);
    entry.preferences.delete(connectionId);
    for (let view = 0; view < count; view += 1) {
      this.#context.processRegistry.release(entry.bootstrap.threadId);
    }
    await this.#releaseRegistrations(entry, connectionId);
    if (entry.viewers.size > 0) await this.#arbitrateQuietly(entry);
  }

  /**
   * Gives a connection back the views a delete's stop took from it, joined to the chat's running process. A chat no
   * running process serves gets nothing: no process starts for it.
   */
  restoreViews(threadId: ThreadId, connectionId: string, count: number): void {
    const entry = this.#entryOrUndefined(threadId);
    const registry = this.#context.processRegistry;
    if (entry === undefined || !registry.has(entry.bootstrap.threadId)) return;
    if (registry.isStopping(entry.bootstrap.threadId)) return;
    const missing = count - (entry.viewers.get(connectionId) ?? 0);
    for (let view = 0; view < missing; view += 1) {
      registry.acquire(this.#processOptions(entry.bootstrap));
      this.#addViewer(entry, connectionId);
    }
  }

  async dispose(): Promise<void> {
    // The new chats kept ready hold no chat: they stop, and no server after this one finds them (D2).
    this.#closed = true;
    this.#usageResume?.close();
    this.#stopUsageWatch();
    this.#usagePause?.close();
    const spares = [...this.#spares.values()];
    this.#spares.clear();
    await Promise.all(spares.map((spare) => this.#discardSpare(spare)));
    for (const entry of new Set(this.#entries.values())) {
      entry.unsubscribe();
      entry.client.dispose();
    }
    this.#entries.clear();
    this.#aliases.clear();
    await this.#context.processRegistry.closeAll();
  }

  /** A chat's entry, before its process starts: nothing viewed, nothing registered, nothing open. */
  #newEntry(bootstrap: ThreadBootstrap, process: OmpProcess): ChatEntry {
    return {
      bootstrap,
      process,
      client: new ChatHostClient(process),
      stream: chatSessionEventStream(bootstrap.threadId),
      unsubscribe: () => undefined,
      viewers: new Map(),
      startupEvents: [],
      rekeyed: false,
      methods: [],
      startedAt: Date.now(),
      openRequests: new Map(),
      uiState: new Map(),
      hostTools: new Map(),
      hostUriSchemes: new Map(),
      hostRegistrations: Promise.resolve(),
      askDialogOptedIn: false,
      formDialogOptedIn: false,
      preferences: new Map(),
      arbitration: Promise.resolve(),
      payloadListeners: new Set(),
    };
  }

  /**
   * Starts the chat's process and waits for its host's hello. A host that was running before this server (D2,
   * `replayLive`) is then asked for what is live: a run under way, the messages being written, the tools that run and
   * the questions waiting, which reach this chat's handlers, set before it starts (`#listen`).
   */
  async #start(entry: ChatEntry, options: { readonly replayLive?: boolean } = {}): Promise<void> {
    this.#awaitingHello.add(entry);
    let hello: Awaited<ChatHostClient["hello"]>;
    try {
      await entry.process.start();
      try {
        hello = await entry.client.hello;
      } catch {
        throw new AppFailure(failedStart());
      }
    } finally {
      this.#awaitingHello.delete(entry);
    }
    entry.methods = hello.methods;
    if (options.replayLive === true) await entry.client.request("replay_live", {});
    this.#receive(entry, { kind: "process", status: "ready", startedAt: entry.startedAt });
  }

  /**
   * Restarts the chat on this server's omp once it has settled (`restartWhenSettled`); checked again when it settles.
   * omp writes a chat's file only once it has a reply, so a chat with none (a spare an earlier server kept ready for a
   * new chat) has nothing a restart could resume: nobody holding it, its host is stopped instead, and this server makes
   * spares of its own on its own build. One a page holds keeps running until its first reply is saved, and is restarted
   * once that reply has settled.
   */
  async #restartIfSettled(entry: ChatEntry): Promise<void> {
    if (entry.restartWhenSettled !== true) return;
    if (!(await this.#isSettled(entry.bootstrap.threadId).catch(() => false))) return;
    if (entry.restartWhenSettled !== true || this.#entries.get(entry.bootstrap.threadId) !== entry)
      return;
    entry.restartWhenSettled = false;
    const { threadId, sessionFile } = entry.bootstrap;
    if (!(await this.#hasSessionFile(sessionFile))) {
      const registry = this.#context.processRegistry;
      if (registry.watched(threadId)) {
        entry.restartWhenSettled = true;
        return;
      }
      this.#context.logger?.info("chat_session.unsaved_host_stopped", { threadId });
      this.#forget(entry);
      await registry.stopIfUnwatched(threadId, "opened").catch(() => undefined);
      return;
    }
    await this.#startRespawn(entry).catch((error: unknown) =>
      this.#context.logger?.warn("chat_session.restart_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** The host's events, its requests and the process's life, into the chat's stream. */
  #listen(entry: ChatEntry): () => void {
    const fromHost = entry.client.onEvent((event) =>
      this.#receive(entry, { kind: "event", event }),
    );
    entry.client.onRequest((request) => this.#hostRequest(entry, request));
    const fromProcess = entry.process.onEvent((event) => {
      // A process that ends before its host's hello is a failed start: the chat says so in the start's words, as omp's
      // RPC port did, not with the exit's code or signal.
      const error =
        event.error !== undefined && this.#awaitingHello.has(entry) ? failedStart() : event.error;
      this.#receive(entry, {
        kind: "process",
        status: event.status,
        startedAt: entry.startedAt,
        ...(error === undefined ? {} : { error }),
      });
    });
    return () => {
      fromHost();
      fromProcess();
    };
  }

  #receive(entry: ChatEntry, payload: ChatSessionEvent): void {
    // The events of a process that is stopping, its exit among them, reach no viewer and no replay.
    if (this.#context.processRegistry.isStopping(entry.bootstrap.threadId)) return;
    if (payload.kind === "event") this.#trackTurn(entry.bootstrap.threadId, payload.event);
    if (!entry.rekeyed) {
      entry.startupEvents.push(payload);
      return;
    }
    this.#publish(entry, payload);
  }

  /** Publishes on the chat's stream, and keeps the open requests and the UI state in step with what was published. */
  #publish(entry: ChatEntry, payload: ChatSessionEvent): void {
    const { seq } = this.#context.replay.publish(entry.stream, payload);
    for (const listener of [...entry.payloadListeners]) listener(payload);
    if (payload.kind === "host_request") {
      const open = entry.openRequests.get(payload.request.id);
      if (open !== undefined) open.seq = seq;
      return;
    }
    if (payload.kind === "process") {
      // A process that has ended can take no answer.
      if (payload.status === "exited" || payload.status === "error") this.#closeRequests(entry);
      return;
    }
    if (payload.kind !== "event") return;
    const { event } = payload;
    if (event.type === "ui_cancel" || event.type === "tool_cancel" || event.type === "uri_cancel") {
      this.#closeRequest(entry, event.requestId);
    } else if (isUiStateEvent(event)) {
      if (clearsUiState(event)) entry.uiState.delete(uiStateKey(event));
      else entry.uiState.set(uiStateKey(event), { seq, event });
    } else if (event.type === "session_settled" && entry.restartWhenSettled === true) {
      void this.#restartIfSettled(entry);
    } else if (
      event.type === "notice" &&
      event.source === "session-persistence" &&
      event.level === "warning"
    ) {
      // omp moved the chat to a new file (another omp holds its file, or the file changed under it); omp's RPC mode says so
      // with this notice (18.18.5 `modes/rpc/rpc-mode.ts`, `onPersistenceNotice`), as the host does. The chat goes on under
      // its new id: every view follows (`moved`), and the old id stays an alias.
      void this.#refreshIdentity(entry).catch((error: unknown) =>
        this.#context.logger?.warn("chat_session.move_failed", {
          threadId: entry.bootstrap.threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (event.type === "question_record") {
      // Every chat's questions, for the dashboard: asked, answered and held, or sent.
      const { threadId, folderPath } = entry.bootstrap;
      this.#context.questions?.record(threadId, folderPath, event.record);
    }
  }

  /**
   * A host request waits in the open requests until the browser answers it or the host gives it up. The to-do list's
   * tool (`app.todos`) is answered here, from the list, and reaches no page. A call of a tool or URI scheme that no open
   * page gives fails at once: no page may answer it, and a page that gives it again runs only the calls that come after,
   * so it would wait until you stop the turn.
   */
  #hostRequest(entry: ChatEntry, request: HostRequest): Promise<unknown> {
    if (request.method === "app.todos") {
      const todos = this.#context.todos;
      if (todos === undefined) {
        return Promise.resolve({
          content: [{ type: "text", text: "This app keeps no to-do list." }],
          isError: true,
        });
      }
      const { threadId, folderPath } = entry.bootstrap;
      return todos.agentCall({ threadId, folder: folderPath }, request.params);
    }
    if (answererOf(entry, request) === undefined) {
      void this.#dropLeftovers(entry, isHostToolCall(request) ? "tools" : "schemes");
      return Promise.reject(new Error("The page that gave this tool to the chat has closed."));
    }
    return new Promise((resolve, reject) => {
      entry.openRequests.set(request.id, { request, at: Date.now(), resolve, reject });
      this.#waitingChanged();
      this.#receive(entry, { kind: "host_request", request });
    });
  }

  /** The host gave a request up (omp's abort or timeout, or the process ended): an answer would reach nothing. */
  #closeRequest(entry: ChatEntry, id: string): void {
    const open = entry.openRequests.get(id);
    if (open === undefined) return;
    entry.openRequests.delete(id);
    this.#waitingChanged();
    open.reject(new Error("The chat no longer waits for this answer."));
  }

  #closeRequests(entry: ChatEntry): void {
    for (const id of [...entry.openRequests.keys()]) this.#closeRequest(entry, id);
  }

  /**
   * Keeps the registry's busy mark in step with the chat: busy from `agent_start` until the session settles
   * (`session_settled`, or a `prompt_result` that reports it settled). A yielded run is not a settled session. The
   * registry also keeps the chat's pause (omp's `/pause`), as the host reports it, for the chat list, and the app's own
   * continue after a usage limit hears what the chat does (#2781).
   */
  #trackTurn(threadId: ThreadId, event: ChatEvent): void {
    this.#usageResume?.onEvent(threadId, event);
    if (event.type === "agent_start") {
      this.#context.processRegistry.setBusy(threadId, true);
    } else if (
      event.type === "session_settled" ||
      (event.type === "prompt_result" && event.sessionSettled)
    ) {
      this.#context.processRegistry.setBusy(threadId, false);
    } else if (event.type === "pause_changed") {
      this.#context.processRegistry.setPaused(threadId, event.pausedAt);
      this.#usagePause?.onPauseChanged(threadId, event.pausedAt);
      // Every hold of a chat's agents and its end, whatever asked for it (a page, a typed `/pause`, omp itself): a turn
      // that stops for no visible reason can be checked against these (Nov 1, a 2 h 27 min hold nothing logged).
      this.#context.logger?.info("chat_session.pause_changed", {
        threadId,
        paused: event.pausedAt !== null,
      });
    } else if (event.type === "session_info_update") {
      // omp named the chat (#2798): the list reads its title again.
      this.#context.processRegistry.noteTitleChanged(threadId);
    }
  }

  /** The chat's own id and file, from its state. */
  async #identity(
    entry: ChatEntry,
  ): Promise<{ threadId: ThreadId; sessionFile: SessionFilePath; messageCount: number }> {
    const state = await entry.client.request("get_state", {});
    if (state.sessionFile === undefined) {
      throw new AppFailure({
        code: "omp_error",
        message: "The chat opened without a session file.",
        retryable: false,
      });
    }
    return {
      threadId: ThreadId.parse(state.sessionId),
      sessionFile: SessionFilePath.parse(state.sessionFile),
      messageCount: state.messageCount,
    };
  }

  /** Moves the chat from its provisional id to its own, then publishes the events that waited for it. */
  #rekey(
    entry: ChatEntry,
    requestedThreadId: ThreadId | undefined,
    identity: { threadId: ThreadId; sessionFile: SessionFilePath },
  ): void {
    if (
      requestedThreadId !== undefined &&
      (identity.threadId !== requestedThreadId ||
        identity.sessionFile !== entry.bootstrap.sessionFile)
    ) {
      throw new AppFailure({
        code: "conflict",
        message: "The chat opened as a different chat than the one asked for. Try again.",
        retryable: false,
      });
    }
    this.#moveProcess(entry.bootstrap.threadId, identity.threadId);
    const provisional = entry.bootstrap.threadId;
    this.#entries.delete(provisional);
    entry.bootstrap = {
      ...entry.bootstrap,
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    };
    entry.stream = chatSessionEventStream(identity.threadId);
    this.#entries.set(identity.threadId, entry);
    entry.rekeyed = true;
    for (const payload of entry.startupEvents.splice(0)) {
      this.#publish(entry, payload);
    }
  }

  async #resolveBootstrap(args: OpenThreadArgs, signal: AbortSignalLike): Promise<ThreadBootstrap> {
    if ("threadId" in args) {
      const existing = this.#entries.get(args.threadId);
      if (existing !== undefined) return existing.bootstrap;
      const resolved = await this.#context.resolveThread(args.threadId, signal);
      if (resolved === undefined) throw notFound(`Thread ${args.threadId} was not found`);
      if (!(await this.#hasSessionFile(resolved.sessionFile))) {
        throw notFound(`Session file not found: ${resolved.sessionFile}`);
      }
      // omp moved the chat to another file while another omp held it: the newest copy is opened, as omp's own resume
      // opens it, or joined when it runs here (`modules/A1/sessions/continuation.ts`). The open's answer names it.
      const copy = await newestCopy(resolved.sessionFile, args.threadId);
      const threadId = copy === undefined ? resolved.threadId : ThreadId.parse(copy.id);
      if (copy !== undefined) {
        const running = this.#entries.get(threadId);
        if (running !== undefined) return running.bootstrap;
      }
      const sessionFile =
        copy === undefined ? resolved.sessionFile : SessionFilePath.parse(copy.file);
      return {
        ...resolved,
        threadId,
        sessionFile,
        args: ["--resume", sessionFile, ...modelArgs(args.model)],
        ...(args.model === undefined ? {} : { model: args.model }),
      };
    }
    if (args.start === "new") return this.#provisionalBootstrap(args.folderPath, []);
    // omp's --continue opens the folder's newest chat but says which only once it runs, when it has begun to write it.
    // So the chat is found first: one this server already runs is refused, and no process starts.
    const latest = await this.#context.latestThread(args.folderPath, signal);
    if (latest !== undefined) {
      await this.#context.processRegistry.whenGone(latest.threadId, "opened");
      if (this.#context.processRegistry.has(latest.threadId)) throw chatOpenElsewhere();
    }
    return this.#provisionalBootstrap(args.folderPath, ["--continue"]);
  }

  /** A chat before its own id is known: keyed by a provisional id that `#rekey` replaces, as A0's RPC runtime keys it. */
  #provisionalBootstrap(folderPath: FolderPath, args: readonly string[]): ThreadBootstrap {
    const threadId = ThreadId.parse(`provisional-${crypto.randomUUID()}`);
    const sessionFile = SessionFilePath.parse(join(folderPath, ".omp", `${threadId}.jsonl`));
    return { threadId, folderPath, sessionFile, args };
  }

  /**
   * Refuses a chat another omp holds, before this open starts one. A held lease no process of this app backs is a
   * terminal's: omp would load the file, then move the chat to a new id.
   */
  async #refuseChatHeldElsewhere(bootstrap: ThreadBootstrap): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (
        entry.bootstrap.sessionFile === bootstrap.sessionFile &&
        this.#context.processRegistry.has(entry.bootstrap.threadId)
      ) {
        return;
      }
    }
    if ((await this.#context.leaseProbe?.(bootstrap.threadId)) !== "active") {
      this.#handingBack.delete(bootstrap.threadId);
      return;
    }
    if (this.#handingBack.has(bootstrap.threadId)) {
      throw new AppFailure({
        code: "conflict",
        message:
          "This chat is finishing a reply it started before the app was updated. It opens here once that reply is done.",
        retryable: true,
        conflictReason: "held_elsewhere",
      });
    }
    throw new AppFailure({
      code: "conflict",
      message:
        "This chat is open in another omp, for example in a terminal. Close it there, then open it here.",
      retryable: true,
      conflictReason: "held_elsewhere",
    });
  }

  /** Brings the chat's process back before a request when it stopped under the chat or its repair is under way. */
  async #ensureRunning(entry: ChatEntry): Promise<void> {
    const status = entry.process.status;
    const stopped = status === "exited" || status === "error" || status === "stopped";
    if (entry.respawning === undefined && !stopped) return;
    await this.#startRespawn(entry);
  }

  #startRespawn(entry: ChatEntry): Promise<void> {
    if (entry.respawning !== undefined) return entry.respawning;
    const attempt = this.#respawn(entry).finally(() => {
      entry.respawning = undefined;
    });
    entry.respawning = attempt;
    return attempt;
  }

  /** A new process for the chat, resumed from its file; the chat's viewers hear it on the chat's own stream. */
  async #respawn(entry: ChatEntry): Promise<void> {
    const { threadId, folderPath, sessionFile } = entry.bootstrap;
    if (!(await this.#hasSessionFile(sessionFile))) {
      throw new AppFailure({
        code: "omp_exited",
        message:
          "omp stopped before this chat was saved, so it can't be continued. Start a new chat.",
        retryable: false,
      });
    }
    const args = ["--resume", sessionFile, ...modelArgs(entry.bootstrap.model)];
    // The registry stops the old process (already gone after a crash) and keeps the chat's viewers.
    const process = await this.#context.processRegistry.respawn({
      threadId,
      folder: folderPath,
      args,
    });
    entry.unsubscribe();
    entry.client.dispose();
    // The replaced process's questions can never be answered, and its UI state goes with it.
    this.#closeRequests(entry);
    entry.uiState.clear();
    entry.appliedLevel = undefined;
    entry.appliedMessageUpdates = undefined;
    entry.bootstrap = { ...entry.bootstrap, args };
    entry.process = process;
    entry.client = new ChatHostClient(process);
    entry.startedAt = Date.now();
    entry.unsubscribe = this.#listen(entry);
    await this.#start(entry);
    await this.#reapply(entry);
    // Only what a viewer asked for is told to the new process; a chat nobody tuned keeps the host's defaults.
    if (entry.preferences.size > 0) await this.#arbitrate(entry);
  }

  /** Whether the chat's host says it has settled; a chat nothing holds counts as settled. */
  async #isSettled(threadId: ThreadId): Promise<boolean> {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined) return true;
    return (await entry.client.request("get_state", {})).isSettled;
  }

  /**
   * Runs a chat's turn that a usage limit stopped again, as its Retry does (omp's `/retry`), once the app's continue is
   * due (#2781). Only a chat this server still serves under that id, with no turn running and not paused, is continued.
   * Whether a turn runs is the chat's host's answer now, not the registry's busy mark: that lasts until the session
   * settles, and a background job still running holds that off for as long as it runs (2026-11-01 19:31: a continue
   * read the mark, found the chat busy and was lost).
   */
  async #continueAfterLimit(threadId: ThreadId): Promise<ResumeOutcome> {
    const registry = this.#context.processRegistry;
    const entry = this.#entryOrUndefined(threadId);
    if (
      entry === undefined ||
      entry.bootstrap.threadId !== threadId ||
      registry.isStopping(threadId)
    ) {
      return "gone";
    }
    if ((registry.pausedOf(threadId) ?? null) !== null) return "paused";
    await this.#ensureRunning(entry);
    const state = await entry.client.request("get_state", {});
    if (state.isStreaming || state.isCompacting) return "busy";
    await entry.client.send("prompt", { text: "/retry" }).answer;
    return "sent";
  }

  /**
   * The registry stopped a chat's process on purpose: its entry can't serve again, so the next open starts fresh. A stop
   * that a refused delete waited on past the limit keeps the views its tabs held: the chat is opened again for them.
   */
  #forgetStopped(threadId: ThreadId, process: OmpProcess, refusedDelete: boolean): void {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || entry.process !== process) return;
    const kept = refusedDelete ? [...entry.viewers] : [];
    this.#forget(entry);
    if (kept.length > 0) void this.#reopenAfterStop(entry.bootstrap.threadId, kept);
  }

  /**
   * Opens a refused delete's chat again for the tabs that held views on it when its host stopped. The delete did not
   * remove the chat, so its file is still there. A chat another omp holds stays closed, so no host starts on a file
   * another omp writes; a tab that closes meanwhile does not get its view back.
   */
  async #reopenAfterStop(
    threadId: ThreadId,
    kept: readonly (readonly [string, number])[],
  ): Promise<void> {
    const signal = new AbortController().signal;
    const pending = new Map<string, { closed: boolean }>();
    for (const [connectionId] of kept) {
      const record = this.#pendingReopens.get(connectionId) ?? { closed: false };
      this.#pendingReopens.set(connectionId, record);
      pending.set(connectionId, record);
    }
    try {
      const resolved = await this.#context.resolveThread(threadId, signal);
      if (resolved === undefined) return;
      const other = await this.#context.externalOmp(threadId, resolved.sessionFile, undefined);
      if (other !== "none") return;
      for (const [connectionId, count] of kept) {
        // Read through a function: the record changes while an open waits.
        const closed = (): boolean => pending.get(connectionId)?.closed === true;
        for (let view = 0; view < count && !closed(); view += 1) {
          await this.open(
            { threadId },
            {
              connectionId,
              signal,
              requestId: RequestId.parse(`reopen-${threadId}`),
              portContext: undefined,
            },
          );
          if (closed()) await this.releaseViews(threadId, connectionId);
        }
      }
    } catch (error) {
      this.#context.logger?.warn("chat_session.reopen_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const [connectionId, record] of pending) {
        if (this.#pendingReopens.get(connectionId) === record) {
          this.#pendingReopens.delete(connectionId);
        }
      }
    }
  }

  #forget(entry: ChatEntry): void {
    entry.unsubscribe();
    entry.client.dispose();
    this.#closeRequests(entry);
    const current = entry.bootstrap.threadId;
    this.#entries.delete(current);
    for (const [alias, target] of this.#aliases) {
      if (alias === current || target === current) this.#aliases.delete(alias);
    }
  }

  /** Forgets an entry whose open failed, and lets go of the process it acquired. */
  #dropEntry(entry: ChatEntry): void {
    this.#forget(entry);
    this.#context.processRegistry.release(entry.bootstrap.threadId);
  }

  #addViewer(entry: ChatEntry, connectionId: string): void {
    entry.viewers.set(connectionId, (entry.viewers.get(connectionId) ?? 0) + 1);
  }

  /** Lets go of one open's view of a chat: the chat's process stays for any other view. */
  #releaseView(entry: ChatEntry, connectionId: string): void {
    const count = entry.viewers.get(connectionId) ?? 0;
    if (count === 0) return;
    if (count === 1) entry.viewers.delete(connectionId);
    else entry.viewers.set(connectionId, count - 1);
    this.#context.processRegistry.release(entry.bootstrap.threadId);
  }

  /** Host registrations are released with a connection's views, so only a viewer may make one. */
  #requireViewer(entry: ChatEntry, connectionId: string): void {
    if ((entry.viewers.get(connectionId) ?? 0) > 0) return;
    throw notFound(
      "Open this chat on this connection before registering host tools or URI schemes.",
    );
  }

  async #send<M extends ChatHostMethod>(
    entry: ChatEntry,
    method: M,
    params: ChatHostMethodMap[M]["params"],
  ): Promise<ChatHostMethodMap[M]["result"]> {
    try {
      return await entry.client.request(method, params);
    } catch (error) {
      throw requestFailure(method, error);
    }
  }

  /** One registration after another, so two owners' writes cannot cross. */
  #serializeRegistrations<T>(entry: ChatEntry, operation: () => Promise<T>): Promise<T> {
    const current = entry.hostRegistrations.then(operation, operation);
    entry.hostRegistrations = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #registerTools(
    entry: ChatEntry,
    connectionId: string,
    owner: string,
    tools: readonly HostToolDefinition[],
  ): Promise<{ toolNames: string[] }> {
    return this.#serializeRegistrations(entry, async () => {
      const next = withOwner(entry.hostTools, connectionId, owner, tools);
      const { toolNames } = await this.#send(entry, "set_host_tools", {
        tools: merged(next, toolName),
      });
      entry.hostTools = next;
      const own = new Set(tools.map(toolName));
      return { toolNames: toolNames.filter((name) => own.has(name)) };
    });
  }

  #registerUriSchemes(
    entry: ChatEntry,
    connectionId: string,
    owner: string,
    schemes: readonly HostUriSchemeDefinition[],
  ): Promise<{ schemes: string[] }> {
    return this.#serializeRegistrations(entry, async () => {
      const next = withOwner(entry.hostUriSchemes, connectionId, owner, schemes);
      const result = await this.#send(entry, "set_host_uri_schemes", {
        schemes: merged(next, schemeName),
      });
      entry.hostUriSchemes = next;
      const own = new Set(schemes.map(schemeName));
      return { schemes: result.schemes.filter((scheme) => own.has(scheme)) };
    });
  }

  /**
   * A connection's tools and URI schemes leave the chat with its last view, and the calls of them still waiting fail at
   * once, since nothing else can answer them; a write that fails is logged.
   */
  #releaseRegistrations(entry: ChatEntry, connectionId: string): Promise<void> {
    return this.#serializeRegistrations(entry, async () => {
      const hadTools = entry.hostTools.has(connectionId);
      const hadSchemes = entry.hostUriSchemes.has(connectionId);
      if (!hadTools && !hadSchemes) return;
      const orphaned = [...entry.openRequests.entries()].filter(
        ([, open]) => answererOf(entry, open.request) === connectionId,
      );
      const tools = new Map(entry.hostTools);
      tools.delete(connectionId);
      const schemes = new Map(entry.hostUriSchemes);
      schemes.delete(connectionId);
      entry.hostTools = tools;
      entry.hostUriSchemes = schemes;
      for (const [id, open] of orphaned) {
        entry.openRequests.delete(id);
        open.reject(new Error("The page that gave this tool to the chat has closed."));
      }
      if (orphaned.length > 0) this.#waitingChanged();
      const writes: Promise<unknown>[] = [];
      if (hadTools)
        writes.push(this.#send(entry, "set_host_tools", { tools: merged(tools, toolName) }));
      if (hadSchemes) {
        writes.push(
          this.#send(entry, "set_host_uri_schemes", { schemes: merged(schemes, schemeName) }),
        );
      }
      for (const write of await Promise.allSettled(writes)) {
        if (write.status === "rejected") {
          this.#context.logger?.warn("chat_session.registrations_release_failed", {
            message: write.reason instanceof Error ? write.reason.message : String(write.reason),
          });
        }
      }
    });
  }

  /**
   * omp still has tools or URI schemes no open page gives: those of a page that closed as omp called one, or of a page of
   * the server before a restart, which could not take them back as it stopped. It is told the ones the pages give now,
   * so the agent stops calling the others; a write that fails is logged.
   */
  #dropLeftovers(entry: ChatEntry, kind: "tools" | "schemes"): Promise<void> {
    return this.#serializeRegistrations(entry, async () => {
      try {
        if (kind === "tools") {
          await this.#send(entry, "set_host_tools", { tools: merged(entry.hostTools, toolName) });
        } else {
          await this.#send(entry, "set_host_uri_schemes", {
            schemes: merged(entry.hostUriSchemes, schemeName),
          });
        }
      } catch (error) {
        this.#context.logger?.warn("chat_session.registrations_release_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /** A replaced process is told what the old one was: the app's registrations and the ask-dialog opt-in. */
  async #reapply(entry: ChatEntry): Promise<void> {
    await this.#serializeRegistrations(entry, async () => {
      if (entry.hostTools.size > 0) {
        await this.#send(entry, "set_host_tools", { tools: merged(entry.hostTools, toolName) });
      }
      if (entry.hostUriSchemes.size > 0) {
        await this.#send(entry, "set_host_uri_schemes", {
          schemes: merged(entry.hostUriSchemes, schemeName),
        });
      }
    });
    if (entry.askDialogOptedIn) await this.#send(entry, "set_ask_dialog", { enabled: true });
    if (entry.formDialogOptedIn && entry.methods.includes("set_form_dialog")) {
      await this.#send(entry, "set_form_dialog", { enabled: true });
    }
  }

  /** The entry a thread id names: its own, or the one it moved to by a session switch. */
  #entryOrUndefined(threadId: ThreadId): ChatEntry | undefined {
    const own = this.#entries.get(threadId);
    if (own !== undefined) return own;
    let current = threadId;
    const seen = new Set<ThreadId>();
    for (
      let next = this.#aliases.get(current);
      next !== undefined && !seen.has(current);
      next = this.#aliases.get(current)
    ) {
      seen.add(current);
      current = next;
    }
    return this.#entries.get(current);
  }

  /** The entry a thread id names; a chat whose process is stopping serves nothing. */
  #entry(threadId: ThreadId): ChatEntry {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || this.#context.processRegistry.isStopping(entry.bootstrap.threadId)) {
      throw notFound(`No open thread ${threadId}`);
    }
    return entry;
  }

  /**
   * A request to a chat no host here serves. When another omp holds the chat, it is refused with the sentence that says
   * so: nothing is sent and no host starts on the file. Otherwise this returns, and `#entry` refuses as before.
   */
  async #refuseWhenHeldElsewhere(threadId: ThreadId, signal: AbortSignalLike): Promise<void> {
    const resolved = await this.#context.resolveThread(threadId, signal);
    if (resolved === undefined) return;
    const other = await this.#context.externalOmp(threadId, resolved.sessionFile, undefined);
    if (other !== "running") return;
    throw new AppFailure({
      code: "conflict",
      message:
        "Another omp has this chat open, so nothing was sent. Close that omp, then reload this page.",
      retryable: true,
    });
  }

  #preference(entry: ChatEntry, connectionId: string): Preference {
    return entry.preferences.get(connectionId) ?? { level: "off" };
  }

  /**
   * The viewers' preferences as one, told to the chat's host when they changed: the highest subagent level, and `full`
   * message updates when any viewer asks for them, else `delta`. With no viewer asking, the host's own default (`full`)
   * comes back.
   */
  #arbitrate(entry: ChatEntry): Promise<void> {
    const work = entry.arbitration.then(async () => {
      const preferences = [...entry.preferences.values()];
      const level = preferences.reduce<SubagentLevel>(
        (best, preference) =>
          LEVEL_RANK[preference.level] > LEVEL_RANK[best] ? preference.level : best,
        "off",
      );
      const messageUpdates: MessageUpdates | undefined = preferences.some(
        (preference) => preference.messageUpdates === "full",
      )
        ? "full"
        : preferences.some((preference) => preference.messageUpdates === "delta")
          ? "delta"
          : undefined;
      if (entry.appliedLevel !== level) {
        await this.#send(entry, "set_subagent_subscription", { level });
        entry.appliedLevel = level;
      }
      if (messageUpdates !== entry.appliedMessageUpdates) {
        await this.#send(entry, "set_event_options", { messageUpdates: messageUpdates ?? "full" });
        entry.appliedMessageUpdates = messageUpdates;
      }
    });
    entry.arbitration = work.catch(() => undefined);
    return work;
  }

  /** An arbitration a viewer leaving starts: its failure is logged, not the leaving connection's. */
  async #arbitrateQuietly(entry: ChatEntry): Promise<void> {
    await this.#arbitrate(entry).catch((error: unknown) =>
      this.#context.logger?.warn("chat_session.arbitration_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * A `!` or `$` run, which omp reports only to its caller: every viewer hears it start and end, and the process is held
   * while it runs. A viewer giving up does not end the run.
   */
  async #shellRun(
    entry: ChatEntry,
    method: "bash" | "python",
    params: ChatHostMethodMap["bash" | "python"]["params"],
  ): Promise<ShellRunResult> {
    const release = this.#context.processRegistry.holdCommand(entry.bootstrap.threadId);
    const startedAt = Date.now();
    const input = "command" in params ? params.command : params.code;
    this.#receive(entry, { kind: "shell", method, input, status: "running", startedAt });
    let result: ShellRunResult | undefined;
    try {
      result = await this.#send(entry, method, params as never);
      return result;
    } finally {
      this.#receive(entry, {
        kind: "shell",
        method,
        input,
        status: "ended",
        startedAt,
        ...(result === undefined ? {} : { result }),
      });
      release();
    }
  }

  #watchPayloads(entry: ChatEntry, listener: (payload: ChatSessionEvent) => void): () => void {
    entry.payloadListeners.add(listener);
    return () => entry.payloadListeners.delete(listener);
  }

  /**
   * A prompt for the A1 gateway. The host's answer says whether a result follows; the result is the `prompt_result` that
   * carries this request's own id. A host that ends meanwhile fails the run, and an aborted signal gives up the wait
   * while omp's run goes on.
   */
  #commandPrompt(
    entry: ChatEntry,
    text: string,
    signal: AbortSignalLike | undefined,
  ): CommandPromptFuture {
    let requestId: string | undefined;
    const result = Promise.withResolvers<PromptResultEvent>();
    void result.promise.catch(() => undefined);
    const stop = this.#watchPayloads(entry, (payload) => {
      if (
        payload.kind === "process" &&
        (payload.status === "exited" || payload.status === "error")
      ) {
        result.reject(
          new AppFailure({
            code: "omp_exited",
            message: "omp stopped before the command finished. Try again.",
            retryable: true,
          }),
        );
      } else if (
        payload.kind === "event" &&
        payload.event.type === "prompt_result" &&
        payload.event.requestId === requestId
      ) {
        result.resolve(payload.event);
      }
    });
    const onAbort = (): void => result.reject(cancelled("The command was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const answered = (async () => {
      if (signal?.aborted === true) throw cancelled("The command was cancelled.");
      await this.#ensureRunning(entry);
      const sent = entry.client.send("prompt", { text });
      requestId = sent.id;
      try {
        return await sent.answer;
      } catch (error) {
        throw requestFailure("prompt", error);
      }
    })();
    const admitted = answered.then((answer) => ({ agentInvoked: answer.resultFollows }));
    const outcome = answered
      .then(async (answer): Promise<CommandPromptOutcome> => {
        // A prompt omp handled where it stood (a built-in command, an extension's input hook) has no result to wait for.
        if (!answer.resultFollows) {
          return { agentInvoked: false, status: "completed", promptSettled: true };
        }
        const settled = await result.promise;
        return {
          agentInvoked: settled.agentInvoked,
          status: settled.status === "aborted" ? "aborted" : "completed",
          promptSettled: settled.agentInvoked ? settled.sessionSettled : true,
        };
      })
      .finally(() => {
        stop();
        signal?.removeEventListener("abort", onAbort);
      });
    return withAdmission(outcome, admitted);
  }

  /**
   * After a session switch, the chat moves to omp's new id for it: the registry is rekeyed, viewers on the old id hear
   * the move, the stream carries on under the new id with its history, and the old id stays an alias.
   */
  async #refreshIdentity(entry: ChatEntry): Promise<void> {
    const identity = await this.#identity(entry);
    const current = entry.bootstrap.threadId;
    if (identity.threadId === current && identity.sessionFile === entry.bootstrap.sessionFile)
      return;
    const existing = this.#entries.get(identity.threadId);
    if (existing !== undefined && existing !== entry) {
      throw new AppFailure({
        code: "conflict",
        message: "omp switched to a session already open in another chat.",
        retryable: false,
      });
    }
    // The registry's rekey can refuse; it runs first, so a refusal leaves the stream and the process as they were.
    this.#moveProcess(current, identity.threadId);
    this.#usagePause?.move(current, identity.threadId);
    this.#publish(entry, {
      kind: "moved",
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    });
    const stream = chatSessionEventStream(identity.threadId);
    this.#context.replay.moveStream(entry.stream, stream);
    this.#aliases.set(current, identity.threadId);
    this.#entries.delete(current);
    entry.bootstrap = {
      ...entry.bootstrap,
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    };
    entry.stream = stream;
    this.#entries.set(identity.threadId, entry);
  }

  /** Moves a process to the chat's own id; the registry refuses an id another process holds (a chat open elsewhere). */
  #moveProcess(from: ThreadId, to: ThreadId): void {
    try {
      this.#context.processRegistry.rekey(from, to);
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict")
        throw chatOpenElsewhere(error);
      throw error;
    }
  }

  #openResult(entry: ChatEntry): ChatOpenResult {
    return {
      threadId: entry.bootstrap.threadId,
      sessionFile: entry.bootstrap.sessionFile,
      methods: [...entry.methods],
    };
  }

  #processOptions(bootstrap: ThreadBootstrap): OmpProcessOptions {
    return { threadId: bootstrap.threadId, folder: bootstrap.folderPath, args: bootstrap.args };
  }

  #hasSessionFile(sessionFile: SessionFilePath): Promise<boolean> {
    return this.#context.sessionFileExists
      ? this.#context.sessionFileExists(sessionFile)
      : Bun.file(sessionFile).exists();
  }
}

export interface ChatSessionPortRegistration {
  readonly port: typeof ChatSessionPort;
  readonly runtime: ChatSessionPortRuntime;
}

export function createChatSessionPortRuntime(context: A0PortContext): ChatSessionPortRegistration {
  return { port: ChatSessionPort, runtime: new ChatSessionPortRuntime(context) };
}

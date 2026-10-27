/**
 * The chat host protocol, version 1 (SDK plan, module H5: `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.1 design").
 *
 * A chat host is one chat on omp's SDK in its own process. The server and the host exchange JSON lines over the host's
 * stdin and stdout, one object per line, each with a `kind`:
 * - from the host: `hello` (the first line, once the chat is ready), `response`, and `event`;
 * - from the server: `request`.
 *
 * Every request gets exactly one response with its `id`. Events are numbered `seq` = 1, 2, 3, … in the order the host
 * wrote them, and stdout keeps that order with the responses. omp's own objects (session events, models, images) keep
 * omp's shapes: the server and the host type them from omp's SDK, so this file holds only the envelope, the method names
 * and the app's own payloads.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { TodoStatus } from "@oh-my-pi/pi-tui/tools/todo";
import { z } from "zod";
import { type ParseResult, parseJson } from "../core/errors";
import { HostToolUpdateParams, SetHostToolsParams, SetHostUriSchemesParams } from "./host-tools";

/**
 * omp's session, for the types of its own objects in the protocol (the model, todos, usage, statistics). Type-only:
 * nothing of omp runs where this file is imported.
 */
type Session = AgentSession;

export { CHAT_HOST_CHAT_ARG } from "./args";
export * from "./dialogs";
export * from "./host-requests";
export * from "./host-tools";

export const CHAT_HOST_PROTOCOL_VERSION = 1;

const RequestId = z.string().min(1);

/**
 * Why a request failed. Besides the protocol's own, omp's codes the app tells apart: `session_busy` (work could still
 * write into the transcript), `unknown_since` (an entries cursor the session does not have), `stale_cursor` (a message
 * cursor from before the session changed).
 */
export const ChatHostErrorCode = z.enum([
  "unknown_method",
  "invalid_params",
  "failed",
  "session_busy",
  "unknown_since",
  "stale_cursor",
]);
export type ChatHostErrorCode = z.infer<typeof ChatHostErrorCode>;

export const ChatHostError = z.object({ code: ChatHostErrorCode, message: z.string() });
export type ChatHostError = z.infer<typeof ChatHostError>;

// Host → server

export const ChatHostHello = z.object({
  kind: z.literal("hello"),
  protocol: z.int(),
  /** The omp release the host was built from. */
  ompVersion: z.string(),
  /** The methods this host answers; a method not listed gets `unknown_method`. */
  methods: z.array(z.string()),
  session: z.object({ id: z.string(), file: z.string().nullable(), cwd: z.string() }),
});
export type ChatHostHello = z.infer<typeof ChatHostHello>;

export const ChatHostResponse = z.union([
  z.object({
    kind: z.literal("response"),
    id: RequestId,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    id: RequestId,
    ok: z.literal(false),
    error: ChatHostError,
  }),
]);
export type ChatHostResponse = z.infer<typeof ChatHostResponse>;

/** An event object: omp's session event, or one of the app's own (`prompt_result`). Passed on as it is, never copied. */
const EventPayload = z.custom<{ readonly type: string }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly type?: unknown }).type === "string",
  "expected an object with a string type",
);

export const ChatHostEvent = z.object({
  kind: z.literal("event"),
  seq: z.int().min(1),
  event: EventPayload,
});
/** One event line; `E` is the event type the reader knows (omp's session events and the app's own). */
export interface ChatHostEvent<E extends { readonly type: string } = { readonly type: string }> {
  readonly kind: "event";
  readonly seq: number;
  readonly event: E;
}

/**
 * A request. The server sends the protocol's methods; the host sends its own (`ChatHostHostMethodMap`: the dialogs).
 * Each side answers the other's requests with responses.
 */
export const ChatHostRequest = z.object({
  kind: z.literal("request"),
  id: RequestId,
  method: z.string().min(1),
  params: z.unknown(),
});
export type ChatHostRequest = z.infer<typeof ChatHostRequest>;

export const ChatHostHostLine = z.union([
  ChatHostHello,
  ChatHostResponse,
  ChatHostEvent,
  ChatHostRequest,
]);
export type ChatHostHostLine = ChatHostHello | ChatHostResponse | ChatHostEvent | ChatHostRequest;

/** Parses one line the host wrote. A failure names what is wrong, never the line itself. */
export function parseHostLine(line: string): ParseResult<ChatHostHostLine> {
  return parseJson(ChatHostHostLine, line);
}

// Server → host

export const ChatHostServerLine = z.union([ChatHostRequest, ChatHostResponse]);
export type ChatHostServerLine = ChatHostRequest | ChatHostResponse;

/** Parses one line the server wrote: a request, or an answer to one of the host's. A request's params are checked by `parseChatHostParams`. */
export function parseServerLine(line: string): ParseResult<ChatHostServerLine> {
  return parseJson(ChatHostServerLine, line);
}

// Methods

/** An image the user attached, in omp's shape (`ImageContent`): base64 data and its media type. */
export const ChatHostImage = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
export type ChatHostImage = z.infer<typeof ChatHostImage>;

export const PromptParams = z.object({
  text: z.string(),
  images: z.array(ChatHostImage).optional(),
  /** How a prompt sent while a reply streams is queued; without it, such a prompt fails as busy, as in omp. */
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});
export type PromptParams = z.infer<typeof PromptParams>;

/**
 * The answer to `prompt`, sent once omp admitted the prompt. With `resultFollows`, exactly one `prompt_result` event
 * with this request's id follows; without it, the prompt was handled where it stood (an extension's input hook took it,
 * a built-in command answered it, or it was empty) and nothing follows.
 */
export interface PromptAnswer {
  readonly resultFollows: boolean;
}

export const EmptyParams = z.object({});
export type EmptyParams = z.infer<typeof EmptyParams>;

/** How `message_update` events are sent: `full` carries the reply so far (`partial`), `delta` only the increment. */
export const EventOptions = z.object({ messageUpdates: z.enum(["full", "delta"]) });
export type EventOptions = z.infer<typeof EventOptions>;

/**
 * The chat's state, read with `get_state`: omp's own fields, as omp's session reports them. A field omp leaves undefined
 * is absent, as in omp's JSON.
 */
export interface ChatHostState {
  readonly model?: NonNullable<Session["model"]>;
  readonly thinkingLevel?: NonNullable<Session["thinkingLevel"]>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode: Session["steeringMode"];
  readonly followUpMode: Session["followUpMode"];
  readonly interruptMode: Session["interruptMode"];
  readonly sessionId: string;
  /** Absent for a chat that is not saved. */
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled: boolean;
  readonly messageCount: number;
  readonly queuedMessageCount: number;
  /** Background jobs or deliveries can still wake the session. */
  readonly hasPendingAsyncWork: boolean;
  /** Idle, nothing queued or admitted, nothing pending (omp's settle predicate). */
  readonly isSettled: boolean;
  readonly queuedMessages: ReturnType<Session["getQueuedMessages"]>;
  readonly todoPhases: ReturnType<Session["getTodoPhases"]>;
  readonly fastModeEnabled: boolean;
  readonly fastModeActive: boolean;
  readonly tokensPerSecond: ReturnType<typeof calculateTokensPerSecond>;
  readonly slowModeSupported: boolean;
  readonly slowModeEnabled: boolean;
  readonly slowModeScope?: NonNullable<ReturnType<Session["getSlowModeScope"]>>;
  readonly usageLimit?: NonNullable<ReturnType<Session["getUsageLimitState"]>>;
  readonly systemPrompt: Session["systemPrompt"];
  /** The session's tools as omp describes them for a session dump. */
  readonly dumpTools: readonly ChatHostToolDescriptor[];
  readonly contextUsage?: NonNullable<ReturnType<Session["getContextUsage"]>>;
  /** null when the chat has no goal. */
  readonly goal: NonNullable<ReturnType<Session["getGoalModeState"]>> | null;
}

export interface ChatHostToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** The tool's parameters as the provider sees them (omp's `toolWireSchema`). */
  readonly parameters: unknown;
  readonly examples?: unknown;
}

export const SetModelParams = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
export type SetModelParams = z.infer<typeof SetModelParams>;

/**
 * The thinking levels omp's session takes (`ConfiguredThinkingLevel`: omp's `ThinkingLevel` and `auto`), by name. The
 * mapped type makes a level omp adds or drops fail the typecheck here.
 */
const THINKING_LEVELS: { readonly [Level in `${ConfiguredThinkingLevel}`]: Level } = {
  inherit: "inherit",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  auto: "auto",
};

export const ThinkingLevelParams = z.object({ level: z.enum(THINKING_LEVELS) });
export type ThinkingLevelParams = z.infer<typeof ThinkingLevelParams>;

export const EnabledParams = z.object({ enabled: z.boolean() });
export type EnabledParams = z.infer<typeof EnabledParams>;

/** `compact` and `handoff`: optional instructions for the summary. */
export const CustomInstructionsParams = z.object({ customInstructions: z.string().optional() });
export type CustomInstructionsParams = z.infer<typeof CustomInstructionsParams>;

export const SessionNameParams = z.object({ name: z.string() });
export type SessionNameParams = z.infer<typeof SessionNameParams>;

export const ExportHtmlParams = z.object({ outputPath: z.string().optional() });
export type ExportHtmlParams = z.infer<typeof ExportHtmlParams>;

export const LoginParams = z.object({ providerId: z.string().min(1) });
export type LoginParams = z.infer<typeof LoginParams>;

/** One of omp's sign-in providers, and whether a sign-in for it is stored. */
export interface LoginProvider {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly authenticated: boolean;
}

/** omp's todo statuses (`TodoStatus`); as with the levels, a status omp adds or drops fails the typecheck here. */
const TODO_STATUSES: { readonly [Status in TodoStatus]: Status } = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
  abandoned: "abandoned",
  blocked: "blocked",
};

/** omp's todo list (`TodoPhase`, `TodoItem`), as the user edits it. */
export const SetTodosParams = z.object({
  phases: z.array(
    z.object({
      name: z.string(),
      tasks: z.array(
        z.object({
          content: z.string(),
          status: z.enum(TODO_STATUSES),
          blocker: z.string().optional(),
          details: z.string().optional(),
          notes: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});
export type SetTodosParams = z.infer<typeof SetTodosParams>;

/** Entries after the one with this id; all entries without one. */
export const EntriesParams = z.object({ since: z.string().min(1).optional() });
export type EntriesParams = z.infer<typeof EntriesParams>;

/** omp's page bounds: at most 256 messages a page, 100 by default; the cursor is the previous page's `nextCursor`. */
export const MessagesPageParams = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.int().min(1).max(256).optional(),
});
export type MessagesPageParams = z.infer<typeof MessagesPageParams>;

export const NewSessionParams = z.object({ parentSession: z.string().min(1).optional() });
export type NewSessionParams = z.infer<typeof NewSessionParams>;

/** `branch`, `fork` and `navigate_tree`: the session entry to start from. */
export const EntryParams = z.object({ entryId: z.string().min(1) });
export type EntryParams = z.infer<typeof EntryParams>;

/** The session's entries and its live leaf (`get_entries`, `get_tree`). */
type SessionManagerOf = Session["sessionManager"];
type LeafId = ReturnType<SessionManagerOf["getLeafId"]>;

export interface MessagesPage {
  readonly messages: Session["messages"];
  /** Absent on the last page. */
  readonly nextCursor?: string;
  readonly totalMessages: number;
}

/** A rewind in place, as omp's own (`navigateTree` without a summary). */
export interface NavigateTreeResult {
  readonly cancelled: boolean;
  /** A rewound prompt's text and images, for the composer. */
  readonly editorText?: string;
  readonly editorImages?: NonNullable<Awaited<ReturnType<Session["navigateTree"]>>["editorImages"]>;
  /** The leaf after the move. */
  readonly leafId: LeafId;
}

/** omp's two queues of messages sent while a reply streams. */
export const QueueName = z.enum(["steering", "followUp"]);
export type QueueName = z.infer<typeof QueueName>;

export const RemoveQueuedMessageParams = z.object({ message: z.string(), queue: QueueName });
export type RemoveQueuedMessageParams = z.infer<typeof RemoveQueuedMessageParams>;

export const PromoteQueuedMessageParams = z.object({ message: z.string() });
export type PromoteQueuedMessageParams = z.infer<typeof PromoteQueuedMessageParams>;

/** A queued message handed back, with its images (omp's `RestoredQueuedMessage`). */
export interface QueuedMessage {
  readonly text: string;
  readonly images?: readonly ChatHostImage[];
}

/** `remove_queued_message`: the message taken out of its queue, or `removed: false` when it was no longer there. */
export type RemoveQueuedMessageResult =
  | { readonly removed: false }
  | ({ readonly removed: true } & QueuedMessage);

/** `abort_and_restore_queue`: every message that was still queued, for the message box. */
export interface RestoredQueue {
  readonly steering: readonly QueuedMessage[];
  readonly followUp: readonly QueuedMessage[];
}

/** One entry of omp's command list (`buildAvailableSlashCommands`): the fields the app reads. */
export interface ChatHostCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly input?: { readonly hint: string };
  readonly subcommands?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly usage?: string;
  }[];
  readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
}

/** `bash` (the `!` command, and `!!` with `excludeFromContext`, #839): omp runs it and records it in the chat. */
export const BashParams = z.object({
  command: z.string().min(1),
  excludeFromContext: z.boolean().optional(),
});
export type BashParams = z.infer<typeof BashParams>;

/** `python` (the `$` command, and `$$` with `excludeFromContext`): omp runs it in its Python kernel and records it. */
export const PythonParams = z.object({
  code: z.string().min(1),
  excludeFromContext: z.boolean().optional(),
});
export type PythonParams = z.infer<typeof PythonParams>;

/** How a `bash` or `python` run ended: the fields of omp's `BashResult` and `PythonResult` the app reads. */
export interface ShellRunResult {
  readonly output: string;
  /** Undefined when the run was cancelled. */
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  /** The full output's artifact when it was too long to keep in the record. */
  readonly artifactId?: string;
}

export interface ChatHostMethodMap {
  readonly prompt: { readonly params: PromptParams; readonly result: PromptAnswer };
  /** Stops the reply; answers once omp's abort finished. */
  readonly abort: { readonly params: EmptyParams; readonly result: EmptyParams };
  readonly get_state: { readonly params: EmptyParams; readonly result: ChatHostState };
  readonly set_event_options: { readonly params: EventOptions; readonly result: EventOptions };
  readonly remove_queued_message: {
    readonly params: RemoveQueuedMessageParams;
    readonly result: RemoveQueuedMessageResult;
  };
  readonly promote_queued_message: {
    readonly params: PromoteQueuedMessageParams;
    readonly result: { readonly promoted: boolean };
  };
  /** Takes every queued message back, then stops the reply, as omp's Escape does. */
  readonly abort_and_restore_queue: {
    readonly params: EmptyParams;
    readonly result: RestoredQueue;
  };
  readonly get_available_commands: {
    readonly params: EmptyParams;
    readonly result: { readonly commands: readonly ChatHostCommand[] };
  };
  readonly bash: { readonly params: BashParams; readonly result: ShellRunResult };
  readonly python: { readonly params: PythonParams; readonly result: ShellRunResult };
  readonly set_model: {
    readonly params: SetModelParams;
    readonly result: NonNullable<Session["model"]>;
  };
  /** Waits for omp's background model refresh first. */
  readonly get_available_models: {
    readonly params: EmptyParams;
    readonly result: { readonly models: ReturnType<Session["getAvailableModels"]> };
  };
  readonly set_thinking_level: {
    readonly params: ThinkingLevelParams;
    readonly result: EmptyParams;
  };
  /** null when the model has no levels to cycle. */
  readonly cycle_thinking_level: {
    readonly params: EmptyParams;
    readonly result: {
      readonly level: NonNullable<ReturnType<Session["cycleThinkingLevel"]>>;
    } | null;
  };
  /** `off` and the live model's own levels (omp's `auto` and `inherit` are not listed, as in omp). */
  readonly get_available_thinking_levels: {
    readonly params: EmptyParams;
    readonly result: { readonly levels: readonly ThinkingLevel[] };
  };
  readonly set_fast_mode: {
    readonly params: EnabledParams;
    readonly result: { readonly enabled: boolean; readonly active: boolean };
  };
  readonly set_slow_mode: {
    readonly params: EnabledParams;
    readonly result: { readonly enabled: boolean };
  };
  readonly compact: {
    readonly params: CustomInstructionsParams;
    readonly result: Awaited<ReturnType<Session["compact"]>>;
  };
  readonly set_auto_compaction: { readonly params: EnabledParams; readonly result: EmptyParams };
  readonly set_session_name: { readonly params: SessionNameParams; readonly result: EmptyParams };
  readonly get_session_stats: {
    readonly params: EmptyParams;
    readonly result: ReturnType<Session["getSessionStats"]>;
  };
  readonly export_html: {
    readonly params: ExportHtmlParams;
    readonly result: { readonly path: string };
  };
  /** null when omp made no handoff. Refused while a reply streams. */
  readonly handoff: {
    readonly params: CustomInstructionsParams;
    readonly result: {
      readonly savedPath: NonNullable<Awaited<ReturnType<Session["handoff"]>>>["savedPath"];
    } | null;
  };
  readonly set_todos: {
    readonly params: SetTodosParams;
    readonly result: { readonly todoPhases: ReturnType<Session["getTodoPhases"]> };
  };
  readonly get_entries: {
    readonly params: EntriesParams;
    readonly result: {
      readonly entries: ReturnType<SessionManagerOf["getEntries"]>;
      readonly leafId: LeafId;
    };
  };
  readonly get_tree: {
    readonly params: EmptyParams;
    readonly result: {
      readonly tree: ReturnType<SessionManagerOf["getTree"]>;
      readonly leafId: LeafId;
    };
  };
  /** Refused while a reply streams or a compaction runs. */
  readonly get_messages_page: {
    readonly params: MessagesPageParams;
    readonly result: MessagesPage;
  };
  /** The user prompts a branch can start from. */
  readonly get_branch_messages: {
    readonly params: EmptyParams;
    readonly result: { readonly messages: ReturnType<Session["getUserMessagesForBranching"]> };
  };
  readonly new_session: {
    readonly params: NewSessionParams;
    readonly result: { readonly cancelled: boolean };
  };
  /** A new session file from the entry; `text` is the prompt it starts from. */
  readonly branch: {
    readonly params: EntryParams;
    readonly result: { readonly text: string; readonly cancelled: boolean };
  };
  /** A copy of the session up to the entry. Refused while the session is busy. */
  readonly fork: { readonly params: EntryParams; readonly result: { readonly cancelled: boolean } };
  /** Rewinds in place. Refused while the session is busy. */
  readonly navigate_tree: { readonly params: EntryParams; readonly result: NavigateTreeResult };
  /** Turns the host's `ui.ask` dialog on or off; off, omp asks with selects and editors. */
  readonly set_ask_dialog: {
    readonly params: EnabledParams;
    readonly result: { readonly enabled: boolean };
  };
  readonly get_login_providers: {
    readonly params: EmptyParams;
    readonly result: { readonly providers: readonly LoginProvider[] };
  };
  /** omp's sign-in; runs in the background, so other requests do not wait for the browser. */
  readonly login: {
    readonly params: LoginParams;
    readonly result: { readonly providerId: string };
  };
  /** Replaces the app's tools in the session; answers the names omp registered. */
  readonly set_host_tools: {
    readonly params: SetHostToolsParams;
    readonly result: { readonly toolNames: readonly string[] };
  };
  /** Replaces the app's URI schemes in omp's router; answers the schemes, normalized. */
  readonly set_host_uri_schemes: {
    readonly params: SetHostUriSchemesParams;
    readonly result: { readonly schemes: readonly string[] };
  };
  /** A running host tool call's progress; `delivered` is false once the call has ended. */
  readonly host_tool_update: {
    readonly params: HostToolUpdateParams;
    readonly result: { readonly delivered: boolean };
  };
}
export type ChatHostMethod = keyof ChatHostMethodMap;

const PARAMS: { readonly [M in ChatHostMethod]: z.ZodType<ChatHostMethodMap[M]["params"]> } = {
  prompt: PromptParams,
  abort: EmptyParams,
  get_state: EmptyParams,
  set_event_options: EventOptions,
  remove_queued_message: RemoveQueuedMessageParams,
  promote_queued_message: PromoteQueuedMessageParams,
  abort_and_restore_queue: EmptyParams,
  get_available_commands: EmptyParams,
  bash: BashParams,
  python: PythonParams,
  set_model: SetModelParams,
  get_available_models: EmptyParams,
  set_thinking_level: ThinkingLevelParams,
  cycle_thinking_level: EmptyParams,
  get_available_thinking_levels: EmptyParams,
  set_fast_mode: EnabledParams,
  set_slow_mode: EnabledParams,
  compact: CustomInstructionsParams,
  set_auto_compaction: EnabledParams,
  set_session_name: SessionNameParams,
  get_session_stats: EmptyParams,
  export_html: ExportHtmlParams,
  handoff: CustomInstructionsParams,
  set_todos: SetTodosParams,
  get_entries: EntriesParams,
  get_tree: EmptyParams,
  get_messages_page: MessagesPageParams,
  get_branch_messages: EmptyParams,
  new_session: NewSessionParams,
  branch: EntryParams,
  fork: EntryParams,
  navigate_tree: EntryParams,
  set_ask_dialog: EnabledParams,
  get_login_providers: EmptyParams,
  login: LoginParams,
  set_host_tools: SetHostToolsParams,
  set_host_uri_schemes: SetHostUriSchemesParams,
  host_tool_update: HostToolUpdateParams,
};

/** The methods of protocol version 1, in the order `hello` lists them. */
export const CHAT_HOST_METHODS = Object.keys(PARAMS) as readonly ChatHostMethod[];

export function isChatHostMethod(method: string): method is ChatHostMethod {
  return Object.hasOwn(PARAMS, method);
}

/** Checks a request's params against its method. A failure names the failing fields. */
export function parseChatHostParams<M extends ChatHostMethod>(
  method: M,
  params: unknown,
): ParseResult<ChatHostMethodMap[M]["params"]> {
  const result = PARAMS[method].safeParse(params ?? {});
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: { code: "invalid_args", message: z.prettifyError(result.error), retryable: false },
  };
}

// The app's own events

/** Why a prompt failed, read from the reply's last message as omp reports it. */
export interface PromptFailure {
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  readonly httpStatus?: number;
  /** omp classifies the failure as transient (a retry may succeed). */
  readonly retryable: boolean;
}

/**
 * The outcome of one prompt whose answer said `resultFollows`: sent when the run that carried the prompt yields.
 * `agentInvoked` is false when the prompt ended without reaching the model (an extension's command handled it).
 */
export interface PromptResultEvent {
  readonly type: "prompt_result";
  readonly requestId: string;
  readonly agentInvoked: boolean;
  readonly status: "completed" | "aborted" | "error";
  readonly error?: PromptFailure;
}

/** omp's command list, at start and whenever it changes (skills, extensions and command files reloaded). */
export interface AvailableCommandsEvent {
  readonly type: "available_commands";
  readonly commands: readonly ChatHostCommand[];
}

/** What a built-in slash command printed (`/session info`, `/usage`, …). */
export interface CommandOutputEvent {
  readonly type: "command_output";
  readonly text: string;
}

/** A built-in command renamed the chat (omp's `notifyTitleChanged`). */
export interface SessionInfoUpdateEvent {
  readonly type: "session_info_update";
  readonly sessionId: string;
  readonly title: string | null;
}

/** A built-in command changed the chat's model or thinking level (omp's `notifyConfigChanged`). */
export interface ConfigUpdateEvent {
  readonly type: "config_update";
  readonly model?: ChatHostState["model"];
  readonly thinkingLevel?: ChatHostState["thinkingLevel"];
}

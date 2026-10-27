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
import { z } from "zod";
import { type ParseResult, parseJson } from "../core/errors";

export { CHAT_HOST_CHAT_ARG } from "./args";

export const CHAT_HOST_PROTOCOL_VERSION = 1;

const RequestId = z.string().min(1);

export const ChatHostErrorCode = z.enum(["unknown_method", "invalid_params", "failed"]);
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

export const ChatHostHostLine = z.union([ChatHostHello, ChatHostResponse, ChatHostEvent]);
export type ChatHostHostLine = ChatHostHello | ChatHostResponse | ChatHostEvent;

/** Parses one line the host wrote. A failure names what is wrong, never the line itself. */
export function parseHostLine(line: string): ParseResult<ChatHostHostLine> {
  return parseJson(ChatHostHostLine, line);
}

// Server → host

export const ChatHostRequest = z.object({
  kind: z.literal("request"),
  id: RequestId,
  method: z.string().min(1),
  params: z.unknown(),
});
export type ChatHostRequest = z.infer<typeof ChatHostRequest>;

/** Parses one line the server wrote. The method's params are checked by `parseChatHostParams`. */
export function parseServerLine(line: string): ParseResult<ChatHostRequest> {
  return parseJson(ChatHostRequest, line);
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

/** The chat's state, read with `get_state`. */
export interface ChatHostState {
  readonly model: { readonly provider: string; readonly id: string; readonly name: string } | null;
  /** omp's thinking level for the chat, or null when the model does not think. */
  readonly thinkingLevel: string | null;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionId: string;
  /** The session file, or null for a chat that is not saved. */
  readonly sessionFile: string | null;
  readonly sessionName: string | null;
  readonly messageCount: number;
  readonly queuedMessageCount: number;
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
  readonly model: ChatHostState["model"];
  readonly thinkingLevel: string | null;
}

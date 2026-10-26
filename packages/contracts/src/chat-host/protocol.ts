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
 * or it was empty) and nothing follows.
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

export interface ChatHostMethodMap {
  readonly prompt: { readonly params: PromptParams; readonly result: PromptAnswer };
  /** Stops the reply; answers once omp's abort finished. */
  readonly abort: { readonly params: EmptyParams; readonly result: EmptyParams };
  readonly get_state: { readonly params: EmptyParams; readonly result: ChatHostState };
  readonly set_event_options: { readonly params: EventOptions; readonly result: EventOptions };
}
export type ChatHostMethod = keyof ChatHostMethodMap;

const PARAMS: { readonly [M in ChatHostMethod]: z.ZodType<ChatHostMethodMap[M]["params"]> } = {
  prompt: PromptParams,
  abort: EmptyParams,
  get_state: EmptyParams,
  set_event_options: EventOptions,
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

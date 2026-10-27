/**
 * The app-facing contract for a chat on the chat host (SDK plan H5.3, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.3
 * design"): requests by the protocol's method names, and the host's events on the chat's stream. It stands beside the
 * RPC port (`./rpc-session.ts`) until H5.6 removes that one, and shares its thread and stream arguments.
 */
import { z } from "zod";
import {
  type ChatEvent,
  type ChatHostMethod,
  type ChatHostMethodMap,
  isChatHostMethod,
} from "../../chat-host/protocol";
import type { PortCallOptions, PortClient, PortHandlers } from "../../core/envelope";
import { definePort, type StreamKey, streamKey } from "../../core/envelope";
import { AppError } from "../../core/errors";
import { SessionFilePath, ThreadId } from "../../core/ids";
import {
  OpenThreadArgs,
  ProcessStatus,
  SubscribeArgs,
  SubscribeResult,
  ThreadRef,
} from "./rpc-session";

export const ChatOpenResult = z.strictObject({
  threadId: ThreadId,
  sessionFile: SessionFilePath,
  /** The methods this chat's host answers (`hello.methods`): what the chat can do, in place of the RPC probe. */
  methods: z.array(z.string()),
});
export type ChatOpenResult = z.infer<typeof ChatOpenResult>;

/** A request by a chat host method's name. The server checks `params` against the method before the host sees them. */
export const ChatRequestArgs = z.strictObject({
  threadId: ThreadId,
  method: z.string().refine(isChatHostMethod, "expected a chat host method"),
  params: z.unknown(),
});
export type ChatRequestArgs<M extends ChatHostMethod = ChatHostMethod> = {
  readonly threadId: ThreadId;
  readonly method: M;
  readonly params: ChatHostMethodMap[M]["params"];
};

const ChatEventPayload = z.strictObject({
  kind: z.literal("event"),
  event: z.custom<ChatEvent>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string",
    { message: "expected a chat host event" },
  ),
});

const ChatProcessPayload = z.strictObject({
  kind: z.literal("process"),
  status: ProcessStatus,
  /** When this chat's process started (ms since the epoch): an entry written before it belongs to an earlier process. */
  startedAt: z.number().nonnegative().optional(),
  error: AppError.optional(),
});

export const ChatSessionEvent = z.discriminatedUnion("kind", [
  ChatEventPayload,
  ChatProcessPayload,
]);
export type ChatSessionEvent = z.infer<typeof ChatSessionEvent>;

export const ChatSessionPort = definePort({
  name: "A0.chatSession",
  methods: {
    open: { args: OpenThreadArgs, result: ChatOpenResult },
    request: { args: ChatRequestArgs, result: z.unknown() },
    subscribe: { args: SubscribeArgs, result: SubscribeResult },
    restart: { args: ThreadRef, result: z.null() },
    close: { args: ThreadRef, result: z.null() },
  },
  events: { event: { payload: ChatSessionEvent } },
});
export type ChatSessionPort = typeof ChatSessionPort;

export type ChatSessionRequest = <M extends ChatHostMethod>(
  args: ChatRequestArgs<M>,
  options?: PortCallOptions,
) => Promise<ChatHostMethodMap[M]["result"]>;

export type ChatSessionClient = Omit<PortClient<ChatSessionPort>, "request"> & {
  readonly request: ChatSessionRequest;
};

export type ChatSessionRequestHandler<Context> = <M extends ChatHostMethod>(
  args: ChatRequestArgs<M>,
  context: Context,
) => Promise<ChatHostMethodMap[M]["result"]>;

export type ChatSessionHandlers<Context> = Omit<
  PortHandlers<ChatSessionPort, Context>,
  "request"
> & {
  readonly request: ChatSessionRequestHandler<Context>;
};

/** The stream `ChatSessionPort.subscribe` names for one chat. */
export function chatSessionEventStream(threadId: ThreadId): StreamKey {
  return streamKey(ChatSessionPort.name, "event", threadId);
}

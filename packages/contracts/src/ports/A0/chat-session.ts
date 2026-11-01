/**
 * The app-facing contract for a chat on the chat host (SDK plan H5.3, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.3
 * design"): requests by the protocol's method names, and the host's events on the chat's stream.
 */
import { z } from "zod";
import {
  type ChatEvent,
  type ChatHostMethod,
  type ChatHostMethodMap,
  HostRequestSchema,
  isChatHostMethod,
  type ShellRunResult,
  type UiStatusEvent,
  type UiTitleEvent,
  type UiWidgetEvent,
} from "../../chat-host/protocol";
import type { PortCallOptions, PortClient, PortHandlers } from "../../core/envelope";
import { definePort, StreamKey, streamKey } from "../../core/envelope";
import { AppError } from "../../core/errors";
import { FolderPath, SessionFilePath, ThreadId } from "../../core/ids";

export const ThreadRef = z.object({ threadId: ThreadId }).strict();
export type ThreadRef = z.infer<typeof ThreadRef>;

/** A chat model to open a chat with: its provider and model id, as omp names them (`provider/modelId`). */
export const ModelChoice = z
  .object({ provider: z.string().min(1), modelId: z.string().min(1) })
  .strict();
export type ModelChoice = z.infer<typeof ModelChoice>;

/** Open an existing thread, create a fresh thread, or resume the newest thread in a folder. */
export const OpenThreadArgs = z.union([
  z.object({ threadId: ThreadId, model: ModelChoice.optional() }).strict(),
  z.object({ folderPath: FolderPath, start: z.literal("new") }).strict(),
  z.object({ folderPath: FolderPath, start: z.literal("latest") }).strict(),
]);
export type OpenThreadArgs = z.infer<typeof OpenThreadArgs>;

/**
 * The folder a page shows: the server keeps a new chat ready there, so the next "New chat" opens at once (#2760). A
 * server that does not keep new chats ready ignores it.
 */
export const PrepareNewChatArgs = z.strictObject({ folderPath: FolderPath });
export type PrepareNewChatArgs = z.infer<typeof PrepareNewChatArgs>;

/**
 * A chat's new title, as typed. omp trims it and turns control characters into spaces, so the title
 * the chat then shows can differ; the caller reads the saved title back from the chat's file.
 */
export const SessionRenameArgs = z.strictObject({
  threadId: ThreadId,
  name: z.string().min(1),
});
export type SessionRenameArgs = z.infer<typeof SessionRenameArgs>;

export const SubscribeArgs = z
  .object({
    threadId: ThreadId,
    /** Resume after this event sequence; omit for a fresh stream. */
    afterSeq: z.int().min(0).optional(),
  })
  .strict();
export type SubscribeArgs = z.infer<typeof SubscribeArgs>;

export const SubscribeResult = z.object({ stream: StreamKey }).strict();
export type SubscribeResult = z.infer<typeof SubscribeResult>;

const SubagentSubscriptionLevel = z.enum(["off", "progress", "events"]);

export const SetSubagentSubscriptionArgs = z
  .object({
    threadId: ThreadId,
    level: SubagentSubscriptionLevel,
  })
  .strict();
export type SetSubagentSubscriptionArgs = z.infer<typeof SetSubagentSubscriptionArgs>;

export const SetSubagentSubscriptionResult = z
  .object({ level: SubagentSubscriptionLevel })
  .strict();
export type SetSubagentSubscriptionResult = z.infer<typeof SetSubagentSubscriptionResult>;

/** The state of a chat's process, as the server reports it. */
export const ProcessStatus = z.enum(["starting", "ready", "running", "stopped", "exited", "error"]);
export type ProcessStatus = z.infer<typeof ProcessStatus>;

const MessageUpdates = z.enum(["full", "delta"]);

/**
 * One connection's choice of message updates. The chat's host gets the viewers' choices as one: `full` when any viewer
 * asks for it, else `delta`. omp's RPC event-type filter has no counterpart: the host sends every event, and one stream
 * serves every viewer, so a browser filters types itself.
 */
export const SetEventOptionsArgs = z.strictObject({
  threadId: ThreadId,
  messageUpdates: MessageUpdates,
});
export type SetEventOptionsArgs = z.infer<typeof SetEventOptionsArgs>;

/** What the chat's host was told; absent while it keeps its own default (`full`). */
export const SetEventOptionsResult = z.strictObject({ messageUpdates: MessageUpdates.optional() });
export type SetEventOptionsResult = z.infer<typeof SetEventOptionsResult>;

export const ChatOpenResult = z.strictObject({
  threadId: ThreadId,
  sessionFile: SessionFilePath,
  /** The methods this chat's host answers (`hello.methods`): what the chat can do, in place of the RPC probe. */
  methods: z.array(z.string()),
});
export type ChatOpenResult = z.infer<typeof ChatOpenResult>;

/** The two methods that register the app's tools and URI schemes; each registration names its owner. */
const REGISTRATION_METHODS: ReadonlySet<string> = new Set([
  "set_host_tools",
  "set_host_uri_schemes",
]);

/**
 * A request by a chat host method's name. The server checks `params` against the method before the host sees them. A
 * host tool or URI scheme registration names its owner (`registrationOwner`): the server merges every owner's set.
 */
export const ChatRequestArgs = z
  .strictObject({
    threadId: ThreadId,
    method: z.string().refine(isChatHostMethod, "expected a chat host method"),
    params: z.unknown(),
    registrationOwner: z.string().min(1).optional(),
  })
  .refine(
    ({ method, registrationOwner }) =>
      REGISTRATION_METHODS.has(method) === (registrationOwner !== undefined),
    "registrationOwner must be present only for host tool and URI scheme registrations",
  );
export type ChatRequestArgs<M extends ChatHostMethod = ChatHostMethod> = {
  readonly threadId: ThreadId;
  readonly method: M;
  readonly params: ChatHostMethodMap[M]["params"];
  readonly registrationOwner?: string;
};

/** The browser's answer to a host request; the server checks it against the request's method first. */
export const AnswerHostRequestArgs = z.strictObject({
  threadId: ThreadId,
  id: z.string().min(1),
  answer: z.unknown(),
});
export type AnswerHostRequestArgs = z.infer<typeof AnswerHostRequestArgs>;

/** The host requests still waiting for an answer, each with the sequence of the event that asked it. */
export const OpenHostRequests = z.array(
  z.strictObject({ seq: z.int().min(1), request: HostRequestSchema }),
);
export type OpenHostRequests = z.infer<typeof OpenHostRequests>;

/** The UI state omp sends once and does not repeat: a status, a widget, the title. */
export type UiStateEvent = UiStatusEvent | UiWidgetEvent | UiTitleEvent;

const UI_STATE_TYPES: ReadonlySet<string> = new Set(["ui_status", "ui_widget", "ui_title"]);

/** Whether an event sets UI state that stays until omp replaces or clears it. */
export function isUiStateEvent(event: ChatEvent): event is UiStateEvent {
  return UI_STATE_TYPES.has(event.type);
}

/** The UI state a chat holds, each event with the sequence that set it, oldest first. */
export const UiState = z.array(
  z.strictObject({
    seq: z.int().min(1),
    event: z.custom<UiStateEvent>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        UI_STATE_TYPES.has(String((value as { type?: unknown }).type)),
      { message: "expected a status, widget or title" },
    ),
  }),
);
export type UiState = z.infer<typeof UiState>;

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

/** A request the host waits on: answer it with `answer`. */
const HostRequestPayload = z.strictObject({
  kind: z.literal("host_request"),
  request: HostRequestSchema,
});

/**
 * A `!` (`bash`) or `$` (`python`) run, which omp reports only to its caller: published to every viewer of the chat
 * when it starts and when it ends, with omp's result (absent when the run failed).
 */
const ShellRunPayload = z.strictObject({
  kind: z.literal("shell"),
  method: z.enum(["bash", "python"]),
  /** The command or code, as the caller sent it. */
  input: z.string(),
  status: z.enum(["running", "ended"]),
  startedAt: z.number().nonnegative(),
  result: z
    .custom<ShellRunResult>((value) => typeof value === "object" && value !== null)
    .optional(),
});

/**
 * The chat moved to a new session (a new chat, a branch or a fork): its stream continues under the new id, and the old
 * id still names the chat.
 */
const MovedPayload = z.strictObject({
  kind: z.literal("moved"),
  threadId: ThreadId,
  sessionFile: SessionFilePath,
});

export const ChatSessionEvent = z.discriminatedUnion("kind", [
  ChatEventPayload,
  ChatProcessPayload,
  HostRequestPayload,
  ShellRunPayload,
  MovedPayload,
]);
export type ChatSessionEvent = z.infer<typeof ChatSessionEvent>;

/** Pauses or resumes every chat the server runs (omp's pause gate in each, as `/pause`); ready spare chats are left out. */
export const PauseAllArgs = z.strictObject({ paused: z.boolean() });
export type PauseAllArgs = z.infer<typeof PauseAllArgs>;
/** How many running chats took it (a chat whose omp started before pause existed does not). */
export const PauseAllResult = z.strictObject({ chats: z.int().min(0) });
export type PauseAllResult = z.infer<typeof PauseAllResult>;

export const ChatSessionPort = definePort({
  name: "A0.chatSession",
  methods: {
    open: { args: OpenThreadArgs, result: ChatOpenResult },
    prepareNew: { args: PrepareNewChatArgs, result: z.null() },
    request: { args: ChatRequestArgs, result: z.unknown() },
    subscribe: { args: SubscribeArgs, result: SubscribeResult },
    restart: { args: ThreadRef, result: z.null() },
    close: { args: ThreadRef, result: z.null() },
    rename: { args: SessionRenameArgs, result: z.null() },
    answer: { args: AnswerHostRequestArgs, result: z.null() },
    openRequests: { args: ThreadRef, result: OpenHostRequests },
    uiState: { args: ThreadRef, result: UiState },
    setSubagentSubscription: {
      args: SetSubagentSubscriptionArgs,
      result: SetSubagentSubscriptionResult,
    },
    setEventOptions: { args: SetEventOptionsArgs, result: SetEventOptionsResult },
    pauseAll: { args: PauseAllArgs, result: PauseAllResult },
    /** "Don't continue": the app does not continue the chat after its usage limit (#2781). */
    cancelContinue: { args: ThreadRef, result: z.null() },
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

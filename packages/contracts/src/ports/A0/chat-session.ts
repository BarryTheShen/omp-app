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
import { UsageActivityEntry, UsagePauseHold, UsagePauseReason } from "../A1/session-file-store";

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

/** The usage pause's default limit: a marked chat pauses at 95% of its provider's 5-hour window (#2781). */
export const USAGE_PAUSE_DEFAULT_PERCENT = 95;
/**
 * Marks a chat to pause when its provider's 5-hour usage window reaches `percent`, or (`null`) unmarks it (#2781). Only
 * marked chats pause, each at its own limit; what the rule paused it resumes at the window's reset.
 */
export const SetUsagePauseArgs = z.strictObject({
  threadId: ThreadId,
  percent: z.int().min(1).max(100).nullable(),
});
export type SetUsagePauseArgs = z.infer<typeof SetUsagePauseArgs>;

/** A time of day, `HH:MM` on a 24-hour clock, in the server's time zone. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type ClockTime = z.infer<typeof ClockTime>;

/**
 * A usage rule (#2836): it pauses the chats it lists, at their next step as omp's `/pause`, while any of its conditions
 * holds, and continues them once none does. A condition left null is not used, and a rule has at least one:
 * - `fiveHourAt`, `weeklyAt`: the chat's provider's 5-hour or weekly window at or past this percent;
 * - `paceAt`: the 5-hour window, at its pace of the last hour, would end past this percent at its reset;
 * - `hours`: the clock between `from` and `to` (a `from` later than `to` runs past midnight).
 * A chat paused by hand is left alone; one resumed by hand while held stays running until that condition next starts.
 */
export const UsageRule = z
  .strictObject({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    chats: z.array(ThreadId).max(500),
    fiveHourAt: z.int().min(1).max(100).nullable(),
    weeklyAt: z.int().min(1).max(100).nullable(),
    paceAt: z.int().min(1).max(100).nullable(),
    hours: z
      .strictObject({ from: ClockTime, to: ClockTime })
      .refine((hours) => hours.from !== hours.to, "The hours start and end at the same time.")
      .nullable(),
    enabled: z.boolean(),
  })
  .refine(
    (rule) =>
      rule.fiveHourAt !== null ||
      rule.weeklyAt !== null ||
      rule.paceAt !== null ||
      rule.hours !== null,
    "A rule needs a condition.",
  );
export type UsageRule = z.infer<typeof UsageRule>;

/** A chat a usage rule holds: why, and until when it is expected to (epoch ms; null when a reading will say). */
export const UsageRuleHeld = z.strictObject({
  id: ThreadId,
  reason: UsagePauseReason,
  until: z.int().nonnegative().nullable(),
});
export type UsageRuleHeld = z.infer<typeof UsageRuleHeld>;

/** The usage rules, each with the chats it holds now, and the time zone their hours are in. */
export const UsageRulesResult = z.strictObject({
  rules: z
    .array(z.strictObject({ rule: UsageRule, held: z.array(UsageRuleHeld).max(500) }))
    .max(200),
  timeZone: z.string().min(1).max(64),
});
export type UsageRulesResult = z.infer<typeof UsageRulesResult>;

/**
 * The held chats in the queue's order (#2836): each with its hold and, once no condition holds it any more, when it
 * continues (epoch ms; chats continue one at a time, a few minutes apart, so a reset window is not spent at once).
 */
export const UsageQueueResult = z.strictObject({
  chats: z
    .array(
      z.strictObject({
        id: ThreadId,
        hold: UsagePauseHold,
        continuesAt: z.int().nonnegative().nullable(),
      }),
    )
    .max(500),
});
export type UsageQueueResult = z.infer<typeof UsageQueueResult>;

/** What the usage pause did, newest first: the last 200 things (#2836). */
export const UsageActivityResult = z.strictObject({
  entries: z.array(UsageActivityEntry).max(200),
});
export type UsageActivityResult = z.infer<typeof UsageActivityResult>;

/** The held chats in a new order: the first continues first; held chats left out keep their order after them. */
export const OrderUsageQueueArgs = z.strictObject({ threadIds: z.array(ThreadId).max(500) });
export type OrderUsageQueueArgs = z.infer<typeof OrderUsageQueueArgs>;

export const RemoveUsageRuleArgs = z.strictObject({ id: z.string().min(1).max(64) });
export type RemoveUsageRuleArgs = z.infer<typeof RemoveUsageRuleArgs>;

/** Chats a page lists as running before omp has written their file, and whose first message another page sent (#2825). */
export const FirstPromptsArgs = z.strictObject({ threadIds: z.array(ThreadId).max(100) });
export type FirstPromptsArgs = z.infer<typeof FirstPromptsArgs>;

/** Each chat's first message as this server sent it to omp, cut to 200 characters; a chat it holds none for is left out. */
export const FirstPromptsResult = z.array(z.strictObject({ threadId: ThreadId, text: z.string() }));
export type FirstPromptsResult = z.infer<typeof FirstPromptsResult>;

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
    /** Marks a chat to pause at its own share of its provider's 5-hour limit, or unmarks it (#2781). */
    setUsagePause: { args: SetUsagePauseArgs, result: z.null() },
    /** The usage rules and the chats each holds (#2836). */
    usageRules: { args: z.strictObject({}), result: UsageRulesResult },
    /** Adds a usage rule, or replaces the one with its id; it is judged at once (#2836). */
    setUsageRule: { args: UsageRule, result: z.null() },
    /** Removes a usage rule: the chats it held continue, unless another rule holds them (#2836). */
    removeUsageRule: { args: RemoveUsageRuleArgs, result: z.null() },
    /** The held chats in the queue's order, and when each continues (#2836). */
    usageQueue: { args: z.strictObject({}), result: UsageQueueResult },
    /** Puts the held chats in a new order (#2836). */
    orderUsageQueue: { args: OrderUsageQueueArgs, result: z.null() },
    /** Continues a held chat now, out of its turn; the conditions that held it wait until they next start (#2836). */
    continueHeld: { args: ThreadRef, result: z.null() },
    /** Skips a held chat's continuing: it stays paused, and the rules let it be until it is resumed by hand (#2836). */
    skipHeld: { args: ThreadRef, result: z.null() },
    /** What the usage pause did, newest first (#2836). */
    usageActivity: { args: z.strictObject({}), result: UsageActivityResult },
    /** The first messages of chats not yet written to a file, so every page names them as the page that sent them (#2825). */
    firstPrompts: { args: FirstPromptsArgs, result: FirstPromptsResult },
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

/**
 * The app-facing contract for one omp session and its normalized event stream.
 *
 * The omp payloads in this file are deliberately type-only imports from C0. C0 owns the copied
 * wire declarations; this port owns only the app envelope around them and the small discriminants
 * needed to validate that envelope at runtime.
 */
import { z } from "zod";

import { CapabilityMap } from "../../core/capabilities";
import type { PortCallOptions, PortClient, PortHandlers } from "../../core/envelope";
import { definePort, StreamKey, streamKey } from "../../core/envelope";
import { AppError } from "../../core/errors";
import { FolderPath, HostCallId, SessionFilePath, ThreadId, UiRequestId } from "../../core/ids";
import type {
  OmpCommand,
  OmpCommandMap,
  OmpCommandName,
  OmpCommandResult,
  OmpEvent,
  OmpResponse,
  OmpServerFrame,
  OmpWire,
} from "../../core/omp";
import { OMP_COMMAND_NAMES } from "../../core/omp";

const WireRecord = z.record(z.string(), z.unknown());

export const ThreadRef = z.object({ threadId: ThreadId }).strict();
export type ThreadRef = z.infer<typeof ThreadRef>;

/** Open an existing thread, create a fresh thread, or resume the newest thread in a folder. */
export const OpenThreadArgs = z.union([
  z.object({ threadId: ThreadId }).strict(),
  z.object({ folderPath: FolderPath, start: z.literal("new") }).strict(),
  z.object({ folderPath: FolderPath, start: z.literal("latest") }).strict(),
]);
export type OpenThreadArgs = z.infer<typeof OpenThreadArgs>;

export const OpenThreadResult = z
  .object({
    threadId: ThreadId,
    sessionFile: SessionFilePath,
    capabilities: CapabilityMap,
  })
  .strict();
export type OpenThreadResult = z.infer<typeof OpenThreadResult>;

export const OmpCommandNameSchema = z.enum(OMP_COMMAND_NAMES);

/**
 * Runtime validation for the command envelope. The generated omp command declarations remain the
 * source of truth for the command-specific payload and result types; A0.3 performs the wire-level
 * validation before writing to omp. At this boundary we reject malformed command identities while
 * preserving every generated command payload without re-declaring it here.
 */
export function isOmpCommand(value: unknown): value is OmpCommand {
  const parsed = WireRecord.safeParse(value);
  if (!parsed.success) return false;
  const command = parsed.data;
  if (
    typeof command.type !== "string" ||
    !OMP_COMMAND_NAMES.includes(command.type as OmpCommandName)
  ) {
    return false;
  }
  return !("id" in command && (typeof command.id !== "string" || command.id.length === 0));
}

export const OmpCommandSchema = z.custom<OmpCommand>(isOmpCommand, {
  message: "expected a known omp command",
});

/** Any command's result; `send`'s typed signature narrows it per command (C0's `OmpCommandResult<K>`). */
export const OmpCommandResultSchema = z.custom<OmpCommandResult<OmpCommandName>>(() => true);

export const SendCommandArgs = z
  .object({
    threadId: ThreadId,
    command: OmpCommandSchema,
    registrationOwner: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    ({ command, registrationOwner }) =>
      (command.type === "set_host_tools" || command.type === "set_host_uri_schemes") ===
      (registrationOwner !== undefined),
    "registrationOwner must be present only for host registration commands",
  );
export type SendCommandArgs<K extends OmpCommandName = OmpCommandName> = {
  threadId: ThreadId;
  command: OmpCommand<K>;
  /**
   * Required by the runtime schema for set_host_tools and set_host_uri_schemes; optional here so
   * callers that carry an OmpCommand union remain assignable.
   */
  registrationOwner?: string;
};

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

export type ExtensionUiResponse = OmpWire.ExtensionUiResponse & { id: UiRequestId };
export type HostToolResponse = (OmpWire.HostToolUpdate | OmpWire.HostToolResult) & {
  id: HostCallId;
};
export type HostUriResponse = OmpWire.HostUriResult & { id: HostCallId };

const UiResponseSchema = z.custom<ExtensionUiResponse>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    if (response.type !== "extension_ui_response" || !UiRequestId.safeParse(response.id).success) {
      return false;
    }
    return (
      typeof response.value === "string" ||
      typeof response.confirmed === "boolean" ||
      response.cancelled === true ||
      Array.isArray(response.answers)
    );
  },
  { message: "expected an extension UI response" },
);

const HostToolResponseSchema = z.custom<HostToolResponse>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    if (!HostCallId.safeParse(response.id).success) return false;
    if (response.type === "host_tool_update") {
      return WireRecord.safeParse(response.partialResult).success;
    }
    return response.type === "host_tool_result" && WireRecord.safeParse(response.result).success;
  },
  { message: "expected a host tool response" },
);

const HostUriResponseSchema = z.custom<HostUriResponse>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    return response.type === "host_uri_result" && HostCallId.safeParse(response.id).success;
  },
  { message: "expected a host URI response" },
);

export const AnswerExtensionUiArgs = z
  .object({
    threadId: ThreadId,
    response: UiResponseSchema,
  })
  .strict();
export type AnswerExtensionUiArgs = z.infer<typeof AnswerExtensionUiArgs>;

export const AnswerHostToolArgs = z
  .object({
    threadId: ThreadId,
    response: HostToolResponseSchema,
  })
  .strict();
export type AnswerHostToolArgs = z.infer<typeof AnswerHostToolArgs>;

export const AnswerHostUriArgs = z
  .object({
    threadId: ThreadId,
    response: HostUriResponseSchema,
  })
  .strict();
export type AnswerHostUriArgs = z.infer<typeof AnswerHostUriArgs>;

const SubagentSubscriptionLevelSchema = z.enum(["off", "progress", "events"]);
const MessageUpdatesSchema = z.enum(["full", "delta"]);

export const SetSubagentSubscriptionArgs = z
  .object({
    threadId: ThreadId,
    level: SubagentSubscriptionLevelSchema,
  })
  .strict();
export type SetSubagentSubscriptionArgs = z.infer<typeof SetSubagentSubscriptionArgs>;

export const SetSubagentSubscriptionResult = z
  .object({ level: SubagentSubscriptionLevelSchema })
  .strict();
export type SetSubagentSubscriptionResult = z.infer<typeof SetSubagentSubscriptionResult>;

export const SetEventFilterArgs = z
  .object({
    threadId: ThreadId,
    /** Null forwards every event; an array narrows the event type tags. */
    events: z.array(z.string().min(1)).nullable(),
    messageUpdates: MessageUpdatesSchema.optional(),
  })
  .strict();
export type SetEventFilterArgs = z.infer<typeof SetEventFilterArgs>;

export const SetEventFilterResult = z
  .object({
    events: z.array(z.string().min(1)).nullable(),
    messageUpdates: MessageUpdatesSchema.optional(),
  })
  .strict();
export type SetEventFilterResult = z.infer<typeof SetEventFilterResult>;

const OmpEventSchema = z.custom<OmpEvent>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    return parsed.success && typeof parsed.data.type === "string" && parsed.data.type.length > 0;
  },
  {
    message: "expected a normalized omp session event",
  },
);

const PromptResultStatusSchema = z.enum(["completed", "aborted", "error"]);
const PromptErrorSchema = z
  .object({
    message: z.string(),
    retryable: z.boolean(),
    provider: z.string().optional(),
    model: z.string().optional(),
    httpStatus: z.number().int().optional(),
  })
  .strict();
const PromptResultSchema = z.custom<OmpWire.PromptResultEvent>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    if (!parsed.success) return false;
    const result = parsed.data;
    if (
      result.type !== "prompt_result" ||
      typeof result.agentInvoked !== "boolean" ||
      !PromptResultStatusSchema.safeParse(result.status).success ||
      typeof result.sessionSettled !== "boolean"
    ) {
      return false;
    }
    if (
      "id" in result &&
      result.id !== undefined &&
      (typeof result.id !== "string" || result.id.length === 0)
    ) {
      return false;
    }
    return !(
      "error" in result &&
      result.error !== undefined &&
      !PromptErrorSchema.safeParse(result.error).success
    );
  },
  { message: "expected a prompt_result notification" },
);

const SessionSettledSchema = z.custom<OmpWire.SessionSettledEvent>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    return parsed.success && parsed.data.type === "session_settled";
  },
  { message: "expected a session_settled notification" },
);
/**
 * All non-response stdout frames that the UI may need, including host callbacks. The runtime
 * validator intentionally checks only the frame envelope so a newer omp can add notification
 * fields without dropping the frame.
 */
export type RpcSessionNotification = Exclude<
  OmpServerFrame,
  OmpResponse | OmpWire.ReadyEvent | OmpWire.PromptResultEvent | OmpWire.SessionSettledEvent
>;

const ReservedFrameTypes: Record<string, true> = {
  ready: true,
  prompt_result: true,
  session_settled: true,
  response: true,
  extension_ui_response: true,
  host_tool_update: true,
  host_tool_result: true,
  host_uri_result: true,
};

export const RpcSessionNotification = z.custom<RpcSessionNotification>(
  (value) => {
    const parsed = WireRecord.safeParse(value);
    if (!parsed.success || typeof parsed.data.type !== "string" || parsed.data.type.length === 0) {
      return false;
    }
    return ReservedFrameTypes[parsed.data.type] !== true;
  },
  { message: "expected an omp notification frame" },
);

const NotificationPayload = z
  .object({
    kind: z.literal("notification"),
    frame: RpcSessionNotification,
  })
  .strict();

export const ProcessStatus = z.enum([
  "starting",
  "ready",
  "running",
  "stopped",
  "restarting",
  "exited",
  "error",
]);
export type ProcessStatus = z.infer<typeof ProcessStatus>;

const ProcessStatusPayload = z
  .object({
    kind: z.literal("process"),
    status: ProcessStatus,
    error: AppError.optional(),
  })
  .strict();

const OmpEventPayload = z
  .object({
    kind: z.literal("omp"),
    event: OmpEventSchema,
  })
  .strict();

const PromptResultPayload = z
  .object({
    kind: z.literal("prompt_result"),
    event: PromptResultSchema,
  })
  .strict();

const SessionSettledPayload = z
  .object({
    kind: z.literal("session_settled"),
    event: SessionSettledSchema,
  })
  .strict();

export const RpcSessionEvent = z.discriminatedUnion("kind", [
  OmpEventPayload,
  PromptResultPayload,
  SessionSettledPayload,
  NotificationPayload,
  ProcessStatusPayload,
]);
export type RpcSessionEvent = z.infer<typeof RpcSessionEvent>;

export const RpcSessionPort = definePort({
  name: "A0.rpcSession",
  methods: {
    open: {
      args: OpenThreadArgs,
      result: OpenThreadResult,
    },
    rename: {
      args: SessionRenameArgs,
      result: z.null(),
      capability: "omp.cmd.set_session_name",
    },
    send: {
      args: SendCommandArgs,
      result: OmpCommandResultSchema,
    },
    subscribe: {
      args: SubscribeArgs,
      result: SubscribeResult,
    },
    answerExtensionUi: {
      args: AnswerExtensionUiArgs,
      result: z.null(),
      capability: "omp.ui",
    },
    answerHostTool: {
      args: AnswerHostToolArgs,
      result: z.null(),
      capability: "omp.host-tools",
    },
    answerHostUri: {
      args: AnswerHostUriArgs,
      result: z.null(),
      capability: "omp.host-uris",
    },
    setSubagentSubscription: {
      args: SetSubagentSubscriptionArgs,
      result: SetSubagentSubscriptionResult,
      capability: "omp.subagent-events",
    },
    setEventFilter: {
      args: SetEventFilterArgs,
      result: SetEventFilterResult,
      capability: "omp.cmd.set_event_filter",
    },
    restart: {
      args: ThreadRef,
      result: z.null(),
    },
    close: {
      args: ThreadRef,
      result: z.null(),
    },
  },
  events: {
    event: {
      payload: RpcSessionEvent,
    },
  },
});

export type RpcSessionPort = typeof RpcSessionPort;

export type RpcSessionSend = <K extends OmpCommandName>(
  args: SendCommandArgs<K>,
  options?: PortCallOptions,
) => Promise<OmpCommandMap[K]["result"]>;

export type RpcSessionClient = Omit<PortClient<RpcSessionPort>, "send"> & {
  readonly send: RpcSessionSend;
};

export type RpcSessionSendHandler<Context> = <K extends OmpCommandName>(
  args: SendCommandArgs<K>,
  context: Context,
) => Promise<OmpCommandMap[K]["result"]>;

export type RpcSessionHandlers<Context> = Omit<PortHandlers<RpcSessionPort, Context>, "send"> & {
  readonly send: RpcSessionSendHandler<Context>;
};

/** The stream used by `RpcSessionPort.subscribe` for one thread. */
export function rpcSessionEventStream(threadId: ThreadId): StreamKey {
  return streamKey(RpcSessionPort.name, "event", threadId);
}

/** The dynamic capability required by `send` for one command. */
export function ompCommandCapability(command: OmpCommandName): `omp.cmd.${OmpCommandName}` {
  return `omp.cmd.${command}`;
}

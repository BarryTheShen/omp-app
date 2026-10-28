import type { ChatSessionEvent, OmpWire, RpcSessionEvent } from "@omp-app/contracts";
import type {
  ChatEvent,
  HostDialogRequest,
  HostRequest,
  HostToolCall,
  HostUriCall,
  UiPresentationEvent,
} from "@omp-app/contracts/chat-host";

/** omp's RPC dialog methods: the chat host asks them as host requests (`ui.<method>`). */
const DIALOG_METHODS: ReadonlySet<string> = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "ask",
]);

/** omp's other RPC UI methods and the chat host's events for them. */
const UI_EVENT_TYPES: Readonly<Record<string, string>> = {
  notify: "ui_notify",
  setStatus: "ui_status",
  setWidget: "ui_widget",
  setTitle: "ui_title",
  set_editor_text: "ui_editor_text",
  open_url: "ui_open_url",
};

function event(fields: Record<string, unknown>): ChatSessionEvent {
  return { kind: "event", event: fields as unknown as ChatEvent };
}

function hostRequest(fields: Record<string, unknown>): ChatSessionEvent {
  return { kind: "host_request", request: fields as unknown as HostRequest };
}

/** One of the chat host's dialogs, as the session port carries it. */
export function dialogEvent(request: HostDialogRequest): ChatSessionEvent {
  return { kind: "host_request", request };
}

/** The chat host gave a dialog up (omp's abort or timeout). */
export function dialogCancelEvent(requestId: string): ChatSessionEvent {
  return { kind: "event", event: { type: "ui_cancel", requestId } };
}

/** One of the chat host's calls of the app's tools or URI schemes, as the session port carries it. */
export function hostCallEvent(request: HostToolCall | HostUriCall): ChatSessionEvent {
  return { kind: "host_request", request };
}

/** The chat host gave a call up (omp's abort of a tool call, or of a URI read or write). */
export function hostCallCancelEvent(
  kind: "tool_cancel" | "uri_cancel",
  requestId: string,
): ChatSessionEvent {
  return { kind: "event", event: { type: kind, requestId } };
}

/** One of the chat host's UI events that need no answer. */
export function uiEvent(uiEventFields: UiPresentationEvent): ChatSessionEvent {
  return { kind: "event", event: uiEventFields };
}

/**
 * One of A0's RPC notification frames as the chat host sends it, for fixtures recorded or
 * written as RPC frames. A dialog is a host request (`ui.<method>`, keeping its id), omp's other UI calls are the host's
 * UI events, a host tool call or URI read or write is a host request, and any other frame is an event of its own type.
 */
export function notificationEvent(frame: unknown): ChatSessionEvent {
  const { type, ...fields } = frame as { readonly type: string } & Record<string, unknown>;
  switch (type) {
    case "extension_ui_request": {
      const { id, method, targetId, ...params } = fields as {
        readonly id: string;
        readonly method: string;
        readonly targetId?: string;
      } & Record<string, unknown>;
      if (method === "cancel") return event({ type: "ui_cancel", requestId: targetId });
      if (DIALOG_METHODS.has(method)) return hostRequest({ id, method: `ui.${method}`, params });
      const uiType = UI_EVENT_TYPES[method];
      if (uiType === undefined)
        throw new Error(`The chat host has no event for omp's ${method} UI request.`);
      return event({ type: uiType, ...params });
    }
    case "host_tool_call": {
      const { id, ...params } = fields;
      return hostRequest({ id, method: "tool.call", params });
    }
    case "host_uri_request": {
      const { id, operation, url, content } = fields;
      return operation === "write"
        ? hostRequest({ id, method: "uri.write", params: { url, content } })
        : hostRequest({ id, method: "uri.read", params: { url } });
    }
    case "host_tool_cancel":
      return event({ type: "tool_cancel", requestId: fields.targetId });
    case "host_uri_cancel":
      return event({ type: "uri_cancel", requestId: fields.targetId });
    case "available_commands_update":
      return event({ type: "available_commands", commands: fields.commands });
    default:
      return event({ type, ...fields });
  }
}

/** A `!` run as A0's RPC port reported it (`command`), as the chat host's `shell` event (`input`). */
export function bashEvent(run: {
  readonly status: string;
  readonly command: string;
  readonly startedAt?: number;
  readonly result?: unknown;
}): ChatSessionEvent {
  return {
    kind: "shell",
    method: "bash",
    input: run.command,
    status: run.status,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.result === undefined ? {} : { result: run.result }),
  } as unknown as ChatSessionEvent;
}

/**
 * A chat session event from an omp event typed with A0's omp wire types. Both are views of omp's same JSON; the chat
 * host's types are generated from omp's SDK and are stricter about fields a fixture leaves out, so the tests and
 * playgrounds that build omp events with the wire types feed them to the store through here.
 */
export function ompEvent(event: OmpWire.RpcAgentEvent): ChatSessionEvent {
  return { kind: "event", event: event as unknown as ChatEvent };
}

/** omp's RPC prompt result as the chat host sends it: the result names its request `requestId`, where RPC said `id`. */
export function promptResultEvent(event: OmpWire.PromptResultEvent): ChatSessionEvent {
  const { id, ...result } = event;
  return { kind: "event", event: { ...result, requestId: id } as unknown as ChatEvent };
}

/** The chat host's report that the session settled. */
export const SESSION_SETTLED_EVENT: ChatSessionEvent = {
  kind: "event",
  event: { type: "session_settled" },
};

/**
 * One of A0's RPC session events as the chat host sends it, for the recordings of omp's RPC sessions
 * (`packages/omp-rpc/fixtures`) that tests and playgrounds still play through omp-rpc's session. They go when H5.6 deletes
 * omp-rpc, and recordings of the chat host replace them.
 */
export function sessionEventOfRpc(event: RpcSessionEvent): ChatSessionEvent {
  switch (event.kind) {
    case "omp":
      return ompEvent(event.event);
    case "prompt_result":
      return promptResultEvent(event.event);
    case "session_settled":
      return SESSION_SETTLED_EVENT;
    case "notification":
      return notificationEvent(event.frame);
    case "bash":
      return bashEvent(event);
    case "process":
      return event;
  }
}

/**
 * A host request as the RPC command omp took (`prompt`, `steer` and `follow_up` carry `message` where the host takes
 * `text`): for the stand-ins that still play omp's RPC frames (a recorded fixture session) until H5.6d rewrites them on
 * the host's protocol.
 */
export function commandOf(method: string, params: unknown): Record<string, unknown> {
  const fields = { ...(params as Record<string, unknown>) };
  if ((method === "prompt" || method === "steer" || method === "follow_up") && "text" in fields) {
    const { text, ...rest } = fields;
    return { type: method, ...rest, message: text };
  }
  return { type: method, ...fields };
}

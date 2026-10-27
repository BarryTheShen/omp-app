/**
 * The chat session port's events and sends in the shapes A0's RPC port had (SDK plan H5.4,
 * `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.4 design"), shared by the cutover's shim (`launch/chat-session-shim.ts`)
 * and R0's store while readers still speak those shapes:
 * - each session payload becomes one RPC event, in the shape omp's RPC session gave it
 *   (`packages/omp-rpc/src/session/rpc-session.ts:692-762`), so no sequence is skipped;
 * - sends become requests by method, with the host's params.
 * The host's requests and UI events are no longer translated: a dialog travels as a `host_dialog` frame holding the
 * host's request (H5.4c), a tool call or a URI read or write as a `host_call` frame (H5.4d), their cancels as
 * `host_dialog_cancel` and `host_call_cancel`, and a UI event as itself. The later H5.4 parts move each other reader off
 * it, and H5.4h deletes it.
 */
import type { ChatSessionEvent, RpcSessionEvent, RpcSessionNotification } from "@omp-app/contracts";
import {
  type ChatEvent,
  type HostDialogRequest,
  type HostRequest,
  type HostToolCall,
  type HostUriCall,
  isHostDialogRequest,
  type ShellRunResult,
  type UiPresentationEvent,
} from "@omp-app/contracts/chat-host";

/** A host dialog as the store keeps it until it is answered or given up. */
export interface HostDialogFrame {
  readonly type: "host_dialog";
  readonly request: HostDialogRequest;
}

/** The host gave a dialog up (omp's abort or timeout). */
export interface HostDialogCancelFrame {
  readonly type: "host_dialog_cancel";
  readonly requestId: string;
}

/** A call of one of the app's tools or URI schemes as the store keeps it until it is answered or given up. */
export interface HostCallFrame {
  readonly type: "host_call";
  readonly request: HostToolCall | HostUriCall;
}

/** The host gave a call up (omp's `tool_cancel` or `uri_cancel`). */
export interface HostCallCancelFrame {
  readonly type: "host_call_cancel";
  readonly requestId: string;
}

/** The host's UI events that need no answer, forwarded as they come (`ui_cancel` becomes `host_dialog_cancel`). */
export type HostUiEvent = UiPresentationEvent;

/** omp's own session events, which omp's RPC session hands on as `omp` events (omp-rpc `rpc-session.ts:31-63`). */
const OMP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_stream_update",
  "tool_execution_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "cache_warming_start",
  "cache_warming_end",
  "retry_fallback_applied",
  "retry_fallback_succeeded",
  "model_changed",
  "config_warnings_changed",
  "advisor_cost_changed",
  "advisor_yielded",
  "ttsr_triggered",
  "todo_reminder",
  "todo_auto_clear",
  "irc_message",
  "notice",
  "thinking_level_changed",
  "goal_updated",
  "queue_update",
]);

/** A notification frame, typed as the readers read it. */
function notification(frame: Record<string, unknown>): RpcSessionEvent {
  return { kind: "notification", frame: frame as unknown as RpcSessionNotification };
}

/** A host request as the frame the store keeps: a dialog, or a call of one of the app's tools or URI schemes. */
function requestFrameOf(request: HostRequest): Record<string, unknown> {
  if (isHostDialogRequest(request)) {
    const frame: HostDialogFrame = { type: "host_dialog", request };
    return { ...frame };
  }
  const frame: HostCallFrame = { type: "host_call", request };
  return { ...frame };
}

/** The host's UI event types that pass through as themselves. */
const HOST_UI_EVENT_TYPES: ReadonlySet<string> = new Set([
  "ui_notify",
  "ui_status",
  "ui_widget",
  "ui_title",
  "ui_editor_text",
  "ui_open_url",
] satisfies HostUiEvent["type"][]);

/** Whether a host event is one of its UI events that need no answer. */
export function isHostUiEvent(event: { readonly type: string }): event is HostUiEvent {
  return HOST_UI_EVENT_TYPES.has(event.type);
}

/** A `!` run's answer, as the `ended` event of A0's RPC port carried it. */
function bashResultOf(result: ShellRunResult): Record<string, unknown> {
  return {
    output: result.output,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    cancelled: result.cancelled,
    truncated: result.truncated,
  };
}

/** One host event as the RPC event omp's RPC session made of it. */
function rpcEventOfChatEvent(event: ChatEvent): RpcSessionEvent {
  if (event.type === "prompt_result") {
    return {
      kind: "prompt_result",
      event: {
        type: "prompt_result",
        id: event.requestId,
        agentInvoked: event.agentInvoked,
        status: event.status,
        sessionSettled: event.sessionSettled,
        ...(event.error === undefined ? {} : { error: event.error }),
      },
    } as RpcSessionEvent;
  }
  if (event.type === "session_settled") {
    return { kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent;
  }
  if (isHostUiEvent(event)) return notification({ ...event });
  switch (event.type) {
    case "ui_cancel": {
      const frame: HostDialogCancelFrame = {
        type: "host_dialog_cancel",
        requestId: event.requestId,
      };
      return notification({ ...frame });
    }
    case "tool_cancel":
    case "uri_cancel": {
      const frame: HostCallCancelFrame = { type: "host_call_cancel", requestId: event.requestId };
      return notification({ ...frame });
    }
    case "available_commands":
      return notification({ type: "available_commands_update", commands: event.commands });
  }
  if (OMP_EVENT_TYPES.has(event.type)) return { kind: "omp", event } as unknown as RpcSessionEvent;
  return notification(event as unknown as Record<string, unknown>);
}

/**
 * One session payload as one RPC event, so the readers' sequences stay contiguous. A payload with no RPC counterpart (a
 * Python run) becomes a frame no reader subscribes to.
 */
export function rpcEventOf(payload: ChatSessionEvent): RpcSessionEvent {
  switch (payload.kind) {
    case "event":
      return rpcEventOfChatEvent(payload.event);
    case "host_request":
      return notification(requestFrameOf(payload.request));
    case "shell":
      if (payload.method !== "bash") {
        return notification({ type: "python_run", status: payload.status, code: payload.input });
      }
      return {
        kind: "bash",
        status: payload.status,
        command: payload.input,
        startedAt: payload.startedAt,
        ...(payload.result === undefined ? {} : { result: bashResultOf(payload.result) }),
      } as RpcSessionEvent;
    case "process":
      return {
        kind: "process",
        status: payload.status,
        ...(payload.startedAt === undefined ? {} : { startedAt: payload.startedAt }),
        ...(payload.error === undefined ? {} : { error: payload.error }),
      } as RpcSessionEvent;
    case "moved":
      // What A0's RPC runtime published after a session switch (`server/src/ports/A0/rpc-session.ts:1223-1226`).
      return notification({ type: "session_info_update", sessionId: payload.threadId });
  }
}

/** An RPC command as the host's method and params: `prompt`, `steer` and `follow_up` take `text` where omp took `message`. */
export function requestOf(command: Record<string, unknown>): {
  readonly method: string;
  readonly params: Record<string, unknown>;
} {
  const { type, ...params } = command;
  const method = String(type);
  if (
    (method === "prompt" || method === "steer" || method === "follow_up") &&
    "message" in params
  ) {
    const { message, ...rest } = params;
    return { method, params: { ...rest, text: message } };
  }
  return { method, params };
}

/**
 * A host request as the RPC command omp took, the inverse of `requestOf`: for the stand-ins that still play omp's RPC
 * frames (a recorded fixture session) until H5.6 rewrites them on the host's protocol.
 */
export function commandOf(method: string, params: unknown): Record<string, unknown> {
  const fields = { ...(params as Record<string, unknown>) };
  if ((method === "prompt" || method === "steer" || method === "follow_up") && "text" in fields) {
    const { text, ...rest } = fields;
    return { type: method, ...rest, message: text };
  }
  return { type: method, ...fields };
}

/** A host's result as the RPC result the readers know: `prompt` answers whether the model runs. */
export function resultOf(method: string, result: unknown): unknown {
  if (method === "prompt") {
    const answer = result as { readonly resultFollows: boolean };
    return { agentInvoked: answer.resultFollows };
  }
  return result;
}

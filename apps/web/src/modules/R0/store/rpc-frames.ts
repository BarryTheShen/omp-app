/**
 * The chat session port's events, sends and answers in the shapes A0's RPC port had (SDK plan H5.4,
 * `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.4 design"), shared by the cutover's shim (`launch/chat-session-shim.ts`)
 * and R0's store while readers still speak those shapes:
 * - each session payload becomes one RPC event, in the shape omp's RPC session gave it
 *   (`packages/omp-rpc/src/session/rpc-session.ts:692-762`), so no sequence is skipped;
 * - sends become requests by method, with the host's params;
 * - the RPC answers of host tools and URIs become the host's answers.
 * The host's dialogs and UI events are no longer translated (H5.4c): a dialog travels as a `host_dialog` frame holding
 * the host's request, its cancel as `host_dialog_cancel`, and a UI event as itself. The later H5.4 parts move each
 * other reader off it, and H5.4h deletes it.
 */
import type {
  ChatSessionEvent,
  HostToolResponse,
  HostUriResponse,
  RpcSessionEvent,
  RpcSessionNotification,
} from "@omp-app/contracts";
import {
  type ChatEvent,
  type HostDialogRequest,
  type HostRequest,
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

/** A host request as the frame the store keeps: a dialog as the host sent it, a tool or URI call as omp's RPC frame. */
function requestFrameOf(request: HostRequest): Record<string, unknown> {
  if (isHostDialogRequest(request)) {
    const frame: HostDialogFrame = { type: "host_dialog", request };
    return { ...frame };
  }
  switch (request.method) {
    case "tool.call":
      return { type: "host_tool_call", id: request.id, ...request.params };
    case "uri.read":
      return {
        type: "host_uri_request",
        id: request.id,
        operation: "read",
        url: request.params.url,
      };
    case "uri.write":
      return {
        type: "host_uri_request",
        id: request.id,
        operation: "write",
        url: request.params.url,
        content: request.params.content,
      };
  }
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
function rpcEventOfChatEvent(event: ChatEvent, seq: number): RpcSessionEvent {
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
      return notification({
        type: "host_tool_cancel",
        id: `cancel-${seq}`,
        targetId: event.requestId,
      });
    case "uri_cancel":
      return notification({
        type: "host_uri_cancel",
        id: `cancel-${seq}`,
        targetId: event.requestId,
      });
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
export function rpcEventOf(payload: ChatSessionEvent, seq: number): RpcSessionEvent {
  switch (payload.kind) {
    case "event":
      return rpcEventOfChatEvent(payload.event, seq);
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

/** A host's result as the RPC result the readers know: `prompt` answers whether the model runs. */
export function resultOf(method: string, result: unknown): unknown {
  if (method === "prompt") {
    const answer = result as { readonly resultFollows: boolean };
    return { agentInvoked: answer.resultFollows };
  }
  return result;
}

/** A host tool's result as the host's answer: its content and details, failed when either side says so. */
export function toolAnswerOf(
  response: Extract<HostToolResponse, { type: "host_tool_result" }>,
): unknown {
  const { result } = response;
  return {
    content: result.content,
    ...(result.details === undefined ? {} : { details: result.details }),
    ...((result.isError ?? response.isError) === true ? { isError: true } : {}),
  };
}

/** A host URI result as the host's answer: its own fields. */
export function uriAnswerOf(response: HostUriResponse): unknown {
  const { type: _type, id: _id, ...answer } = response;
  return answer;
}

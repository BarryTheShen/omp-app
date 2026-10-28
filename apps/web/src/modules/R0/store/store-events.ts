/**
 * How R0's store sorts the chat session port's payloads before it reduces them: omp's own session events, the frames it
 * hands to feature modules by type (`subscribeNotifications`), a prompt's result, the session's settle, a `!` run and the
 * process's state. The host's requests travel as the store's own frames: a dialog as `host_dialog`, a call of one of the
 * app's tools or URI schemes as `host_call`, and their cancels as `host_dialog_cancel` and `host_call_cancel`.
 */
import type { ChatSessionEvent } from "@omp-app/contracts";
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

/** A frame the store hands to feature modules by its type: one of the host's events, or one of the store's own. */
export type StoreFrame =
  | ChatEvent
  | HostDialogFrame
  | HostDialogCancelFrame
  | HostCallFrame
  | HostCallCancelFrame;

/** A `!` run, as the store's command rows read it. */
export interface StoreBashRun {
  readonly kind: "bash";
  readonly status: string;
  readonly command: string;
  readonly startedAt?: number;
  readonly result?: {
    readonly output: string;
    readonly exitCode?: number;
    readonly cancelled: boolean;
    readonly truncated: boolean;
  };
}

/** One session payload as the store reduces it. */
export type StoreEvent =
  | { readonly kind: "omp"; readonly event: ChatEvent }
  | { readonly kind: "notification"; readonly frame: StoreFrame }
  | {
      readonly kind: "prompt_result";
      readonly event: ChatEvent & { readonly type: "prompt_result" };
    }
  | { readonly kind: "session_settled" }
  | StoreBashRun
  | Extract<ChatSessionEvent, { readonly kind: "process" }>
  /** A payload the store holds no state for (a Python run, a move): it only takes its sequence slot. */
  | { readonly kind: "other" };

/** omp's own session events, which the store reduces and hands to `subscribeOmpEvents`. */
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

function frame(value: StoreFrame): StoreEvent {
  return { kind: "notification", frame: value };
}

/** A host request as the frame the store keeps: a dialog, or a call of one of the app's tools or URI schemes. */
function requestFrameOf(request: HostRequest): StoreFrame {
  return isHostDialogRequest(request)
    ? { type: "host_dialog", request }
    : { type: "host_call", request };
}

/** A `!` run's answer, as the command rows read it. */
function bashResultOf(result: ShellRunResult): NonNullable<StoreBashRun["result"]> {
  return {
    output: result.output,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    cancelled: result.cancelled,
    truncated: result.truncated,
  };
}

function storeEventOfChatEvent(event: ChatEvent): StoreEvent {
  if (event.type === "prompt_result") return { kind: "prompt_result", event };
  if (event.type === "session_settled") return { kind: "session_settled" };
  if (isHostUiEvent(event)) return frame(event);
  switch (event.type) {
    case "ui_cancel":
      return frame({ type: "host_dialog_cancel", requestId: event.requestId });
    case "tool_cancel":
    case "uri_cancel":
      return frame({ type: "host_call_cancel", requestId: event.requestId });
  }
  if (OMP_EVENT_TYPES.has(event.type)) return { kind: "omp", event };
  return frame(event);
}

/** One session payload as the store reduces it; every payload takes one sequence slot. */
export function storeEventOf(payload: ChatSessionEvent): StoreEvent {
  switch (payload.kind) {
    case "event":
      return storeEventOfChatEvent(payload.event);
    case "host_request":
      return frame(requestFrameOf(payload.request));
    case "shell":
      if (payload.method !== "bash") return { kind: "other" };
      return {
        kind: "bash",
        status: payload.status,
        command: payload.input,
        ...(payload.startedAt === undefined ? {} : { startedAt: payload.startedAt }),
        ...(payload.result === undefined ? {} : { result: bashResultOf(payload.result) }),
      };
    case "process":
      return payload;
    case "moved":
      // R1 follows a chat to its new id from the subscription itself; the store keeps no state for it.
      return { kind: "other" };
  }
}

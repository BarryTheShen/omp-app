/**
 * The chat session port's events, sends and answers in the shapes A0's RPC port had (SDK plan H5.4,
 * `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.4 design"), shared by the cutover's shim (`launch/chat-session-shim.ts`)
 * and R0's store while readers still speak those shapes:
 * - each session payload becomes one RPC event, in the shape omp's RPC session gave it
 *   (`packages/omp-rpc/src/session/rpc-session.ts:692-762`), so no sequence is skipped;
 * - sends become requests by method, with the host's params;
 * - the RPC answers become the host's answers.
 * The later H5.4 parts move each reader off it, and H5.4h deletes it.
 */
import type {
  ChatSessionEvent,
  ExtensionUiResponse,
  HostToolResponse,
  HostUriResponse,
  OpenHostRequests,
  OpenQuestionRecord,
  RpcSessionEvent,
  RpcSessionNotification,
  StateFrameRecord,
  UiState,
} from "@omp-app/contracts";
import type {
  ApproveDialog,
  ChatEvent,
  HostRequest,
  ShellRunResult,
} from "@omp-app/contracts/chat-host";

type ApprovalPrompt = ApproveDialog["prompt"];

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

/** The host's UI events and the RPC methods omp sent them as. */
const UI_EVENT_METHODS = {
  ui_notify: "notify",
  ui_status: "setStatus",
  ui_widget: "setWidget",
  ui_title: "setTitle",
  ui_editor_text: "set_editor_text",
  ui_open_url: "open_url",
} as const;

type UiEventType = keyof typeof UI_EVENT_METHODS;

function isUiEventType(type: string): type is UiEventType {
  return Object.hasOwn(UI_EVENT_METHODS, type);
}

/**
 * omp's approval choices as select labels, for hosts without an approval dialog (omp 18.12.6 `tools/approval.ts:740-759`):
 * each grant for this session, each grant across sessions, this call only, the session answer when offered, and Deny.
 */
export function approvalChoiceLabels(prompt: ApprovalPrompt): string[] {
  const grants = prompt.grants ?? [];
  return [
    ...grants.map((grant) => grant.label),
    ...grants.map((grant) => grant.alwaysLabel),
    approvalOnceLabel(prompt),
    ...(prompt.session ? [prompt.session] : []),
    "Deny",
  ];
}

function approvalOnceLabel(prompt: ApprovalPrompt): string {
  return prompt.grants?.length ? "Approve Once" : "Approve";
}

/** The answer a label from `approvalChoiceLabels` stands for; anything else denies (`approval.ts:761-774`). */
export function approvalAnswerForChoice(
  prompt: ApprovalPrompt,
  choice: string | undefined,
): unknown {
  if (choice === undefined) return "deny";
  if (choice === approvalOnceLabel(prompt)) return "once";
  if (prompt.session && choice === prompt.session) return "session";
  for (const grant of prompt.grants ?? []) {
    if (choice === grant.label) return { grant: grant.scope, always: false };
    if (choice === grant.alwaysLabel) return { grant: grant.scope, always: true };
  }
  return "deny";
}

/** The approvals the shim showed as selects, by chat and request id, so their answers map back to omp's. */
export class ApprovalBook {
  readonly #prompts = new Map<string, ApprovalPrompt>();

  remember(threadId: string, id: string, prompt: ApprovalPrompt): void {
    this.#prompts.set(`${threadId}\u0000${id}`, prompt);
  }

  take(threadId: string, id: string): ApprovalPrompt | undefined {
    const key = `${threadId}\u0000${id}`;
    const prompt = this.#prompts.get(key);
    this.#prompts.delete(key);
    return prompt;
  }
}

/**
 * The page's one book: an approval is remembered by whichever reader translates the stream (the shim's subscription, or
 * R1's), and answered through the shim's client, so both must read the same book.
 */
export const sharedApprovals = new ApprovalBook();

/** A notification frame, typed as the readers read it. */
function notification(frame: Record<string, unknown>): RpcSessionEvent {
  return { kind: "notification", frame: frame as unknown as RpcSessionNotification };
}

/** A host's UI event as the `extension_ui_request` omp sent for it; its id comes from the event's sequence. */
function uiFrameOf(
  event: Extract<ChatEvent, { type: UiEventType }>,
  seq: number,
): Record<string, unknown> {
  const { type, ...fields } = event;
  return {
    type: "extension_ui_request",
    id: `ui-${seq}`,
    method: UI_EVENT_METHODS[type],
    ...fields,
  };
}

/** A host request as the RPC frame omp sent for it; an approval is omp's select with its labels. */
function requestFrameOf(
  threadId: string,
  request: HostRequest,
  approvals: ApprovalBook,
): Record<string, unknown> {
  switch (request.method) {
    case "ui.select":
    case "ui.confirm":
    case "ui.input":
    case "ui.editor":
    case "ui.ask":
      return {
        type: "extension_ui_request",
        id: request.id,
        method: request.method.slice("ui.".length),
        ...request.params,
      };
    case "ui.approve": {
      const { prompt, timeout } = request.params;
      approvals.remember(threadId, request.id, prompt);
      return {
        type: "extension_ui_request",
        id: request.id,
        method: "select",
        title: prompt.full,
        options: approvalChoiceLabels(prompt),
        ...(timeout === undefined ? {} : { timeout }),
      };
    }
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
  if (isUiEventType(event.type)) {
    return notification(uiFrameOf(event as Extract<ChatEvent, { type: UiEventType }>, seq));
  }
  switch (event.type) {
    case "ui_cancel":
      return notification({
        type: "extension_ui_request",
        id: `ui-${seq}`,
        method: "cancel",
        targetId: event.requestId,
      });
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
export function rpcEventOf(
  threadId: string,
  payload: ChatSessionEvent,
  seq: number,
  approvals: ApprovalBook,
): RpcSessionEvent {
  switch (payload.kind) {
    case "event":
      return rpcEventOfChatEvent(payload.event, seq);
    case "host_request":
      return notification(requestFrameOf(threadId, payload.request, approvals));
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

/** An `extension_ui_response` as the host's answer: its own fields, or omp's approval answer for an approval's select. */
export function uiAnswerOf(
  response: ExtensionUiResponse,
  approval: ApprovalPrompt | undefined,
): unknown {
  if (approval !== undefined) {
    return approvalAnswerForChoice(approval, "value" in response ? response.value : undefined);
  }
  const { type: _type, id: _id, ...answer } = response;
  return answer;
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

/** The open questions as A0's RPC port listed them: the dialogs, an approval as its select. */
export function openQuestionsOf(
  threadId: string,
  open: OpenHostRequests,
  approvals: ApprovalBook,
): OpenQuestionRecord[] {
  return open
    .filter(({ request }) => request.method.startsWith("ui."))
    .map(({ seq, request }) => ({
      seq,
      request: requestFrameOf(
        threadId,
        request,
        approvals,
      ) as unknown as OpenQuestionRecord["request"],
    }));
}

/** The statuses, widgets and title as A0's RPC port listed them, with the ids their events had on the stream. */
export function stateFramesOf(state: UiState): StateFrameRecord[] {
  return state.map(({ seq, event }) => ({
    seq,
    request: uiFrameOf(
      event as Extract<ChatEvent, { type: UiEventType }>,
      seq,
    ) as unknown as StateFrameRecord["request"],
  }));
}

/**
 * The cutover's shim (SDK plan H5.4a, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.4 design"). The browser's readers still
 * speak A0's RPC port, while the server serves the chat session port. This client serves A0's RPC port from
 * `A0.chatSession`:
 * - each session payload becomes one RPC event, in the shape omp's RPC session gave it
 *   (`packages/omp-rpc/src/session/rpc-session.ts:692-762`), so no sequence is skipped;
 * - sends become requests by method, with the host's params;
 * - the RPC answers become `answer`.
 * Every other port passes through. H5.4b to H5.4h move the readers off it, and H5.4h deletes it.
 */
import {
  type AppClient,
  type AppClientSubscription,
  type CreateAppClientOptions,
  createAppClient,
  type SubscribeOptions,
} from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type CapabilityMap,
  type ChatSessionEvent,
  ChatSessionPort,
  type ExtensionUiResponse,
  type HostToolResponse,
  type HostUriResponse,
  type OmpWire,
  type OpenHostRequests,
  type OpenQuestionRecord,
  type PortCallOptions,
  type PortClient,
  type RpcSessionEvent,
  type RpcSessionNotification,
  RpcSessionPort,
  type StateFrameRecord,
  type UiState,
} from "@omp-app/contracts";
import type {
  ApproveDialog,
  ChatEvent,
  HostRequest,
  ShellRunResult,
} from "@omp-app/contracts/chat-host";

type RpcSessionClient = PortClient<typeof RpcSessionPort>;
type ChatSessionClient = PortClient<typeof ChatSessionPort>;
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
function openQuestionsOf(
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
function stateFramesOf(state: UiState): StateFrameRecord[] {
  return state.map(({ seq, event }) => ({
    seq,
    request: uiFrameOf(
      event as Extract<ChatEvent, { type: UiEventType }>,
      seq,
    ) as unknown as StateFrameRecord["request"],
  }));
}

/** A0's RPC port, served by the chat session port. */
function rpcSessionClientOver(
  chat: ChatSessionClient,
  capabilities: () => Promise<CapabilityMap>,
  approvals: ApprovalBook,
): RpcSessionClient {
  const rpc: RpcSessionClient = {
    open: async (args, options) => {
      const opened = await chat.open(args, options);
      return {
        threadId: opened.threadId,
        sessionFile: opened.sessionFile,
        capabilities: await capabilities(),
      };
    },
    rename: (args, options) => chat.rename(args, options),
    send: async (args, options?: PortCallOptions) => {
      const { method, params } = requestOf(args.command as unknown as Record<string, unknown>);
      const result = await chat.request(
        {
          threadId: args.threadId,
          method,
          params,
          ...(args.registrationOwner === undefined
            ? {}
            : { registrationOwner: args.registrationOwner }),
        } as Parameters<ChatSessionClient["request"]>[0],
        options,
      );
      return resultOf(method, result) as Awaited<ReturnType<RpcSessionClient["send"]>>;
    },
    subscribe: (args, options) => chat.subscribe(args, options),
    answerExtensionUi: async ({ threadId, response }, options) => {
      const approval = approvals.take(threadId, response.id);
      return chat.answer(
        { threadId, id: response.id, answer: uiAnswerOf(response, approval) },
        options,
      );
    },
    openQuestions: async (args, options) =>
      openQuestionsOf(args.threadId, await chat.openRequests(args, options), approvals),
    stateFrames: async (args, options) => stateFramesOf(await chat.uiState(args, options)),
    answerHostTool: async ({ threadId, response }, options) => {
      if (response.type === "host_tool_update") {
        await chat.request(
          {
            threadId,
            method: "host_tool_update",
            params: { callId: response.id, partialResult: response.partialResult },
          } as Parameters<ChatSessionClient["request"]>[0],
          options,
        );
        return null;
      }
      return chat.answer({ threadId, id: response.id, answer: toolAnswerOf(response) }, options);
    },
    answerHostUri: ({ threadId, response }, options) =>
      chat.answer({ threadId, id: response.id, answer: uriAnswerOf(response) }, options),
    setSubagentSubscription: (args, options) => chat.setSubagentSubscription(args, options),
    setEventFilter: async () => {
      throw new AppFailure({
        code: "unavailable",
        message: "The chat host sends every event; there is no event filter to set.",
        retryable: false,
      });
    },
    restart: (args, options) => chat.restart(args, options),
    close: (args, options) => chat.close(args, options),
  };
  return rpc;
}

type RpcListener = (event: RpcSessionEvent, seq: number) => void;
type ChatListener = (payload: ChatSessionEvent, seq: number) => void;

/**
 * The connection's client, with A0's RPC port served by the chat session port. A listener is wrapped once, so passing the
 * same function in `onEvent` and to `subscription.onEvent` still attaches it once, as the client promises.
 */
export function withChatSessionShim(client: AppClient): AppClient {
  const approvals = new ApprovalBook();
  let capabilities: Promise<CapabilityMap> | undefined;
  const readCapabilities = (): Promise<CapabilityMap> => {
    capabilities ??= client
      .port(AppPort)
      .capabilities({})
      .catch((error: unknown) => {
        capabilities = undefined;
        throw error;
      });
    return capabilities;
  };
  const rpc = rpcSessionClientOver(client.port(ChatSessionPort), readCapabilities, approvals);
  const isRpcPort = (port: { readonly name: string }): boolean => port.name === RpcSessionPort.name;

  return {
    get connectionState() {
      return client.connectionState;
    },
    get instanceId() {
      return client.instanceId;
    },
    onConnectionState: (listener) => client.onConnectionState(listener),
    onResync: (listener) => client.onResync(listener),
    port: ((port) => (isRpcPort(port) ? rpc : client.port(port))) as AppClient["port"],
    subscribe: (async (port, event, options) => {
      if (!isRpcPort(port)) return client.subscribe(port, event, options);
      const threadId = options?.scope ?? "";
      const wrapped = new WeakMap<RpcListener, ChatListener>();
      const wrap = (listener: RpcListener): ChatListener => {
        let chatListener = wrapped.get(listener);
        if (chatListener === undefined) {
          chatListener = (payload, seq) =>
            listener(rpcEventOf(threadId, payload, seq, approvals), seq);
          wrapped.set(listener, chatListener);
        }
        return chatListener;
      };
      const rpcOptions = options as SubscribeOptions<RpcSessionEvent> | undefined;
      const subscription = await client.subscribe(ChatSessionPort, "event", {
        ...(rpcOptions?.scope === undefined ? {} : { scope: rpcOptions.scope }),
        ...(rpcOptions?.afterSeq === undefined ? {} : { afterSeq: rpcOptions.afterSeq }),
        ...(rpcOptions?.signal === undefined ? {} : { signal: rpcOptions.signal }),
        ...(rpcOptions?.onEvent === undefined ? {} : { onEvent: wrap(rpcOptions.onEvent) }),
      });
      const shimmed: AppClientSubscription<RpcSessionEvent> = {
        stream: subscription.stream,
        get lastSeq() {
          return subscription.lastSeq;
        },
        onEvent: (listener) => subscription.onEvent(wrap(listener)),
        unsubscribe: () => subscription.unsubscribe(),
      };
      return shimmed;
    }) as AppClient["subscribe"],
    dispose: () => client.dispose(),
  };
}

/** The app's client: `createAppClient`, with the cutover's shim. */
export function createChatSessionAppClient(options: CreateAppClientOptions): AppClient {
  return withChatSessionShim(createAppClient(options));
}

export type { OmpWire };

import {
  type AbortSignalLike,
  type AppError,
  type AppErrorCode,
  AppFailure,
  type RpcSessionEvent as ContractRpcSessionEvent,
  type ExtensionUiResponse,
  type HostToolResponse,
  type HostUriResponse,
  isOmpCommand,
  OMP_COMMANDS,
  type OmpCommand,
  type OmpCommandMap,
  type OmpCommandName,
  type OmpEvent,
  type OmpHostRequest,
  type OmpResponse,
  type OmpWire,
  type RpcSessionNotification,
} from "@omp-app/contracts";
import { FrameDecoder, type FrameDecoderInput, type FrameDecoderOptions } from "../frame";

const DIALOG_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
  ask: true,
};
const OMP_EVENT_TYPES: Record<string, true> = {
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_stream_update: true,
  tool_execution_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  auto_retry_start: true,
  auto_retry_end: true,
  cache_warming_start: true,
  cache_warming_end: true,
  retry_fallback_applied: true,
  retry_fallback_succeeded: true,
  model_changed: true,
  config_warnings_changed: true,
  advisor_cost_changed: true,
  advisor_yielded: true,
  ttsr_triggered: true,
  todo_reminder: true,
  todo_auto_clear: true,
  irc_message: true,
  notice: true,
  thinking_level_changed: true,
  goal_updated: true,
  queue_update: true,
};
const UI_REQUEST_METHODS: Record<string, true> = {
  ...DIALOG_METHODS,
  cancel: true,
  notify: true,
  setStatus: true,
  setWidget: true,
  setTitle: true,
  set_editor_text: true,
  open_url: true,
};

export interface RpcDuplex {
  /** Write exactly one JSONL line, including its trailing newline. */
  writeLine(line: string): void | PromiseLike<void>;
  /** Subscribe to arbitrary stdout byte chunks. */
  onChunk(listener: (chunk: Uint8Array) => void): () => void;
  /** Subscribe to transport close. `cause` is host data and is never copied to an AppError message. */
  onClose(listener: (cause?: unknown) => void): () => void;
  /** Close the underlying transport when the session is intentionally disposed. */
  close?(): void | PromiseLike<void>;
}

export interface RpcSessionTimer {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RpcSessionOptions {
  readonly timer?: RpcSessionTimer;
  readonly decoder?: FrameDecoderOptions;
}

export type RpcSessionState = "new" | "starting" | "negotiating" | "ready" | "error" | "stopped";
export type RpcSessionRequest = OmpWire.ExtensionUiRequest | OmpHostRequest;
export type RpcSessionEvent = ContractRpcSessionEvent;
export type RpcSessionListener = (event: RpcSessionEvent) => void;
export type RpcRequestListener = (request: RpcSessionRequest) => void;

/** A command promise carrying the generated wire id and its response-admission promise. */
export interface CommandFuture<T, Admission = T> extends Promise<T> {
  readonly id: string;
  readonly command: OmpCommandName;
  /** Resolves as soon as omp acknowledges/admitted the command, before prompt completion if applicable. */
  readonly admitted: Promise<Admission>;
}

interface PendingCommand {
  readonly id: string;
  readonly command: OmpCommandName;
  readonly completion: "prompt_result" | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppFailure) => void;
  readonly resolveAdmission: (value: unknown) => void;
  readonly rejectAdmission: (error: AppFailure) => void;
  timerHandle?: unknown;
  removeAbort?: () => void;
  responseReceived: boolean;
  admissionSettled: boolean;
  responseData?: unknown;
  promptResult?: OmpWire.PromptResultEvent;
}

interface RuntimeTimer {
  readonly setTimeout?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

function defaultTimer(): RpcSessionTimer {
  const runtime = globalThis as unknown as RuntimeTimer;
  return {
    setTimeout(handler, delayMs) {
      return runtime.setTimeout?.(handler, delayMs);
    },
    clearTimeout(handle) {
      runtime.clearTimeout?.(handle);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadyFrame(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OmpWire.ReadyEvent {
  if (value.type !== "ready") return false;
  if (value.protocolVersion !== undefined && typeof value.protocolVersion !== "number")
    return false;
  if (value.supportedProtocolVersions !== undefined) {
    if (
      !Array.isArray(value.supportedProtocolVersions) ||
      value.supportedProtocolVersions.some((version) => typeof version !== "number")
    ) {
      return false;
    }
  }
  return (
    (value.maxFrameBytes === undefined || typeof value.maxFrameBytes === "number") &&
    (value.maxReassembledFrameBytes === undefined ||
      typeof value.maxReassembledFrameBytes === "number")
  );
}

function isResponseFrame(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OmpResponse {
  return (
    value.type === "response" &&
    typeof value.command === "string" &&
    typeof value.success === "boolean" &&
    (value.id === undefined || typeof value.id === "string")
  );
}

function isPromptResultFrame(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OmpWire.PromptResultEvent {
  return (
    value.type === "prompt_result" &&
    typeof value.agentInvoked === "boolean" &&
    (value.status === "completed" || value.status === "aborted" || value.status === "error") &&
    typeof value.sessionSettled === "boolean" &&
    (value.id === undefined || (typeof value.id === "string" && value.id.length > 0))
  );
}

function isExtensionUiRequest(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OmpWire.ExtensionUiRequest {
  if (
    value.type !== "extension_ui_request" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.method !== "string" ||
    UI_REQUEST_METHODS[value.method] !== true
  ) {
    return false;
  }
  return (
    value.method !== "cancel" || (typeof value.targetId === "string" && value.targetId.length > 0)
  );
}

function isHostRequest(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OmpHostRequest {
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.type === "host_tool_call") {
    return (
      typeof value.toolCallId === "string" &&
      typeof value.toolName === "string" &&
      isRecord(value.arguments)
    );
  }
  if (value.type === "host_tool_cancel" || value.type === "host_uri_cancel") {
    return typeof value.targetId === "string" && value.targetId.length > 0;
  }
  if (value.type === "host_uri_request") {
    return (
      (value.operation === "read" || value.operation === "write") &&
      typeof value.url === "string" &&
      (value.operation !== "write" || typeof value.content === "string")
    );
  }
  return false;
}

function isExtensionUiResponse(
  value: unknown,
): value is Record<string, unknown> & ExtensionUiResponse {
  if (!isRecord(value) || value.type !== "extension_ui_response") return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (typeof value.value === "string" ||
      typeof value.confirmed === "boolean" ||
      value.cancelled === true ||
      Array.isArray(value.answers))
  );
}

function isHostToolResponse(value: unknown): value is Record<string, unknown> & HostToolResponse {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.type === "host_tool_update") return isRecord(value.partialResult);
  return value.type === "host_tool_result" && isRecord(value.result);
}

function isHostUriResponse(value: unknown): value is Record<string, unknown> & HostUriResponse {
  return (
    isRecord(value) &&
    value.type === "host_uri_result" &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function isDialogRequest(value: OmpWire.ExtensionUiRequest): boolean {
  return DIALOG_METHODS[value.method] === true;
}

function createFailure(
  code: AppErrorCode,
  message: string,
  retryable: boolean,
  omp?: AppError["omp"],
): AppFailure {
  return new AppFailure({
    code,
    message,
    retryable,
    ...(omp === undefined ? {} : { omp }),
  });
}

function asTransportFailure(cause: unknown): AppFailure {
  if (cause instanceof AppFailure) return cause;
  return createFailure("omp_exited", "The omp RPC transport closed", true);
}

/** omp refuses a prompt that arrives while its agent is still running a turn: `AgentBusyError` (omp v18.6.1, packages/agent/src/agent.ts:103). */
const AGENT_BUSY_REFUSAL = "Agent is already processing.";
/** What the browser shows for that refusal: plain words, never omp's own text. */
const AGENT_BUSY_MESSAGE = "omp is still working on something.";

function isAgentBusyRefusal(message: string | undefined): boolean {
  return message?.startsWith(AGENT_BUSY_REFUSAL) === true;
}

function agentBusyFailure(): AppFailure {
  return createFailure("agent_busy", AGENT_BUSY_MESSAGE, true);
}

function commandFailure(response: OmpResponse): AppFailure {
  const message = typeof response.error === "string" ? response.error : "omp command failed";
  if (isAgentBusyRefusal(message)) return agentBusyFailure();
  return createFailure("omp_error", message, false, {
    command: response.command,
    error: message,
    ...(typeof response.code === "string" ? { code: response.code } : {}),
  });
}

function promptFailure(event: OmpWire.PromptResultEvent): AppFailure {
  const detail = event.error;
  if (isAgentBusyRefusal(detail?.message)) return agentBusyFailure();
  return createFailure(
    "omp_error",
    detail?.message ?? "omp prompt failed",
    detail?.retryable ?? false,
    {
      error: detail?.message ?? "omp prompt failed",
      ...(detail?.provider === undefined ? {} : { provider: detail.provider }),
      ...(detail?.model === undefined ? {} : { model: detail.model }),
      ...(detail?.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
    },
  );
}

interface CreatedCommandFuture<T, Admission> {
  readonly future: CommandFuture<T, Admission>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly resolveAdmission: (value: Admission | PromiseLike<Admission>) => void;
  readonly rejectAdmission: (reason?: unknown) => void;
}

function createCommandFuture<T, Admission>(
  id: string,
  command: OmpCommandName,
): CreatedCommandFuture<T, Admission> {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  }) as CommandFuture<T, Admission>;
  let resolveAdmission: (value: Admission | PromiseLike<Admission>) => void = () => undefined;
  let rejectAdmission: (reason?: unknown) => void = () => undefined;
  const admitted = new Promise<Admission>((admissionResolve, admissionReject) => {
    resolveAdmission = admissionResolve;
    rejectAdmission = admissionReject;
  });
  void admitted.catch(() => undefined);
  Object.defineProperties(promise, {
    id: { configurable: false, enumerable: false, value: id },
    command: { configurable: false, enumerable: false, value: command },
    admitted: { configurable: false, enumerable: false, value: admitted },
  });
  return { future: promise, resolve, reject, resolveAdmission, rejectAdmission };
}

function frameLine(frame: object): string {
  return `${JSON.stringify(frame)}\n`;
}

/** One protocol-aware session over an abstract byte duplex. */
export class RpcSession {
  readonly #duplex: RpcDuplex;
  readonly #decoder: FrameDecoder;
  readonly #timer: RpcSessionTimer;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #uiRequests = new Map<string, OmpWire.ExtensionUiRequest>();
  readonly #hostToolRequests = new Map<string, OmpWire.HostToolCallRequest>();
  readonly #hostUriRequests = new Map<string, OmpWire.HostUriRequest>();
  readonly #listeners = new Set<RpcSessionListener>();
  readonly #requestListeners = new Set<RpcRequestListener>();
  readonly #unsubscribeChunk: () => void;
  readonly #unsubscribeClose: () => void;
  #writeTail: Promise<void> = Promise.resolve();
  #readyPromise: Promise<OmpWire.ReadyEvent | undefined>;
  #resolveReady: ((ready?: OmpWire.ReadyEvent) => void) | undefined;
  #ready?: OmpWire.ReadyEvent;
  #startPromise?: Promise<void>;
  #state: RpcSessionState = "new";
  #protocolVersion: 1 | 2 = 1;
  #nextCommandId = 0;
  #closed = false;

  constructor(duplex: RpcDuplex, options: RpcSessionOptions = {}) {
    this.#duplex = duplex;
    this.#decoder = new FrameDecoder(options.decoder);
    this.#timer = options.timer ?? defaultTimer();
    this.#readyPromise = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#unsubscribeChunk = duplex.onChunk((chunk) => this.receive(chunk));
    this.#unsubscribeClose = duplex.onClose((cause) => this.#handleClose(cause));
  }

  get state(): RpcSessionState {
    return this.#state;
  }

  get protocolVersion(): 1 | 2 {
    return this.#protocolVersion;
  }

  get ready(): OmpWire.ReadyEvent | undefined {
    return this.#ready;
  }

  /** Start the ready handshake and negotiate v2 when omp advertises it. */
  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#closed || this.#state === "stopped") {
      return Promise.reject(createFailure("cancelled", "The RPC session is closed", false));
    }
    this.#state = "starting";
    this.#emit({ kind: "process", status: "starting" });
    this.#startPromise = this.#startHandshake();
    return this.#startPromise;
  }

  /** Feed a byte chunk when an adapter does not use `RpcDuplex.onChunk`. */
  receive(chunk: FrameDecoderInput): void {
    const events = this.#decoder.push(chunk);
    for (const event of events) {
      if (event.type === "decode_error") {
        this.#emitProcessError(
          createFailure("invalid_args", `RPC frame decode failed: ${event.message}`, false),
        );
        continue;
      }
      this.#handleFrame(event.frame);
    }
  }

  onEvent(listener: RpcSessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onRequest(listener: RpcRequestListener): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  send<K extends OmpCommandName>(
    command: OmpCommand<K>,
    options: { readonly signal?: AbortSignalLike } = {},
  ): CommandFuture<OmpCommandMap[K]["result"], OmpCommandMap[K]["result"]> {
    return this.#sendCommand(command, options, false);
  }

  setSubagentSubscription(
    level: OmpWire.SubagentSubscriptionLevel,
    options: { readonly signal?: AbortSignalLike } = {},
  ): CommandFuture<
    OmpCommandMap["set_subagent_subscription"]["result"],
    OmpCommandMap["set_subagent_subscription"]["result"]
  > {
    return this.send({ type: "set_subagent_subscription", level }, options);
  }

  setEventFilter(
    events: string[] | null,
    messageUpdates?: OmpWire.MessageUpdates,
    options: { readonly signal?: AbortSignalLike } = {},
  ): CommandFuture<
    OmpCommandMap["set_event_filter"]["result"],
    OmpCommandMap["set_event_filter"]["result"]
  > {
    return this.send({ type: "set_event_filter", events, messageUpdates }, options);
  }

  answerExtensionUi(response: ExtensionUiResponse): Promise<void> {
    if (!isExtensionUiResponse(response)) {
      return Promise.reject(createFailure("invalid_args", "Invalid extension UI response", false));
    }
    const request = this.#uiRequests.get(response.id);
    if (request === undefined || !isDialogRequest(request)) {
      return Promise.reject(createFailure("not_found", "No pending extension UI request", false));
    }
    this.#uiRequests.delete(response.id);
    return this.#writeInbound(response);
  }

  answerHostTool(response: HostToolResponse): Promise<void> {
    if (!isHostToolResponse(response)) {
      return Promise.reject(createFailure("invalid_args", "Invalid host tool response", false));
    }
    const request = this.#hostToolRequests.get(response.id);
    if (request === undefined) {
      return Promise.reject(createFailure("not_found", "No pending host tool request", false));
    }
    if (response.type === "host_tool_result") this.#hostToolRequests.delete(response.id);
    return this.#writeInbound(response);
  }

  answerHostUri(response: HostUriResponse): Promise<void> {
    if (!isHostUriResponse(response)) {
      return Promise.reject(createFailure("invalid_args", "Invalid host URI response", false));
    }
    if (!this.#hostUriRequests.has(response.id)) {
      return Promise.reject(createFailure("not_found", "No pending host URI request", false));
    }
    this.#hostUriRequests.delete(response.id);
    return this.#writeInbound(response);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = "stopped";
    this.#unsubscribeChunk();
    this.#unsubscribeClose();
    const failure = createFailure("cancelled", "The RPC session was closed", false);
    this.#rejectAll(failure);
    this.#resolveReady?.();
    this.#resolveReady = undefined;
    this.#uiRequests.clear();
    this.#hostToolRequests.clear();
    this.#hostUriRequests.clear();
    this.#emit({ kind: "process", status: "stopped" });
    try {
      await this.#duplex.close?.();
    } catch {
      // The session is already stopped; a transport close failure cannot change its outcome.
    }
  }

  async #startHandshake(): Promise<void> {
    try {
      const ready = await this.#readyPromise;
      if (ready === undefined) {
        throw createFailure("omp_exited", "The omp RPC transport closed before ready", true);
      }
      this.#state = "negotiating";
      if (ready.supportedProtocolVersions?.includes(2) === true) {
        const response = await this.#sendCommand(
          { type: "negotiate_protocol", protocolVersion: 2 },
          {},
          true,
        );
        if (response === undefined || !isRecord(response) || response.protocolVersion !== 2) {
          throw createFailure("omp_error", "omp protocol v2 negotiation failed", false, {
            command: "negotiate_protocol",
            error: "omp protocol v2 negotiation failed",
          });
        }
        this.#protocolVersion = 2;
      }
      this.#state = "ready";
      this.#emit({ kind: "process", status: "ready" });
    } catch (cause) {
      const failure = cause instanceof AppFailure ? cause : asTransportFailure(cause);
      this.#state = "error";
      this.#emitProcessError(failure);
      this.#rejectAll(failure);
      throw failure;
    }
  }

  #sendCommand<K extends OmpCommandName>(
    command: OmpCommand<K>,
    options: { readonly signal?: AbortSignalLike },
    allowStarting: boolean,
  ): CommandFuture<OmpCommandMap[K]["result"], OmpCommandMap[K]["result"]> {
    if ((!allowStarting && this.#state !== "ready") || this.#closed) {
      return this.#rejectedFuture(
        command,
        createFailure("conflict", "The RPC session is not ready", true),
      );
    }
    if (!isOmpCommand(command)) {
      return this.#rejectedFuture(
        command,
        createFailure("invalid_args", "Invalid omp command", false),
      );
    }
    const signal = options.signal;
    if (signal?.aborted === true) {
      return this.#rejectedFuture(
        command,
        createFailure("cancelled", "The command was cancelled", false),
      );
    }

    const id = command.id ?? `rpc-${++this.#nextCommandId}`;
    if (this.#pending.has(id)) {
      return this.#rejectedFuture(
        command,
        createFailure("conflict", "Duplicate omp command id", false),
      );
    }
    const wireCommand = { ...command, id } as OmpCommand<K>;
    let line: string;
    try {
      line = frameLine(wireCommand);
    } catch {
      return this.#rejectedFuture(
        command,
        createFailure("invalid_args", "Command is not serializable", false),
      );
    }

    const created = createCommandFuture<OmpCommandMap[K]["result"], OmpCommandMap[K]["result"]>(
      id,
      command.type,
    );
    const pending: PendingCommand = {
      id,
      command: command.type,
      completion: OMP_COMMANDS[command.type].completion,
      resolve: (value) => created.resolve(value as OmpCommandMap[K]["result"]),
      reject: (error) => created.reject(error),
      resolveAdmission: (value) => created.resolveAdmission(value as OmpCommandMap[K]["result"]),
      rejectAdmission: (error) => created.rejectAdmission(error),
      responseReceived: false,
      admissionSettled: false,
    };
    this.#pending.set(id, pending);
    this.#armCommand(pending, signal);
    void this.#writeLine(line).catch(() => this.#handleWriteFailure(id));
    return created.future;
  }
  #rejectedFuture<K extends OmpCommandName>(
    command: OmpCommand<K>,
    failure: AppFailure,
  ): CommandFuture<OmpCommandMap[K]["result"], OmpCommandMap[K]["result"]> {
    const id = typeof command.id === "string" ? command.id : `rpc-${this.#nextCommandId + 1}`;

    const created = createCommandFuture<OmpCommandMap[K]["result"], OmpCommandMap[K]["result"]>(
      id,
      command.type,
    );
    created.reject(failure);
    created.rejectAdmission(failure);
    return created.future;
  }

  #armCommand(pending: PendingCommand, signal: AbortSignalLike | undefined): void {
    const timeoutMs = OMP_COMMANDS[pending.command].timeoutMs;
    if (timeoutMs !== null) {
      pending.timerHandle = this.#timer.setTimeout(() => {
        if (this.#pending.get(pending.id) !== pending) return;
        this.#rejectPending(
          pending,
          createFailure("timeout", `Timed out waiting for ${pending.command}`, true),
        );
      }, timeoutMs);
    }
    if (signal === undefined) return;
    const onAbort = () => {
      if (this.#pending.get(pending.id) !== pending) return;
      this.#rejectPending(pending, createFailure("cancelled", "The command was cancelled", false));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.removeAbort = () => signal.removeEventListener("abort", onAbort);
  }

  #removePending(pending: PendingCommand): void {
    if (this.#pending.get(pending.id) !== pending) return;
    this.#pending.delete(pending.id);
    if (pending.timerHandle !== undefined) this.#timer.clearTimeout(pending.timerHandle);
    pending.removeAbort?.();
    pending.timerHandle = undefined;
    pending.removeAbort = undefined;
  }
  #resolveAdmission(pending: PendingCommand, value: unknown): void {
    if (pending.admissionSettled) return;
    pending.admissionSettled = true;
    pending.resolveAdmission(value);
  }

  #rejectAdmission(pending: PendingCommand, error: AppFailure): void {
    if (pending.admissionSettled) return;
    pending.admissionSettled = true;
    pending.rejectAdmission(error);
  }

  #rejectPending(pending: PendingCommand, error: AppFailure): void {
    this.#removePending(pending);
    this.#rejectAdmission(pending, error);
    pending.reject(error);
  }

  #handleFrame(frame: Record<string, unknown>): void {
    if (frame.type === "ready") {
      if (!isReadyFrame(frame)) {
        this.#emitProcessError(createFailure("invalid_args", "Invalid omp ready frame", false));
        return;
      }
      if (this.#ready !== undefined) {
        this.#emitProcessError(createFailure("conflict", "Duplicate omp ready frame", false));
        return;
      }
      this.#ready = frame;
      this.#resolveReady?.(frame);
      this.#resolveReady = undefined;
      return;
    }
    if (frame.type === "response") {
      if (!isResponseFrame(frame)) {
        this.#emitProcessError(createFailure("invalid_args", "Invalid omp response frame", false));
        return;
      }
      this.#handleResponse(frame);
      return;
    }
    if (frame.type === "prompt_result") {
      if (!isPromptResultFrame(frame)) {
        this.#emitProcessError(
          createFailure("invalid_args", "Invalid omp prompt_result frame", false),
        );
        return;
      }
      this.#handlePromptResult(frame);
      return;
    }
    if (frame.type === "session_settled") {
      this.#emit({
        kind: "session_settled",
        event: frame as unknown as OmpWire.SessionSettledEvent,
      });
      return;
    }
    if (isExtensionUiRequest(frame)) {
      this.#trackUiRequest(frame);
      this.#emitNotification(frame);
      return;
    }
    if (isHostRequest(frame)) {
      this.#trackHostRequest(frame);
      this.#emitNotification(frame);
      return;
    }
    if (
      frame.type === "extension_ui_request" ||
      (typeof frame.type === "string" && frame.type.startsWith("host_"))
    ) {
      this.#emitProcessError(
        createFailure("invalid_args", "Invalid omp host request frame", false),
      );
      return;
    }
    if (typeof frame.type !== "string" || frame.type.length === 0) {
      this.#emitProcessError(
        createFailure("invalid_args", "Invalid omp notification frame", false),
      );
      return;
    }
    if (OMP_EVENT_TYPES[frame.type] === true) {
      this.#emit({ kind: "omp", event: frame as unknown as OmpEvent });
      return;
    }
    this.#emitNotification(frame);
  }

  #handleResponse(response: OmpResponse): void {
    if (response.id === undefined) {
      this.#emitProcessError(createFailure("conflict", "Uncorrelated omp response", false));
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    if (pending.command !== response.command) {
      this.#rejectPending(
        pending,
        createFailure("conflict", "Omp response command did not match its request", false),
      );
      return;
    }
    if (!response.success) {
      this.#rejectPending(pending, commandFailure(response));
      return;
    }
    pending.responseReceived = true;
    pending.responseData = response.data;
    this.#resolveAdmission(pending, response.data);
    if (
      pending.completion === null ||
      (isRecord(response.data) && response.data.agentInvoked === false)
    ) {
      this.#resolvePending(pending, response.data);
      return;
    }
    if (pending.promptResult?.status === "error") {
      this.#rejectPending(pending, promptFailure(pending.promptResult));
      return;
    }
    if (pending.promptResult !== undefined) this.#resolvePending(pending, response.data);
  }

  #handlePromptResult(event: OmpWire.PromptResultEvent): void {
    // A refusal because omp is still running a turn is the failure of the prompt that asked, not an event of the thread.
    if (!(event.status === "error" && isAgentBusyRefusal(event.error?.message))) {
      this.#emit({ kind: "prompt_result", event });
    }
    if (event.id === undefined) return;
    const pending = this.#pending.get(event.id);
    if (pending === undefined || pending.completion !== "prompt_result") return;
    if (event.status === "error") {
      pending.promptResult = event;
      if (pending.responseReceived) this.#rejectPending(pending, promptFailure(event));
      return;
    }
    pending.promptResult = event;
    if (pending.responseReceived) this.#resolvePending(pending, pending.responseData);
  }

  #resolvePending(pending: PendingCommand, value: unknown): void {
    this.#removePending(pending);
    pending.resolve(value);
  }

  #trackUiRequest(request: OmpWire.ExtensionUiRequest): void {
    if (request.method === "cancel") {
      this.#uiRequests.delete(request.targetId);
    } else if (isDialogRequest(request)) {
      if (this.#uiRequests.has(request.id)) {
        this.#emitProcessError(
          createFailure("conflict", "Duplicate extension UI request id", false),
        );
      } else {
        this.#uiRequests.set(request.id, request);
      }
    }
    this.#notifyRequest(request);
  }

  #trackHostRequest(request: OmpHostRequest): void {
    if (request.type === "host_tool_call") {
      if (this.#hostToolRequests.has(request.id)) {
        this.#emitProcessError(createFailure("conflict", "Duplicate host tool request id", false));
      } else {
        this.#hostToolRequests.set(request.id, request);
      }
    } else if (request.type === "host_tool_cancel") {
      this.#hostToolRequests.delete(request.targetId);
    } else if (request.type === "host_uri_request") {
      if (this.#hostUriRequests.has(request.id)) {
        this.#emitProcessError(createFailure("conflict", "Duplicate host URI request id", false));
      } else {
        this.#hostUriRequests.set(request.id, request);
      }
    } else {
      this.#hostUriRequests.delete(request.targetId);
    }
    this.#notifyRequest(request);
  }

  #notifyRequest(request: RpcSessionRequest): void {
    for (const listener of [...this.#requestListeners]) listener(request);
  }

  #emitNotification(frame: Record<string, unknown>): void {
    this.#emit({ kind: "notification", frame: frame as unknown as RpcSessionNotification });
  }

  #emit(event: RpcSessionEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  #emitProcessError(failure: AppFailure): void {
    this.#emit({ kind: "process", status: "error", error: failure.appError });
  }

  #writeInbound(frame: object): Promise<void> {
    let line: string;
    try {
      line = frameLine(frame);
    } catch {
      return Promise.reject(createFailure("invalid_args", "Response is not serializable", false));
    }
    return this.#writeLine(line).catch(() => {
      throw asTransportFailure(undefined);
    });
  }

  #writeLine(line: string): Promise<void> {
    const next = this.#writeTail.then(() => this.#duplex.writeLine(line));
    this.#writeTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #handleWriteFailure(id: string): void {
    const pending = this.#pending.get(id);
    const failure = createFailure("omp_exited", "The omp RPC transport rejected a write", true);
    if (pending !== undefined) this.#rejectPending(pending, failure);
    this.#state = "error";
    this.#emitProcessError(failure);
  }

  #handleClose(cause?: unknown): void {
    if (this.#closed) return;
    const decoderEvents = this.#decoder.finish();
    for (const event of decoderEvents) {
      if (event.type === "decode_error") {
        this.#emitProcessError(
          createFailure("invalid_args", `RPC frame decode failed: ${event.message}`, false),
        );
      }
    }
    this.#closed = true;
    this.#state = "stopped";
    const failure = asTransportFailure(cause);
    this.#rejectAll(failure);
    this.#resolveReady?.();
    this.#resolveReady = undefined;
    this.#uiRequests.clear();
    this.#hostToolRequests.clear();
    this.#hostUriRequests.clear();
    this.#emit({ kind: "process", status: "exited", error: failure.appError });
  }

  #rejectAll(failure: AppFailure): void {
    for (const pending of [...this.#pending.values()]) {
      this.#rejectPending(pending, failure);
    }
    this.#pending.clear();
  }
}

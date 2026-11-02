import {
  APP_PROTOCOL,
  type AppError,
  AppFailure,
  CallFrame,
  CancelFrame,
  type EventFrame,
  HelloFrame,
  type Port,
  type PortCallOptions,
  type PortClient,
  parseServerFrame,
  RequestId,
  type ResultFrame,
  type StreamKey,
  SubscribeFrame,
  SubscribeResult,
  serializeFrame,
  streamKey,
  UnsubscribeFrame,
  type WelcomeFrame,
} from "@omp-app/contracts";
import { z } from "zod";

const CLIENT_NAME = "@omp-app/client";
const CLIENT_VERSION = "0.0.0";

/** The small WebSocket surface shared by browsers and the in-process test server. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionStateEvent {
  readonly state: ConnectionState;
  readonly attempt: number;
  readonly error?: AppError;
  /**
   * Why the server refused this connection: an expired or invalid launch link, a device that is not paired (or was
   * removed), or a page address it does not allow.
   */
  readonly refusal?: "expired" | "invalid" | "unpaired" | "origin";
}

export type ResyncReason =
  | "instance-changed"
  | "stale-resume"
  | "gap"
  | "invalid-event"
  /** The server refused to resume a subscription after a reconnect; it receives no more events. */
  | "subscription-failed";

export interface ResyncEvent {
  readonly reason: ResyncReason;
  readonly stream?: StreamKey;
  readonly instanceId?: string;
  /** Why the subscription failed (`subscription-failed` only). */
  readonly error?: AppError;
}

export interface ReconnectOptions {
  /** Delay before the first reconnect attempt. Defaults to 100 ms. */
  readonly baseDelayMs?: number;
  /** Maximum reconnect delay. Defaults to 5 seconds. */
  readonly maxDelayMs?: number;
  /** Optional cap; omitted means reconnect forever until disposed. */
  readonly maxAttempts?: number;
}

export interface CreateAppClientOptions {
  readonly url: string;
  /** The launch link's token; omitted for a paired device, which signs in with its key's cookie. */
  readonly token?: string;
  readonly reconnect?: ReconnectOptions;
  /** Injected only for isomorphic tests; browsers use their standard WebSocket global. */
  readonly webSocketFactory?: WebSocketFactory;
  readonly timers?: TimerScheduler;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface AppClientSubscription<Payload> {
  readonly stream: StreamKey;
  readonly lastSeq: number;
  onEvent(listener: (payload: Payload, seq: number) => void): () => void;
  unsubscribe(): Promise<void>;
}

export interface AppClient {
  readonly connectionState: ConnectionState;
  readonly instanceId: string | undefined;
  onConnectionState(listener: (event: ConnectionStateEvent) => void): () => void;
  onResync(listener: (event: ResyncEvent) => void): () => void;
  port<P extends Port>(port: P): PortClient<P>;
  subscribe<P extends Port, E extends keyof P["events"]>(
    port: P,
    event: E,
    options?: SubscribeOptions<PortEventValue<P, E>>,
  ): Promise<AppClientSubscription<PortEventValue<P, E>>>;
  /**
   * Connects again now: a reconnect waiting for its next try starts at once, and an open link that may be dead (one that
   * stopped answering) is dropped and opened again. Does nothing after the server refused this page: that stays.
   */
  reconnectNow(): void;
  dispose(): void;
}

export interface SubscribeOptions<Payload = unknown> {
  readonly scope?: string;
  /**
   * Where the subscription starts. Absent: live events only. A number, zero included: the events after it that the
   * server still holds, so zero asks for every event it holds, including those sent before the subscription.
   * When the server no longer holds the events after `afterSeq`, the subscription follows live events only.
   */
  readonly afterSeq?: number;
  readonly signal?: PortCallOptions["signal"];
  /**
   * Called for every event the subscription delivers, including the events the server replays before it acknowledges
   * the subscription. It is attached before the request, so no replayed event is missed. Passing the same function to
   * `subscription.onEvent` adds nothing (it is one listener), and the detach that call returns removes it.
   */
  readonly onEvent?: (payload: Payload, seq: number) => void;
}

type PortEventValue<P extends Port, E extends keyof P["events"]> = z.output<
  P["events"][E & keyof P["events"]]["payload"]
>;
type RequestFrame =
  | z.output<typeof CallFrame>
  | z.output<typeof SubscribeFrame>
  | z.output<typeof UnsubscribeFrame>;

type TimerHandle = unknown;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface PendingRequest {
  readonly deferred: Deferred<unknown>;
  readonly result: z.ZodType;
  readonly socket: WebSocketLike;
  readonly signal?: PortCallOptions["signal"];
  abortListener?: () => void;
  settled: boolean;
}

/** One caller's hold on a stream: the listeners it attached, and whether it has let go. */
interface SubscriptionHolder {
  readonly listeners: Set<(payload: unknown, seq: number) => void>;
  released: boolean;
}

interface SubscriptionRecord {
  stream: StreamKey;
  payload: z.ZodType;
  /** Every caller still holding the stream: it stays subscribed while any of them does. */
  holders: Set<SubscriptionHolder>;
  lastSeq: number;
  active: boolean;
  subscribed: boolean;
  hasCursor: boolean;
}

interface OpenWaiter {
  readonly deferred: Deferred<void>;
  readonly signal?: PortCallOptions["signal"];
  abortListener?: () => void;
}
export interface TimerScheduler {
  setTimeout?: (handler: () => void, delay: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}

const defaultTimers = globalThis as unknown as TimerScheduler;

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function appFailure(
  code: AppError["code"],
  message: string,
  retryable: boolean,
  capability?: AppError["capability"],
): AppFailure {
  return new AppFailure({ code, message, retryable, ...(capability ? { capability } : {}) });
}

function asAppFailure(error: unknown, fallback: AppFailure): AppFailure {
  return error instanceof AppFailure ? error : fallback;
}

function withToken(url: string, token: string): string {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : url.slice(hashIndex);
  const separator = beforeHash.includes("?")
    ? beforeHash.endsWith("?") || beforeHash.endsWith("&")
      ? ""
      : "&"
    : "?";
  return `${beforeHash}${separator}token=${encodeURIComponent(token)}${hash}`;
}
function isTextReader(value: unknown): value is { text(): Promise<unknown> } {
  if (typeof value !== "object" || value === null || !("text" in value)) return false;
  return typeof value.text === "function";
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket?: new (url: string) => WebSocketLike;
    }
  ).WebSocket;
  if (!WebSocketCtor) {
    throw appFailure(
      "unavailable",
      "WebSocket is unavailable in this runtime",
      false,
      "client.websocket",
    );
  }
  return new WebSocketCtor(url);
}

function isConflict(error: unknown): error is AppFailure {
  return error instanceof AppFailure && error.appError.code === "conflict";
}

function closeReason(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("reason" in event)) return undefined;
  const value = event.reason;
  return typeof value === "string" ? value : undefined;
}

function closeCode(event: unknown): number | undefined {
  if (typeof event !== "object" || event === null || !("code" in event)) return undefined;
  const value = event.code;
  return typeof value === "number" ? value : undefined;
}

class AppClientImpl implements AppClient {
  private readonly options: CreateAppClientOptions;
  private readonly reconnect: Required<Pick<ReconnectOptions, "baseDelayMs" | "maxDelayMs">> &
    Pick<ReconnectOptions, "maxAttempts">;
  private readonly factory: WebSocketFactory;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<StreamKey, SubscriptionRecord>();
  private readonly stateListeners = new Set<(event: ConnectionStateEvent) => void>();
  private readonly resyncListeners = new Set<(event: ResyncEvent) => void>();
  private readonly openWaiters = new Set<OpenWaiter>();
  private readonly proxies = new Map<string, PortClient<Port>>();
  private socket: WebSocketLike | undefined;
  private socketGeneration = 0;
  private welcomeReceived = false;
  private disposed = false;
  private terminal = false;
  /** The failure that closed the connection for good: a refused token, or the reconnect budget used up. */
  private closedFailure: AppFailure | undefined;
  private requestCounter = 0;
  private readonly timers: TimerScheduler;
  private reconnectAttempt = 0;
  /** Whether the link was ever open: every try after that is a reconnect, also one whose own socket never opened. */
  private everOpen = false;
  private reconnectTimer: TimerHandle | undefined;
  private _connectionState: ConnectionState = "connecting";
  private _instanceId: string | undefined;

  constructor(options: CreateAppClientOptions) {
    this.options = options;
    this.reconnect = {
      baseDelayMs: Math.max(0, options.reconnect?.baseDelayMs ?? 100),
      maxDelayMs: Math.max(0, options.reconnect?.maxDelayMs ?? 5000),
      maxAttempts: options.reconnect?.maxAttempts,
    };
    this.timers = options.timers ?? defaultTimers;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.connectNow();
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get instanceId(): string | undefined {
    return this._instanceId;
  }

  onConnectionState(listener: (event: ConnectionStateEvent) => void): () => void {
    this.stateListeners.add(listener);
    this.notifyListener(listener, { state: this._connectionState, attempt: this.reconnectAttempt });
    return () => this.stateListeners.delete(listener);
  }

  onResync(listener: (event: ResyncEvent) => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  port<P extends Port>(port: P): PortClient<P> {
    const cached = this.proxies.get(port.name);
    if (cached) return cached as PortClient<P>;
    const methods: Record<string, unknown> = {};
    for (const methodName of Object.keys(port.methods)) {
      methods[methodName] = (args: unknown, callOptions?: PortCallOptions) =>
        this.callPort(port, methodName, args, callOptions);
    }
    const proxy = methods as PortClient<P>;
    this.proxies.set(port.name, proxy as PortClient<Port>);
    return proxy;
  }

  async subscribe<P extends Port, E extends keyof P["events"]>(
    port: P,
    event: E,
    options: SubscribeOptions<PortEventValue<P, E>> = {},
  ): Promise<AppClientSubscription<PortEventValue<P, E>>> {
    const eventName = String(event);
    const eventDefinitions: Record<string, { readonly payload: z.ZodType }> = port.events;
    const eventDefinition = eventDefinitions[eventName];
    if (!eventDefinition) {
      throw appFailure("invalid_args", `Unknown event ${eventName}`, false);
    }
    if (
      options.afterSeq !== undefined &&
      (!Number.isInteger(options.afterSeq) || options.afterSeq < 0)
    ) {
      throw appFailure("invalid_args", "afterSeq must be a non-negative integer", false);
    }
    if (this.closedFailure) throw this.closedFailure;
    const stream = streamKey(port.name, eventName, options.scope);
    // Records dispatch only payloads their event's schema accepted, so the listener's payload type holds.
    const listener = options.onEvent as ((payload: unknown, seq: number) => void) | undefined;
    const existing = this.subscriptions.get(stream);
    if (existing) {
      // The stream is already subscribed (a chat kept for its running turn): this caller joins it with a hold of its
      // own, and no second request is sent. Letting go of that hold leaves the stream to the other callers.
      const joined = this.addHolder(existing, listener);
      return this.handleFor(existing, joined) as AppClientSubscription<PortEventValue<P, E>>;
    }

    const record = this.createSubscription(
      stream,
      eventDefinition.payload,
      options.afterSeq ?? 0,
      options.afterSeq !== undefined,
    );
    const own = this.addHolder(record, listener);
    this.subscriptions.set(stream, record);
    try {
      await this.waitForOpen(options.signal);
      await this.subscribeRecord(
        record,
        record.hasCursor ? record.lastSeq : undefined,
        options.signal,
      );
      return this.handleFor(record, own) as AppClientSubscription<PortEventValue<P, E>>;
    } catch (error) {
      // Only this subscribe's own record leaves the map; a later subscribe may have made another for the stream.
      if (this.subscriptions.get(stream) === record) this.subscriptions.delete(stream);
      record.active = false;
      record.holders.clear();
      throw error;
    }
  }

  reconnectNow(): void {
    if (this.disposed || this.terminal) return;
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout?.(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempt = 0;
    const socket = this.socket;
    if (socket !== undefined) {
      // Dropped as if it had closed: once it is not the current socket, its own late close is ignored.
      this.socket = undefined;
      this.welcomeReceived = false;
      try {
        socket.close(4000, "reconnect");
      } catch {
        // A socket that is already closed has nothing more to close.
      }
      this.rejectPending(appFailure("unavailable", "Connection to the app server closed", true));
      this.setConnectionState(this.everOpen ? "reconnecting" : "connecting");
    }
    this.connectNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout?.(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const error = appFailure("cancelled", "Client disposed", false);
    this.rejectPending(error);
    this.rejectOpenWaiters(error);
    for (const record of this.subscriptions.values()) {
      record.active = false;
      record.holders.clear();
    }
    this.subscriptions.clear();
    const socket = this.socket;
    this.socket = undefined;
    this.welcomeReceived = false;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, "disposed");
      } catch {
        // A browser can throw when a socket is already closed; disposal is still complete.
      }
    }
    this.setConnectionState("closed");
  }

  private connectNow(): void {
    if (this.disposed || this.terminal) return;
    const url =
      this.options.token === undefined
        ? this.options.url
        : withToken(this.options.url, this.options.token);
    let socket: WebSocketLike;
    try {
      socket = this.factory(url);
    } catch (error) {
      this.handleConnectionFailure(
        asAppFailure(error, appFailure("unavailable", "Connection to the app server failed", true)),
      );
      return;
    }
    const generation = ++this.socketGeneration;
    this.socket = socket;
    this.welcomeReceived = false;
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      try {
        const hello = HelloFrame.parse({
          type: "hello",
          protocols: [APP_PROTOCOL],
          client: {
            name: this.options.clientName ?? CLIENT_NAME,
            version: this.options.clientVersion ?? CLIENT_VERSION,
          },
        });
        socket.send(serializeFrame(hello));
      } catch {
        this.protocolFailure(socket);
      }
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      void this.receiveMessage(event.data).catch(() => this.protocolFailure(socket));
    };
    socket.onerror = () => {
      // Standard WebSockets follow error with close; waiting for close avoids duplicate reconnects.
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = undefined;
      this.welcomeReceived = false;
      const code = closeCode(event);
      if (code === 4401 || code === 4403) {
        this.terminal = true;
        let refusal: ConnectionStateEvent["refusal"];
        let message = "This page address is not allowed to reach omp-app";
        if (code === 4401) {
          const reason = closeReason(event);
          refusal =
            reason === "expired token"
              ? "expired"
              : reason === "not paired"
                ? "unpaired"
                : "invalid";
          message =
            refusal === "expired"
              ? "Launch link has expired"
              : refusal === "unpaired"
                ? "This device is not paired with the app"
                : "Launch token is not valid";
        } else {
          refusal = "origin";
        }
        const error = appFailure("permission", message, false);
        this.closedFailure = error;
        this.rejectPending(error);
        this.rejectOpenWaiters(error);
        this.setConnectionState("closed", error.appError, refusal);
        return;
      }
      this.rejectPending(appFailure("unavailable", "Connection to the app server closed", true));
      if (!this.disposed) this.scheduleReconnect();
    };
  }

  private isCurrent(socket: WebSocketLike, generation: number): boolean {
    return !this.disposed && this.socket === socket && this.socketGeneration === generation;
  }

  private async receiveMessage(data: unknown): Promise<void> {
    let text: string | undefined;
    if (typeof data === "string") {
      text = data;
    } else if (isTextReader(data)) {
      const result = await data.text();
      if (typeof result === "string") text = result;
    }
    if (text === undefined) throw new Error("WebSocket message is not text");
    const parsed = parseServerFrame(text);
    if (!parsed.ok) {
      this.protocolFailure(this.socket);
      return;
    }
    const frame = parsed.value;
    if (frame.type === "welcome") {
      this.handleWelcome(frame);
    } else if (frame.type === "result") {
      this.handleResult(frame);
    } else {
      this.handleEvent(frame);
    }
  }

  private handleWelcome(frame: z.output<typeof WelcomeFrame>): void {
    const previousInstanceId = this._instanceId;
    const instanceChanged =
      previousInstanceId !== undefined && previousInstanceId !== frame.instanceId;
    this._instanceId = frame.instanceId;
    this.welcomeReceived = true;
    this.everOpen = true;
    this.reconnectAttempt = 0;
    this.setConnectionState("open");
    this.resolveOpenWaiters();
    if (instanceChanged) {
      for (const record of this.subscriptions.values()) {
        record.lastSeq = 0;
        this.emitResync({
          reason: "instance-changed",
          stream: record.stream,
          instanceId: frame.instanceId,
        });
      }
    }
    void this.resumeSubscriptions(instanceChanged).catch(() => {
      // A close during resume is retried after the next welcome.
    });
  }

  private handleResult(frame: z.output<typeof ResultFrame>): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    pending.settled = true;
    this.removeAbortListener(pending);
    if (!frame.ok) {
      pending.deferred.reject(new AppFailure(frame.error));
      return;
    }
    const result = pending.result.safeParse(frame.value);
    if (!result.success) {
      // Most often the page is older than the app server: an update added to an answer what this page doesn't know.
      pending.deferred.reject(
        appFailure(
          "internal",
          "Server returned an invalid result. If the app was updated, reload this page.",
          false,
        ),
      );
      return;
    }
    pending.deferred.resolve(result.data);
  }

  private handleEvent(frame: z.output<typeof EventFrame>): void {
    const record = this.subscriptions.get(frame.stream);
    if (!record?.active) return;
    if (frame.seq <= record.lastSeq) return;
    if (record.lastSeq > 0 && frame.seq !== record.lastSeq + 1) {
      this.emitResync({ reason: "gap", stream: record.stream });
    }
    const payload = record.payload.safeParse(frame.payload);
    if (!payload.success) {
      this.emitResync({ reason: "invalid-event", stream: record.stream });
      this.protocolFailure(this.socket);
      return;
    }
    record.lastSeq = frame.seq;
    for (const listener of this.listenersOf(record)) {
      // A listener that an earlier listener for this event released gets nothing more of it.
      if (!record.active || !this.holdsListener(record, listener)) continue;
      try {
        listener(payload.data, frame.seq);
      } catch {
        // Consumer errors must not stop delivery to other listeners or the transport.
      }
    }
  }

  private createSubscription(
    stream: StreamKey,
    payload: z.ZodType,
    lastSeq: number,
    hasCursor: boolean,
  ): SubscriptionRecord {
    const record = {} as SubscriptionRecord;
    record.stream = stream;
    record.payload = payload;
    record.holders = new Set();
    record.lastSeq = lastSeq;
    record.hasCursor = hasCursor;
    record.subscribed = false;
    record.active = true;
    return record;
  }

  private addHolder(
    record: SubscriptionRecord,
    listener: ((payload: unknown, seq: number) => void) | undefined,
  ): SubscriptionHolder {
    const holder: SubscriptionHolder = { listeners: new Set(), released: false };
    if (listener) holder.listeners.add(listener);
    record.holders.add(holder);
    return holder;
  }

  /** One caller's handle on the stream: its listeners and its unsubscribe are its own, the stream is shared. */
  private handleFor(
    record: SubscriptionRecord,
    holder: SubscriptionHolder,
  ): AppClientSubscription<unknown> {
    return {
      get stream() {
        return record.stream;
      },
      get lastSeq() {
        return record.lastSeq;
      },
      onEvent: (listener: (payload: unknown, seq: number) => void) => {
        if (holder.released) return () => undefined;
        holder.listeners.add(listener);
        return () => {
          holder.listeners.delete(listener);
        };
      },
      unsubscribe: () => this.releaseHolder(record, holder),
    };
  }

  /** Every listener any holder attached, each once: a listener two callers attached gets each event once. */
  private listenersOf(record: SubscriptionRecord): Array<(payload: unknown, seq: number) => void> {
    const listeners = new Set<(payload: unknown, seq: number) => void>();
    for (const holder of record.holders) {
      for (const listener of holder.listeners) listeners.add(listener);
    }
    return [...listeners];
  }

  private holdsListener(
    record: SubscriptionRecord,
    listener: (payload: unknown, seq: number) => void,
  ): boolean {
    for (const holder of record.holders) {
      if (holder.listeners.has(listener)) return true;
    }
    return false;
  }

  /** Lets one caller's hold go: its listeners go with it, and the stream ends only when no caller holds it. */
  private async releaseHolder(
    record: SubscriptionRecord,
    holder: SubscriptionHolder,
  ): Promise<void> {
    if (holder.released) return;
    holder.released = true;
    holder.listeners.clear();
    record.holders.delete(holder);
    if (record.holders.size === 0) await this.unsubscribeRecord(record);
  }

  private async unsubscribeRecord(record: SubscriptionRecord): Promise<void> {
    if (!record.active) return;
    record.active = false;
    record.subscribed = false;
    if (this.subscriptions.get(record.stream) === record) this.subscriptions.delete(record.stream);
    record.holders.clear();
    if (!this.socket || !this.welcomeReceived || this.disposed) return;
    const id = this.nextRequestId();
    const frame = UnsubscribeFrame.parse({ type: "unsubscribe", id, stream: record.stream });
    await this.request(frame, z.null());
  }

  private async subscribeRecord(
    record: SubscriptionRecord,
    afterSeq: number | undefined,
    signal: PortCallOptions["signal"],
  ): Promise<void> {
    if (!record.active) throw appFailure("cancelled", "Subscription was removed", false);
    const id = this.nextRequestId();
    const input = {
      type: "subscribe" as const,
      id,
      stream: record.stream,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    };
    const frame = SubscribeFrame.parse(input);
    try {
      await this.request(frame, SubscribeResult, { signal });
      record.subscribed = true;
    } catch (error) {
      if (afterSeq !== undefined && isConflict(error)) {
        // The server no longer holds the events after `afterSeq`. A consumer that had events must refetch; a first
        // subscription from zero had none, so it follows live events without a resync.
        if (record.lastSeq > 0) this.emitResync({ reason: "stale-resume", stream: record.stream });
        record.lastSeq = 0;
        const retryId = this.nextRequestId();
        const retry = SubscribeFrame.parse({
          type: "subscribe",
          id: retryId,
          stream: record.stream,
        });
        await this.request(retry, SubscribeResult, { signal });
        record.subscribed = true;
        return;
      }
      throw error;
    }
  }

  private async resumeSubscriptions(instanceChanged: boolean): Promise<void> {
    const records = [...this.subscriptions.values()];
    for (const record of records) {
      if (!record.active || !record.subscribed || this.disposed || !this.welcomeReceived) continue;
      try {
        await this.subscribeRecord(
          record,
          instanceChanged || (record.lastSeq === 0 && !record.hasCursor)
            ? undefined
            : record.lastSeq,
          undefined,
        );
      } catch (error) {
        // A disconnect during resume is retried on the next welcome. A refusal from the server is
        // final for this record: stop it and tell consumers instead of going silent. The record leaves the map, so a
        // later subscribe to the stream makes a fresh record instead of joining this dead one.
        if (!this.welcomeReceived || this.disposed) continue;
        record.active = false;
        record.subscribed = false;
        if (this.subscriptions.get(record.stream) === record)
          this.subscriptions.delete(record.stream);
        record.holders.clear();
        this.emitResync({
          reason: "subscription-failed",
          stream: record.stream,
          error: asAppFailure(error, appFailure("internal", "Resubscribe failed", false)).appError,
        });
      }
    }
  }

  private callPort<P extends Port>(
    port: P,
    methodName: string,
    args: unknown,
    options?: PortCallOptions,
  ): Promise<unknown> {
    const method = port.methods[methodName];
    if (!method)
      return Promise.reject(appFailure("invalid_args", `Unknown method ${methodName}`, false));
    const parsedArgs = method.args.safeParse(args);
    if (!parsedArgs.success)
      return Promise.reject(appFailure("invalid_args", "Invalid port arguments", false));
    return this.waitForOpen(options?.signal).then(() => {
      const id = this.nextRequestId();
      const frame = CallFrame.parse({
        type: "call",
        id,
        port: port.name,
        method: methodName,
        args: parsedArgs.data,
      });
      return this.request(frame, method.result, options);
    });
  }

  private request<ResultSchema extends z.ZodType>(
    frame: RequestFrame,
    result: ResultSchema,
    options: PortCallOptions = {},
  ): Promise<z.output<ResultSchema>> {
    if (this.disposed) return Promise.reject(appFailure("cancelled", "Client disposed", false));
    const socket = this.socket;
    if (!socket || !this.welcomeReceived) {
      return Promise.reject(appFailure("unavailable", "Not connected to the app server", true));
    }
    if (options.signal?.aborted)
      return Promise.reject(appFailure("cancelled", "Call cancelled", false));
    const id = frame.id;
    const pending: PendingRequest = {
      deferred: createDeferred(),
      result,
      socket,
      signal: options.signal,
      settled: false,
    };
    this.pending.set(id, pending);
    const abortListener = () => {
      if (pending.settled) return;
      this.pending.delete(id);
      pending.settled = true;
      this.sendCancel(id, socket);
      pending.deferred.reject(appFailure("cancelled", "Call cancelled", false));
    };
    pending.abortListener = abortListener;
    options.signal?.addEventListener("abort", abortListener, { once: true });
    try {
      socket.send(serializeFrame(frame));
    } catch {
      this.pending.delete(id);
      pending.settled = true;
      this.removeAbortListener(pending);
      pending.deferred.reject(appFailure("unavailable", "Sending to the app server failed", true));
    }
    return pending.deferred.promise as Promise<z.output<ResultSchema>>;
  }

  private sendCancel(id: string, socket: WebSocketLike): void {
    if (this.disposed || this.socket !== socket) return;
    try {
      socket.send(serializeFrame(CancelFrame.parse({ type: "cancel", id })));
    } catch {
      // The call already rejected as cancelled; a closed socket needs no further action.
    }
  }

  private removeAbortListener(pending: PendingRequest): void {
    const listener = pending.abortListener;
    if (listener) pending.signal?.removeEventListener("abort", listener);
  }

  private nextRequestId(): RequestId {
    this.requestCounter += 1;
    return RequestId.parse(`request-${this.requestCounter}`);
  }

  private waitForOpen(signal?: PortCallOptions["signal"]): Promise<void> {
    if (this.disposed) return Promise.reject(appFailure("cancelled", "Client disposed", false));
    if (this._connectionState === "open" && this.socket && this.welcomeReceived)
      return Promise.resolve();
    if (this.closedFailure) return Promise.reject(this.closedFailure);
    if (signal?.aborted) return Promise.reject(appFailure("cancelled", "Call cancelled", false));
    const waiter: OpenWaiter = { deferred: createDeferred(), signal };
    this.openWaiters.add(waiter);
    const abortListener = () => {
      this.openWaiters.delete(waiter);
      waiter.deferred.reject(appFailure("cancelled", "Call cancelled", false));
    };
    waiter.abortListener = abortListener;
    signal?.addEventListener("abort", abortListener, { once: true });
    return waiter.deferred.promise.finally(() =>
      signal?.removeEventListener("abort", abortListener),
    );
  }

  private resolveOpenWaiters(): void {
    for (const waiter of this.openWaiters) {
      this.openWaiters.delete(waiter);
      const listener = waiter.abortListener;
      if (listener) waiter.signal?.removeEventListener("abort", listener);
      waiter.deferred.resolve();
    }
  }

  private rejectOpenWaiters(error: AppFailure): void {
    for (const waiter of this.openWaiters) {
      this.openWaiters.delete(waiter);
      const listener = waiter.abortListener;
      if (listener) waiter.signal?.removeEventListener("abort", listener);
      waiter.deferred.reject(error);
    }
  }

  private rejectPending(error: AppFailure): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.settled = true;
      this.removeAbortListener(pending);
      pending.deferred.reject(error);
    }
  }

  private setConnectionState(
    state: ConnectionState,
    error?: AppError,
    refusal?: ConnectionStateEvent["refusal"],
  ): void {
    if (this._connectionState === state && error === undefined && state !== "connecting") return;
    this._connectionState = state;
    const event = {
      state,
      attempt: this.reconnectAttempt,
      ...(error ? { error } : {}),
      ...(refusal ? { refusal } : {}),
    };
    for (const listener of this.stateListeners) this.notifyListener(listener, event);
  }

  private notifyListener<T>(listener: (event: T) => void, event: T): void {
    try {
      listener(event);
    } catch {
      // A consumer listener cannot be allowed to break transport cleanup or other listeners.
    }
  }

  private emitResync(event: ResyncEvent): void {
    for (const listener of this.resyncListeners) this.notifyListener(listener, event);
  }

  private handleConnectionFailure(error: AppFailure): void {
    this.rejectPending(error);
    if (!this.disposed) this.scheduleReconnect();
  }

  private protocolFailure(socket: WebSocketLike | undefined): void {
    this.rejectPending(appFailure("internal", "Invalid server frame", false));
    if (socket && this.socket === socket) {
      try {
        socket.close(1002, "invalid server frame");
      } catch {
        this.scheduleReconnect();
      }
    } else if (!this.disposed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.terminal || this.reconnectTimer !== undefined) return;
    const nextAttempt = this.reconnectAttempt + 1;
    if (this.reconnect.maxAttempts !== undefined && nextAttempt > this.reconnect.maxAttempts) {
      const error = appFailure("unavailable", "Could not reconnect to the app server", false);
      this.closedFailure = error;
      this.setConnectionState("closed");
      this.rejectOpenWaiters(error);
      return;
    }
    this.reconnectAttempt = nextAttempt;
    this.setConnectionState(this.everOpen ? "reconnecting" : "connecting");
    const exponent = Math.max(0, nextAttempt - 1);
    const delay = Math.min(this.reconnect.maxDelayMs, this.reconnect.baseDelayMs * 2 ** exponent);
    if (!this.timers.setTimeout) {
      this.connectNow();
      return;
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectNow();
    }, delay);
  }
}

export function createAppClient(options: CreateAppClientOptions): AppClient {
  if (options.url.length === 0 || options.token?.length === 0) {
    throw appFailure("invalid_args", "url is required, and a token when one is given", false);
  }
  return new AppClientImpl(options);
}

export { withToken as appendToken };

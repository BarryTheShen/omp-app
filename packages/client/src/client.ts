import {
  APP_PROTOCOL,
  type AppError,
  AppFailure,
  AppPort,
  CallFrame,
  CancelFrame,
  DEVICE_KEY_SHAPE,
  type EventFrame,
  HelloFrame,
  type Port,
  type PortCallOptions,
  type PortClient,
  parseServerFrame,
  RequestId,
  type ResultFrame,
  SOCKET_DEVICE_PROTOCOL_PREFIX,
  SOCKET_PROTOCOL,
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

/** Opens a socket to `url`, offering `protocols` (`Sec-WebSocket-Protocol`) when given. */
export type WebSocketFactory = (url: string, protocols?: readonly string[]) => WebSocketLike;

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
  /**
   * How long a try may take to be welcomed before it is dropped and the next one goes at once: a try whose handshake
   * stalls (a laptop just awake, its network not back) would otherwise wait until the system gives up, minutes later.
   * Doubles after each such drop, up to 32 s, so a slow but working link still gets through. Defaults to 8 seconds.
   */
  readonly tryTimeoutMs?: number;
}

/**
 * Why a link that worked was lost: its socket closed, a check of it got no answer, the page came back after longer away
 * than the server keeps a silent link, or a reconnect was asked for.
 */
export type OutageCause = "closed" | "no-answer" | "away" | "asked";

/** One outage of a link that worked, reported once the next link is welcomed and its streams are resumed. */
export interface OutageReport {
  readonly cause: OutageCause;
  /** The socket's close code and reason, when it closed. */
  readonly closeCode?: number;
  readonly closeReason?: string;
  /** From the loss to the new link's welcome, and to its streams resumed. */
  readonly toWelcomeMs: number;
  readonly outageMs: number;
  /** Tries it took, the new link's own included; those that closed without a welcome; those dropped for taking long. */
  readonly tries: number;
  readonly failedTries: number;
  readonly stalledTries: number;
  /** The new link's own try: from its start to the socket open, and to the welcome. */
  readonly openMs: number;
  readonly welcomeMs: number;
  /** Streams resumed on the new link, and how long that took after its welcome. */
  readonly streams: number;
  readonly resumeMs: number;
}

export interface CreateAppClientOptions {
  readonly url: string;
  /** The launch link's token; omitted for a paired device, which signs in with its key's cookie. */
  readonly token?: string;
  /**
   * A paired device's key, for a panel in another app's frame, which keeps no cookie of the app: its host keeps the key
   * and gives it back at each load (the embed protocol's `credential`). It goes in the socket's protocols
   * (`SOCKET_DEVICE_PROTOCOL_PREFIX`), never in the address.
   */
  readonly device?: string;
  readonly reconnect?: ReconnectOptions;
  /** Injected only for isomorphic tests; browsers use their standard WebSocket global. */
  readonly webSocketFactory?: WebSocketFactory;
  readonly timers?: TimerScheduler;
  /** Wall-clock milliseconds, for outage times; injected only for tests. Defaults to `Date.now`. */
  readonly clock?: () => number;
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
   * `cause` names why, for the outage report: "no-answer" when a check got none, "away" when the page was away longer
   * than the server keeps a silent link, else "asked".
   */
  reconnectNow(cause?: "no-answer" | "away" | "asked"): void;
  /**
   * A sign the network may work again (back online, the page shown again, the device awake): a reconnect that waits for
   * its next try goes at once, and a try that has taken more than 2 seconds without a welcome is replaced. Does nothing
   * while the link is open, or after the server refused this page.
   */
  nudge(): void;
  /** Called after each outage of a link that worked, once the new link's streams are resumed. */
  onOutage(listener: (report: OutageReport) => void): () => void;
  /**
   * Checks that the open link still answers before anything else goes on it, as when a phone wakes: a link can die
   * without closing, and what is sent into it is lost. Calls made while the check runs wait. An answer lets them go on
   * the link; no answer within `withinMs` drops the link for a new one, and they go on that once it is open. Resolves
   * true when the link answered, false when it did not or was not open. One check runs at a time.
   */
  checkLink(withinMs: number): Promise<boolean>;
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

/** The address with one more query parameter, before any fragment. */
function withParam(url: string, name: string, value: string): string {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : url.slice(hashIndex);
  const separator = beforeHash.includes("?")
    ? beforeHash.endsWith("?") || beforeHash.endsWith("&")
      ? ""
      : "&"
    : "?";
  return `${beforeHash}${separator}${name}=${encodeURIComponent(value)}${hash}`;
}
function isTextReader(value: unknown): value is { text(): Promise<unknown> } {
  if (typeof value !== "object" || value === null || !("text" in value)) return false;
  return typeof value.text === "function";
}

function defaultWebSocketFactory(url: string, protocols?: readonly string[]): WebSocketLike {
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket?: new (url: string, protocols?: string[]) => WebSocketLike;
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
  return protocols === undefined ? new WebSocketCtor(url) : new WebSocketCtor(url, [...protocols]);
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

/** A try older than this without a welcome is replaced when the network may be back (`nudge`). */
const NUDGE_REPLACES_AFTER_MS = 2_000;
/** The longest a try may take once earlier ones were dropped for taking long (`ReconnectOptions.tryTimeoutMs`). */
const LONGEST_TRY_MS = 32_000;

/** An outage of a link that worked, while the next one is being made. */
interface Outage {
  readonly start: number;
  readonly cause: OutageCause;
  readonly closeCode?: number;
  readonly closeReason?: string;
  tries: number;
  failedTries: number;
  stalledTries: number;
}

class AppClientImpl implements AppClient {
  private readonly options: CreateAppClientOptions;
  private readonly reconnect: Required<
    Pick<ReconnectOptions, "baseDelayMs" | "maxDelayMs" | "tryTimeoutMs">
  > &
    Pick<ReconnectOptions, "maxAttempts">;
  private readonly factory: WebSocketFactory;
  private readonly clock: () => number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<StreamKey, SubscriptionRecord>();
  private readonly stateListeners = new Set<(event: ConnectionStateEvent) => void>();
  private readonly resyncListeners = new Set<(event: ResyncEvent) => void>();
  private readonly outageListeners = new Set<(report: OutageReport) => void>();
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
  /** The link check that runs (`checkLink`): new calls wait until it settles. */
  private linkCheck: Promise<boolean> | undefined;
  /** The current try: when it started and when its socket opened; its time limit, and how long that is now. */
  private tryStartedAt: number | undefined;
  private tryOpenedAt: number | undefined;
  private tryTimer: TimerHandle | undefined;
  private tryLimitMs: number;
  /** The outage of a link that worked, from its loss until the next link's streams are resumed. */
  private outage: Outage | undefined;

  constructor(options: CreateAppClientOptions) {
    this.options = options;
    this.reconnect = {
      baseDelayMs: Math.max(0, options.reconnect?.baseDelayMs ?? 100),
      maxDelayMs: Math.max(0, options.reconnect?.maxDelayMs ?? 5000),
      maxAttempts: options.reconnect?.maxAttempts,
      tryTimeoutMs: Math.max(1, options.reconnect?.tryTimeoutMs ?? 8000),
    };
    this.tryLimitMs = this.reconnect.tryTimeoutMs;
    this.timers = options.timers ?? defaultTimers;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.clock = options.clock ?? Date.now;
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

  onOutage(listener: (report: OutageReport) => void): () => void {
    this.outageListeners.add(listener);
    return () => this.outageListeners.delete(listener);
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

  reconnectNow(cause: "no-answer" | "away" | "asked" = "asked"): void {
    if (this.disposed || this.terminal) return;
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout?.(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempt = 0;
    const socket = this.socket;
    if (socket !== undefined) {
      if (this.welcomeReceived) this.startOutage(cause);
      else if (this.outage !== undefined) this.outage.failedTries += 1;
      // Dropped as if it had closed: once it is not the current socket, its own late close is ignored.
      this.dropSocket(socket, 4000, "reconnect");
      this.rejectPending(appFailure("unavailable", "Connection to the app server closed", true));
      this.setConnectionState(this.everOpen ? "reconnecting" : "connecting");
    }
    this.connectNow();
  }

  nudge(): void {
    if (this.disposed || this.terminal || this._connectionState === "open") return;
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout?.(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.reconnectAttempt = 0;
      this.connectNow();
      return;
    }
    const socket = this.socket;
    const started = this.tryStartedAt;
    if (socket === undefined || this.welcomeReceived || started === undefined) return;
    if (this.clock() - started < NUDGE_REPLACES_AFTER_MS) return;
    if (this.outage !== undefined) this.outage.stalledTries += 1;
    this.dropSocket(socket, 4001, "replaced");
    this.reconnectAttempt = 0;
    this.connectNow();
  }

  checkLink(withinMs: number): Promise<boolean> {
    if (this.linkCheck !== undefined) return this.linkCheck;
    const socket = this.socket;
    if (this.disposed || this._connectionState !== "open" || !socket || !this.welcomeReceived)
      return Promise.resolve(false);
    const frame = CallFrame.parse({
      type: "call",
      id: this.nextRequestId(),
      port: AppPort.name,
      method: "health",
      args: {},
    });
    const deadline = new AbortController();
    // Without a timer (a scheduler that has none) the check waits for the answer or the link's close.
    const timer = this.timers.setTimeout?.(() => deadline.abort(), withinMs);
    const check = this.request(frame, AppPort.methods.health.result, { signal: deadline.signal })
      .then(
        () => true,
        (failure: unknown) => {
          // No answer in time: the link died without closing, so a new one takes its place.
          if (deadline.signal.aborted) {
            if (this.socket === socket) this.reconnectNow("no-answer");
            return false;
          }
          // The link closed meanwhile (its close starts the reconnect), or the client was disposed.
          if (this.disposed) return false;
          if (failure instanceof AppFailure && failure.appError.code === "unavailable")
            return false;
          // Any other answer, an error included, came over the link: it works.
          return true;
        },
      )
      .finally(() => {
        if (timer !== undefined) this.timers.clearTimeout?.(timer);
        this.linkCheck = undefined;
        // The calls that waited go now on a link that answered; after a reconnect they go once it is open.
        if (this._connectionState === "open" && this.socket && this.welcomeReceived)
          this.resolveOpenWaiters();
      });
    this.linkCheck = check;
    return check;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout?.(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearTryTimer();
    this.outage = undefined;
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
    let url = this.options.url;
    if (this.options.token !== undefined) url = withParam(url, "token", this.options.token);
    // Only a key of a key's shape: the browser throws on a protocol with any other character, which would retry for ever;
    // without it the server answers that the panel is not paired, and the panel pairs again.
    const device = this.options.device;
    const protocols =
      device === undefined || !DEVICE_KEY_SHAPE.test(device)
        ? undefined
        : [SOCKET_PROTOCOL, `${SOCKET_DEVICE_PROTOCOL_PREFIX}${device}`];
    let socket: WebSocketLike;
    try {
      socket = this.factory(url, protocols);
    } catch (error) {
      this.handleConnectionFailure(
        asAppFailure(error, appFailure("unavailable", "Connection to the app server failed", true)),
      );
      return;
    }
    const generation = ++this.socketGeneration;
    this.socket = socket;
    this.welcomeReceived = false;
    this.tryStartedAt = this.clock();
    this.tryOpenedAt = undefined;
    if (this.outage !== undefined) this.outage.tries += 1;
    this.clearTryTimer();
    // A try that is not welcomed in time is dropped, and the next goes at once: the time was already waited.
    this.tryTimer = this.timers.setTimeout?.(() => {
      this.tryTimer = undefined;
      if (!this.isCurrent(socket, generation) || this.welcomeReceived) return;
      this.tryLimitMs = Math.min(LONGEST_TRY_MS, this.tryLimitMs * 2);
      if (this.outage !== undefined) this.outage.stalledTries += 1;
      this.dropSocket(socket, 4001, "slow to open");
      this.rejectPending(appFailure("unavailable", "Connection to the app server timed out", true));
      this.scheduleReconnect(true);
    }, this.tryLimitMs);
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.tryOpenedAt = this.clock();
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
      const welcomed = this.welcomeReceived;
      this.socket = undefined;
      this.welcomeReceived = false;
      this.clearTryTimer();
      const code = closeCode(event);
      if (code === 4401 || code === 4403) {
        this.terminal = true;
        this.outage = undefined;
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
      if (welcomed) this.startOutage("closed", code, closeReason(event));
      else if (this.outage !== undefined) this.outage.failedTries += 1;
      this.rejectPending(appFailure("unavailable", "Connection to the app server closed", true));
      if (!this.disposed) this.scheduleReconnect();
    };
  }

  /** Lets a socket go as if it had closed: once it is not the current socket, its own late events are ignored. */
  private dropSocket(socket: WebSocketLike, code: number, reason: string): void {
    if (this.socket === socket) {
      this.socket = undefined;
      this.welcomeReceived = false;
    }
    this.clearTryTimer();
    try {
      socket.close(code, reason);
    } catch {
      // A socket that is already closed has nothing more to close.
    }
  }

  private clearTryTimer(): void {
    if (this.tryTimer === undefined) return;
    this.timers.clearTimeout?.(this.tryTimer);
    this.tryTimer = undefined;
  }

  /** A link that worked is lost: its outage starts, unless one already runs (a reconnect asked for meanwhile). */
  private startOutage(cause: OutageCause, closeCode?: number, closeReason?: string): void {
    if (this.outage !== undefined) return;
    this.outage = {
      start: this.clock(),
      cause,
      ...(closeCode === undefined ? {} : { closeCode }),
      ...(closeReason === undefined || closeReason === "" ? {} : { closeReason }),
      tries: 0,
      failedTries: 0,
      stalledTries: 0,
    };
  }

  /** The new link's streams are resumed: the outage is over, and its report goes to the listeners. */
  private endOutage(welcomedAt: number, streams: number): void {
    const outage = this.outage;
    this.outage = undefined;
    if (outage === undefined || this.outageListeners.size === 0) return;
    const now = this.clock();
    const started = this.tryStartedAt ?? welcomedAt;
    const report: OutageReport = {
      cause: outage.cause,
      ...(outage.closeCode === undefined ? {} : { closeCode: outage.closeCode }),
      ...(outage.closeReason === undefined ? {} : { closeReason: outage.closeReason }),
      toWelcomeMs: Math.max(0, welcomedAt - outage.start),
      outageMs: Math.max(0, now - outage.start),
      tries: outage.tries,
      failedTries: outage.failedTries,
      stalledTries: outage.stalledTries,
      openMs: Math.max(0, (this.tryOpenedAt ?? welcomedAt) - started),
      welcomeMs: Math.max(0, welcomedAt - started),
      streams,
      resumeMs: Math.max(0, now - welcomedAt),
    };
    for (const listener of this.outageListeners) this.notifyListener(listener, report);
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
    const welcomedAt = this.clock();
    const previousInstanceId = this._instanceId;
    const instanceChanged =
      previousInstanceId !== undefined && previousInstanceId !== frame.instanceId;
    this._instanceId = frame.instanceId;
    this.welcomeReceived = true;
    this.everOpen = true;
    this.reconnectAttempt = 0;
    this.clearTryTimer();
    this.tryLimitMs = this.reconnect.tryTimeoutMs;
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
    void this.resumeSubscriptions(instanceChanged).then(
      (streams) => {
        if (this.welcomeReceived) this.endOutage(welcomedAt, streams);
      },
      () => {
        // A close during resume is retried after the next welcome.
      },
    );
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

  /**
   * Subscribes the link's streams again after a welcome, all at once (one round trip for all of them, not one each):
   * how many it resumed.
   */
  private async resumeSubscriptions(instanceChanged: boolean): Promise<number> {
    const records = [...this.subscriptions.values()].filter(
      (record) => record.active && record.subscribed,
    );
    await Promise.all(
      records.map(async (record) => {
        if (!record.active || !record.subscribed || this.disposed || !this.welcomeReceived) return;
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
          if (!this.welcomeReceived || this.disposed) return;
          record.active = false;
          record.subscribed = false;
          if (this.subscriptions.get(record.stream) === record)
            this.subscriptions.delete(record.stream);
          record.holders.clear();
          this.emitResync({
            reason: "subscription-failed",
            stream: record.stream,
            error: asAppFailure(error, appFailure("internal", "Resubscribe failed", false))
              .appError,
          });
        }
      }),
    );
    return records.length;
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
    // While a link check runs (`checkLink`), a call waits for it, as for a link that is opening.
    if (
      this._connectionState === "open" &&
      this.socket &&
      this.welcomeReceived &&
      this.linkCheck === undefined
    )
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
        // 4002, not the protocol's 1002: a browser's close() takes only 1000 and 3000 to 4999 and throws for the rest,
        // which left each link the page gave up on open with the server until the page was reloaded.
        socket.close(4002, "invalid server frame");
      } catch {
        this.scheduleReconnect();
      }
    } else if (!this.disposed) {
      this.scheduleReconnect();
    }
  }

  /** The next try, after the backoff; `immediate` after a try that was dropped for taking long, whose wait is spent. */
  private scheduleReconnect(immediate = false): void {
    if (this.disposed || this.terminal || this.reconnectTimer !== undefined) return;
    const nextAttempt = this.reconnectAttempt + 1;
    if (this.reconnect.maxAttempts !== undefined && nextAttempt > this.reconnect.maxAttempts) {
      const error = appFailure("unavailable", "Could not reconnect to the app server", false);
      this.closedFailure = error;
      this.outage = undefined;
      this.setConnectionState("closed");
      this.rejectOpenWaiters(error);
      return;
    }
    this.reconnectAttempt = nextAttempt;
    this.setConnectionState(this.everOpen ? "reconnecting" : "connecting");
    const exponent = Math.max(0, nextAttempt - 1);
    const delay = immediate
      ? 0
      : Math.min(this.reconnect.maxDelayMs, this.reconnect.baseDelayMs * 2 ** exponent);
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

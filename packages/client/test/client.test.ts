import { describe, expect, test } from "bun:test";
import {
  APP_PROTOCOL,
  AppFailure,
  AppPort,
  type ClientFrame,
  definePort,
  EventFrame,
  parseClientFrame,
  type ServerFrame,
  serializeFrame,
  ThreadId,
} from "@omp-app/contracts";
import { z } from "zod";
import {
  type AppClient,
  createAppClient,
  type TimerScheduler,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src";

const EventPort = definePort({
  name: "A0.testEvents",
  methods: {},
  events: {
    updated: {
      payload: z.object({ value: z.string() }).strict(),
    },
  },
});

interface FakeConnection {
  readonly socket: FakeSocket;
  readonly url: string;
  hello: boolean;
  subscriptions: Set<string>;
  received: ClientFrame[];
}

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(private readonly onSend: (socket: FakeSocket, data: string) => void) {}

  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.onSend(this, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    if (!this.closed) this.onopen?.({});
  }

  deliver(frame: ServerFrame): void {
    if (!this.closed) this.onmessage?.({ data: serializeFrame(frame) });
  }
}

class FakeServer {
  readonly connections: FakeConnection[] = [];
  readonly cancelled = new Set<string>();
  readonly callIds: string[] = [];
  readonly subscribeAfterSeq: Array<number | undefined> = [];
  readonly resyncConflicts = new Set<number>();
  /** Connection indexes whose subscribe requests are refused with `not_found`. */
  readonly refusedSubscriptions = new Set<number>();
  instanceId = "instance-1";
  private pendingCalls = new Map<string, FakeSocket>();
  private readonly factory: WebSocketFactory = (url) => {
    const socket = new FakeSocket((current, data) => this.receive(current, data));
    const connection: FakeConnection = {
      socket,
      url,
      hello: false,
      subscriptions: new Set(),
      received: [],
    };
    this.connections.push(connection);
    queueMicrotask(() => socket.open());
    return socket;
  };

  connectFactory(): WebSocketFactory {
    return this.factory;
  }

  current(): FakeConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("no fake connection");
    return connection;
  }

  closeCurrent(): void {
    this.current().socket.close();
  }
  emit(stream: string, seq: number, value: unknown, connection = this.current()): void {
    const frame = EventFrame.parse({ type: "event", stream, seq, payload: value });
    connection.socket.deliver(frame);
  }

  private receive(socket: FakeSocket, text: string): void {
    const parsed = parseClientFrame(text);
    if (!parsed.ok) throw new Error("fake server received invalid client frame");
    const frame = parsed.value;
    const connection = this.connections.find((candidate) => candidate.socket === socket);
    if (!connection) throw new Error("unknown fake connection");
    connection.received.push(frame);
    if (frame.type === "hello") {
      expect(frame.protocols).toEqual([APP_PROTOCOL]);
      expect(frame.client.name).toBe("@omp-app/client");
      connection.hello = true;
      socket.deliver({
        type: "welcome",
        protocol: APP_PROTOCOL,
        instanceId: this.instanceId,
        serverVersion: "test-server",
        omp: null,
        capabilities: {},
      });
      return;
    }
    if (frame.type === "cancel") {
      this.cancelled.add(frame.id);
      this.pendingCalls.delete(frame.id);
      return;
    }
    if (frame.type === "subscribe") {
      this.subscribeAfterSeq.push(frame.afterSeq);
      if (this.refusedSubscriptions.has(this.connections.indexOf(connection))) {
        socket.deliver({
          type: "result",
          id: frame.id,
          ok: false,
          error: { code: "not_found", message: "thread closed", retryable: false },
        });
        return;
      }
      if (
        frame.afterSeq !== undefined &&
        this.resyncConflicts.has(this.connections.indexOf(connection))
      ) {
        socket.deliver({
          type: "result",
          id: frame.id,
          ok: false,
          error: { code: "conflict", message: "stale", retryable: false },
        });
        return;
      }
      connection.subscriptions.add(frame.stream);
      socket.deliver({ type: "result", id: frame.id, ok: true, value: { stream: frame.stream } });
      return;
    }
    if (frame.type === "unsubscribe") {
      connection.subscriptions.delete(frame.stream);
      socket.deliver({ type: "result", id: frame.id, ok: true, value: null });
      return;
    }
    this.callIds.push(frame.id);
    this.pendingCalls.set(frame.id, socket);
    if (frame.method === "health") {
      socket.deliver({ type: "result", id: frame.id, ok: true, value: { status: "ok" } });
    } else if (frame.method === "capabilities") {
      return;
    } else {
      socket.deliver({
        type: "result",
        id: frame.id,
        ok: false,
        error: { code: "omp_error", message: "test failure", retryable: false },
      });
    }
  }
}

const immediateTimers: TimerScheduler = {
  setTimeout(handler) {
    queueMicrotask(handler);
    return handler;
  },
  clearTimeout() {},
};

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
  throw new Error("condition did not become true");
}

async function openClient(server: FakeServer, url = "ws://127.0.0.1:4317/ws"): Promise<AppClient> {
  const client = createAppClient({
    url,
    token: "test-token",
    webSocketFactory: server.connectFactory(),
    timers: immediateTimers,
    reconnect: { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
  });
  await eventually(() => client.connectionState === "open");
  return client;
}

describe("createAppClient", () => {
  test("appends the upgrade token, sends C0 hello, and exposes typed port proxies", async () => {
    const server = new FakeServer();
    const client = await openClient(server, "ws://127.0.0.1:4317/ws?origin=test#fragment");
    expect(server.current().url).toBe(
      "ws://127.0.0.1:4317/ws?origin=test&token=test-token#fragment",
    );
    expect(server.current().hello).toBe(true);

    const app = client.port(AppPort);
    const failedCall = app.serverInfo({});
    await expect(failedCall).rejects.toBeInstanceOf(AppFailure);
    await expect(failedCall).rejects.toMatchObject({ appError: { code: "omp_error" } });
    expect(await app.health({})).toEqual({ status: "ok" });
    client.dispose();
  });

  test("aborting a call sends cancel and rejects with AppFailure cancelled", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const app = client.port(AppPort);
    const controller = new AbortController();
    const call = app.capabilities({}, { signal: controller.signal });
    await eventually(() => server.callIds.length === 1);
    controller.abort();
    await expect(call).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(server.cancelled.has(server.callIds[0] ?? "")).toBe(true);
    client.dispose();
  });

  test("resumes subscriptions after reconnect without duplicate events or gaps", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const threadId = ThreadId.parse("thread-1");
    const subscription = await client.subscribe(EventPort, "updated", { scope: threadId });
    const received: Array<{ value: string; seq: number }> = [];
    subscription.onEvent((payload, seq) => received.push({ value: payload.value, seq }));
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => received.length === 1);

    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    server.emit("A0.testEvents/updated/thread-1", 2, { value: "two" });
    await eventually(() => received.length === 2);
    expect(received).toEqual([
      { value: "one", seq: 1 },
      { value: "two", seq: 2 },
    ]);
    expect(server.subscribeAfterSeq).toContain(1);
    client.dispose();
  });

  test("stale resume emits resync and retries a fresh subscription", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const subscription = await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    const resync: string[] = [];
    client.onResync((event) => resync.push(event.reason));
    subscription.onEvent(() => {});
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => subscription.lastSeq === 1);
    server.resyncConflicts.add(1);
    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    expect(resync).toContain("stale-resume");
    expect(server.subscribeAfterSeq).toEqual([undefined, 1, undefined]);
    client.dispose();
  });

  test("a refused resume stops the subscription and reports it instead of going silent", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const subscription = await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    const failures: Array<{ reason: string; code: string | undefined }> = [];
    client.onResync((event) => failures.push({ reason: event.reason, code: event.error?.code }));
    const values: unknown[] = [];
    subscription.onEvent((payload) => values.push(payload));
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => subscription.lastSeq === 1);
    server.refusedSubscriptions.add(1);
    server.closeCurrent();
    await eventually(() => failures.some((failure) => failure.reason === "subscription-failed"));
    expect(failures).toContainEqual({ reason: "subscription-failed", code: "not_found" });
    server.emit("A0.testEvents/updated/thread-1", 2, { value: "two" });
    // Frames are handled in order, so a reply to a later call proves the event was processed.
    expect(await client.port(AppPort).health({})).toEqual({ status: "ok" });
    expect(values).toEqual([{ value: "one" }]);
    client.dispose();
  });
  test("instance changes emit resync before fresh subscription", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const subscription = await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    const reasons: string[] = [];
    client.onResync((event) => reasons.push(event.reason));
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => subscription.lastSeq === 1);
    server.instanceId = "instance-2";
    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    expect(reasons).toContain("instance-changed");
    expect(server.subscribeAfterSeq).toEqual([undefined, undefined]);
    client.dispose();
  });

  test("connection state listeners observe reconnecting and disposal closes the client", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const states: string[] = [];
    client.onConnectionState((event) => states.push(event.state));
    server.closeCurrent();
    await eventually(() => states.includes("reconnecting"));
    await eventually(() => states.filter((state) => state === "open").length >= 2);
    client.dispose();
    expect(client.connectionState).toBe("closed");
    expect(states).toContain("reconnecting");
  });
});

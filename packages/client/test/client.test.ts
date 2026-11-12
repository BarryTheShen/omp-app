import { describe, expect, test } from "bun:test";
import {
  APP_PROTOCOL,
  AppFailure,
  AppPort,
  type ClientFrame,
  definePort,
  EventFrame,
  parseClientFrame,
  type RequestId,
  type ServerFrame,
  SOCKET_DEVICE_PROTOCOL_PREFIX,
  SOCKET_PROTOCOL,
  serializeFrame,
  ThreadId,
} from "@omp-app/contracts";
import { z } from "zod";
import {
  type AppClient,
  type ConnectionStateEvent,
  createAppClient,
  type OutageReport,
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

  /** As a browser's WebSocket: a code other than 1000 or 3000 to 4999 throws, and the socket stays open. */
  close(code?: number): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw Object.assign(new Error(`close code ${code} is not allowed`), {
        name: "InvalidAccessError",
      });
    }
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
  /** Events the fake server replays to a subscription that asks for a cursor, sent before its result. */
  readonly replay: ServerFrame[] = [];
  readonly subscribeAfterSeq: Array<number | undefined> = [];
  /** The streams the client asked the server to stop, in order. */
  readonly unsubscribed: string[] = [];
  readonly resyncConflicts = new Set<number>();
  /** Connection indexes whose subscribe requests are refused with `not_found`. */
  readonly refusedSubscriptions = new Set<number>();
  /** Subscribe requests held unanswered, oldest first, until `answerHeldSubscribe` answers the first of them. */
  readonly heldSubscribes: Array<{
    socket: FakeSocket;
    id: z.infer<typeof RequestId>;
    stream: string;
  }> = [];
  /** Holds the next subscribe request instead of answering it. */
  holdNextSubscribe = false;
  /** Holds the next health call instead of answering it, until `answerHeldHealth`. */
  holdNextHealth = false;
  private heldHealth: { socket: FakeSocket; id: z.infer<typeof RequestId> } | undefined;
  /** Connections that take frames and answer nothing, as a link that died without closing. */
  readonly silent = new Set<FakeConnection>();
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

  /** Answers the oldest held subscribe request: refused with `not_found`, or accepted. */
  answerHeldSubscribe(refuse: boolean): void {
    const held = this.heldSubscribes.shift();
    if (!held) throw new Error("no subscribe request is held");
    if (refuse) {
      held.socket.deliver({
        type: "result",
        id: held.id,
        ok: false,
        error: { code: "not_found", message: "thread closed", retryable: false },
      });
      return;
    }
    held.socket.deliver({ type: "result", id: held.id, ok: true, value: { stream: held.stream } });
  }

  /** Answers the held health call: the link works. */
  answerHeldHealth(): void {
    const held = this.heldHealth;
    if (!held) throw new Error("no health call is held");
    this.heldHealth = undefined;
    held.socket.deliver({ type: "result", id: held.id, ok: true, value: { status: "ok" } });
  }

  private receive(socket: FakeSocket, text: string): void {
    const parsed = parseClientFrame(text);
    if (!parsed.ok) throw new Error("fake server received invalid client frame");
    const frame = parsed.value;
    const connection = this.connections.find((candidate) => candidate.socket === socket);
    if (!connection) throw new Error("unknown fake connection");
    connection.received.push(frame);
    if (this.silent.has(connection)) return;
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
      if (this.holdNextSubscribe) {
        this.holdNextSubscribe = false;
        this.heldSubscribes.push({ socket, id: frame.id, stream: frame.stream });
        return;
      }
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
      if (frame.afterSeq !== undefined) {
        for (const event of this.replay) {
          if (
            event.type === "event" &&
            event.stream === frame.stream &&
            event.seq > frame.afterSeq
          ) {
            socket.deliver(event);
          }
        }
      }
      connection.subscriptions.add(frame.stream);
      socket.deliver({ type: "result", id: frame.id, ok: true, value: { stream: frame.stream } });
      return;
    }
    if (frame.type === "unsubscribe") {
      this.unsubscribed.push(frame.stream);
      connection.subscriptions.delete(frame.stream);
      socket.deliver({ type: "result", id: frame.id, ok: true, value: null });
      return;
    }
    this.callIds.push(frame.id);
    this.pendingCalls.set(frame.id, socket);
    if (frame.method === "health") {
      if (this.holdNextHealth) {
        this.holdNextHealth = false;
        this.heldHealth = { socket, id: frame.id };
        return;
      }
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

/** How a call ends: `settled` once it has, with the error it rejected with (undefined when it resolved). */
interface Settlement {
  settled: boolean;
  error?: unknown;
}

/** Follows a call to its end. Read it after `eventually`, which gives a call that fails at once a few turns to settle. */
function settle(call: Promise<unknown>): Settlement {
  const outcome: Settlement = { settled: false };
  call.then(
    () => {
      outcome.settled = true;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return outcome;
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

  /** A panel's client, recording the protocols each of its sockets offered. */
  const panelClient = (server: FakeServer, device: string) => {
    const factory = server.connectFactory();
    const offered: (readonly string[] | undefined)[] = [];
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      device,
      webSocketFactory: (url, protocols) => {
        offered.push(protocols);
        return factory(url);
      },
      timers: immediateTimers,
      reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    return { client, offered };
  };

  test("a panel's key goes in the socket's protocols, at every connection, never in the address", async () => {
    const server = new FakeServer();
    const key = "aB3_-".repeat(8).concat("xyz");
    const { client, offered } = panelClient(server, key);
    await eventually(() => client.connectionState === "open");
    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    expect(server.connections.map((connection) => connection.url)).toEqual([
      "ws://127.0.0.1:4317/ws",
      "ws://127.0.0.1:4317/ws",
    ]);
    const panel = [SOCKET_PROTOCOL, `${SOCKET_DEVICE_PROTOCOL_PREFIX}${key}`];
    expect(offered).toEqual([panel, panel]);
    client.dispose();
  });

  test("a host's key of no key's shape is not offered, which a browser would refuse, so the server can say not paired", async () => {
    const server = new FakeServer();
    const { client, offered } = panelClient(server, "a key, with spaces");
    await eventually(() => client.connectionState === "open");
    expect(offered).toEqual([undefined]);
    expect(server.current().url).toBe("ws://127.0.0.1:4317/ws");
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

  test("an onEvent listener gets the events the server replays before it acknowledges the subscription", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    server.replay.push(
      EventFrame.parse({
        type: "event",
        stream: "A0.testEvents/updated/thread-1",
        seq: 1,
        payload: { value: "one" },
      }),
      EventFrame.parse({
        type: "event",
        stream: "A0.testEvents/updated/thread-1",
        seq: 2,
        payload: { value: "two" },
      }),
    );
    const received: Array<{ value: string; seq: number }> = [];
    const subscription = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      afterSeq: 0,
      onEvent: (payload, seq) => received.push({ value: payload.value, seq }),
    });
    expect(received).toEqual([
      { value: "one", seq: 1 },
      { value: "two", seq: 2 },
    ]);
    expect(subscription.lastSeq).toBe(2);
    expect(server.subscribeAfterSeq).toEqual([0]);
    client.dispose();
  });

  test("an explicit afterSeq of zero is the cursor, and a reconnect before any event sends it again", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    await client.subscribe(EventPort, "updated", { scope: "thread-1", afterSeq: 0 });
    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    await eventually(() => server.subscribeAfterSeq.length === 2);
    expect(server.subscribeAfterSeq).toEqual([0, 0]);
    client.dispose();
  });

  test("a subscription without a cursor resumes live until it has seen an event", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    await eventually(() => server.subscribeAfterSeq.length === 2);
    expect(server.subscribeAfterSeq).toEqual([undefined, undefined]);
    client.dispose();
  });

  test("a second subscribe to a stream already subscribed takes its onEvent listener, with no second request", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const first = await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    const received: Array<{ value: string; seq: number }> = [];
    const second = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (payload, seq) => received.push({ value: payload.value, seq }),
    });
    expect(second.stream).toBe(first.stream);
    expect(server.subscribeAfterSeq).toEqual([undefined]);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => received.length === 1);
    expect(received).toEqual([{ value: "one", seq: 1 }]);
    client.dispose();
  });

  test("a first subscribe the server cannot replay from zero is live-only, with no resync", async () => {
    const server = new FakeServer();
    server.resyncConflicts.add(0);
    const client = await openClient(server);
    const resyncs: string[] = [];
    client.onResync((event) => resyncs.push(event.reason));
    const seqs: number[] = [];
    const subscription = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      afterSeq: 0,
      onEvent: (_payload, seq) => seqs.push(seq),
    });
    expect(server.subscribeAfterSeq).toEqual([0, undefined]);
    expect(resyncs).toEqual([]);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => seqs.length === 1);
    expect(subscription.lastSeq).toBe(1);
    client.dispose();
  });

  test("a refused subscribe leaves no record: its retry sends a new request", async () => {
    const server = new FakeServer();
    server.refusedSubscriptions.add(0);
    const client = await openClient(server);
    await expect(
      client.subscribe(EventPort, "updated", { scope: "thread-1" }),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    server.refusedSubscriptions.delete(0);
    const seqs: number[] = [];
    const subscription = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => seqs.push(seq),
    });
    expect(server.subscribeAfterSeq).toEqual([undefined, undefined]);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => seqs.length === 1);
    expect(subscription.lastSeq).toBe(1);
    client.dispose();
  });

  test("a refused resubscribe leaves no record: a later subscribe sends a new request and its events arrive", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const failures: string[] = [];
    client.onResync((event) => {
      if (event.reason === "subscription-failed") failures.push(event.reason);
    });
    await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    server.refusedSubscriptions.add(1);
    server.closeCurrent();
    await eventually(() => failures.length === 1);
    // The server takes subscribes again: a later subscribe must make a new record, not join the refused one.
    server.refusedSubscriptions.delete(1);
    const seqs: number[] = [];
    const later = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => seqs.push(seq),
    });
    expect(server.subscribeAfterSeq).toHaveLength(3);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => seqs.length === 1);
    expect(later.lastSeq).toBe(1);
    client.dispose();
  });

  test("a refused first subscribe leaves no record: a later subscribe makes a fresh one and gets its events", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    // The first subscribe's request is held, so its record is still pending while the rest of the sequence runs.
    server.holdNextSubscribe = true;
    const first = client
      .subscribe(EventPort, "updated", { scope: "thread-1" })
      .catch((error: unknown) => error);
    await eventually(() => server.heldSubscribes.length === 1);
    // The server refuses the first request: its record leaves the map, so the next subscribe asks for a new one.
    server.answerHeldSubscribe(true);
    expect(await first).toMatchObject({ appError: { code: "not_found" } });
    const seqs: number[] = [];
    const later = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => seqs.push(seq),
    });
    expect(server.subscribeAfterSeq).toHaveLength(2);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => seqs.length === 1);
    expect(later.lastSeq).toBe(1);
    client.dispose();
  });

  test("letting go of one hold on a shared stream leaves the stream to the others, and the server hears once", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const received: number[] = [];
    const first = await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    const second = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => received.push(seq),
    });
    await first.unsubscribe();
    expect(server.unsubscribed).toEqual([]);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => received.length === 1);
    expect(second.lastSeq).toBe(1);
    await second.unsubscribe();
    expect(server.unsubscribed).toEqual(["A0.testEvents/updated/thread-1"]);
    client.dispose();
  });

  test("a listener goes with the hold that attached it; the other hold's listener keeps receiving", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const kept: number[] = [];
    const dropped: number[] = [];
    const first = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => kept.push(seq),
    });
    const second = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => dropped.push(seq),
    });
    await second.unsubscribe();
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => kept.length === 1);
    expect(dropped).toEqual([]);
    expect(first.stream).toBe(second.stream);
    client.dispose();
  });

  test("a listener two holds attached gets each event once, and keeps it while either hold is there", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const seen: number[] = [];
    const listener = (_payload: { readonly value: string }, seq: number) => {
      seen.push(seq);
    };
    const first = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: listener,
    });
    await client.subscribe(EventPort, "updated", { scope: "thread-1", onEvent: listener });
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([1]);
    await first.unsubscribe();
    server.emit("A0.testEvents/updated/thread-1", 2, { value: "two" });
    await eventually(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
    client.dispose();
  });

  test("a listener attached twice gets each event once, and the detach its onEvent returns removes it", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const first: number[] = [];
    await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => first.push(seq),
    });
    const second: number[] = [];
    const onSecond = (_payload: { readonly value: string }, seq: number) => second.push(seq);
    const subscription = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: onSecond,
    });
    const detach = subscription.onEvent(onSecond);
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => first.length === 1);
    expect(second).toEqual([1]);
    detach();
    server.emit("A0.testEvents/updated/thread-1", 2, { value: "two" });
    await eventually(() => first.length === 2);
    expect(second).toEqual([1]);
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

  test("reconnectNow starts a reconnect that waits for its next try at once", async () => {
    const server = new FakeServer();
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      token: "test-token",
      webSocketFactory: server.connectFactory(),
      // The next try waits a minute: only reconnectNow can start it within the test.
      timers: { setTimeout: (handler) => handler, clearTimeout() {} },
      reconnect: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await eventually(() => client.connectionState === "open");
    server.closeCurrent();
    await eventually(() => client.connectionState === "reconnecting");
    expect(server.connections).toHaveLength(1);
    client.reconnectNow();
    await eventually(() => client.connectionState === "open");
    expect(server.connections).toHaveLength(2);
    client.dispose();
  });

  test("reconnectNow drops an open link for a new one, and the old link's close starts nothing more", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const states: string[] = [];
    client.onConnectionState((event) => states.push(event.state));
    const first = server.current().socket;
    const waiting = settle(client.port(AppPort).capabilities({}));
    await eventually(() => server.callIds.length === 1);
    client.reconnectNow();
    expect(first.closed).toBe(true);
    await eventually(() => client.connectionState === "open" && server.connections.length === 2);
    await eventually(() => waiting.settled);
    expect(waiting.error).toMatchObject({ appError: { code: "unavailable" } });
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(server.connections).toHaveLength(2);
    expect(states).toEqual(["open", "reconnecting", "open"]);
    client.dispose();
  });

  test("reconnectNow leaves a page the server refused closed", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    server.current().socket.onclose?.({ code: 4401, reason: "not paired" });
    await eventually(() => client.connectionState === "closed");
    client.reconnectNow();
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(server.connections).toHaveLength(1);
    expect(client.connectionState).toBe("closed");
    client.dispose();
  });

  /** A client whose timers run only when the test says (`fire`), open on `server`. */
  async function openWithTimers(
    server: FakeServer,
  ): Promise<{ client: AppClient; fire: () => void }> {
    const due: Array<() => void> = [];
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      token: "test-token",
      webSocketFactory: server.connectFactory(),
      timers: {
        setTimeout: (handler) => {
          due.push(handler);
          return handler;
        },
        clearTimeout: (handle) => {
          const at = due.indexOf(handle as () => void);
          if (at >= 0) due.splice(at, 1);
        },
      },
      reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    await eventually(() => client.connectionState === "open");
    return { client, fire: () => due.splice(0).forEach((handler) => handler()) };
  }

  const calls = (connection: FakeConnection, method: string) =>
    connection.received.filter((frame) => frame.type === "call" && frame.method === method);

  test("calls made while a link check runs wait for it, and go on the link once it answers", async () => {
    const server = new FakeServer();
    const { client } = await openWithTimers(server);
    server.holdNextHealth = true;
    const checked = client.checkLink(4000);
    await eventually(() => calls(server.current(), "health").length === 1);
    const info = settle(client.port(AppPort).serverInfo({}));
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(calls(server.current(), "serverInfo")).toHaveLength(0);

    server.answerHeldHealth();
    expect(await checked).toBe(true);
    await eventually(() => info.settled);
    expect(calls(server.current(), "serverInfo")).toHaveLength(1);
    expect(server.connections).toHaveLength(1);
    client.dispose();
  });

  test("a link check with no answer in time drops the link, and the calls that waited go on the new one", async () => {
    const server = new FakeServer();
    const { client, fire } = await openWithTimers(server);
    const dead = server.current();
    server.silent.add(dead);
    const checked = client.checkLink(4000);
    const info = settle(client.port(AppPort).serverInfo({}));
    await eventually(() => calls(dead, "health").length === 1);
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    // Only the check went into the dead link.
    expect(calls(dead, "serverInfo")).toHaveLength(0);

    fire();
    expect(await checked).toBe(false);
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    await eventually(() => info.settled);
    expect(calls(server.current(), "serverInfo")).toHaveLength(1);
    expect(calls(dead, "serverInfo")).toHaveLength(0);
    client.dispose();
  });

  test("after a drop, tries that fail still say reconnecting until the link is back", async () => {
    const server = new FakeServer();
    const factory = server.connectFactory();
    let failures = 0;
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      token: "test-token",
      webSocketFactory: (url) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("refused");
        }
        return factory(url);
      },
      timers: immediateTimers,
      reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    await eventually(() => client.connectionState === "open");
    const states: string[] = [];
    client.onConnectionState((event) => states.push(event.state));
    failures = 2;
    server.closeCurrent();
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    expect(failures).toBe(0);
    expect(states).toEqual(["open", "reconnecting", "open"]);
    client.dispose();
  });

  test("treats unauthorized close codes as terminal permission failures", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const states: ConnectionStateEvent[] = [];
    client.onConnectionState((event) => states.push(event));
    server.current().socket.onclose?.({ code: 4401, reason: "invalid token" });
    await eventually(() => client.connectionState === "closed");
    expect(server.connections).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({
      state: "closed",
      error: { code: "permission", message: "Launch token is not valid", retryable: false },
      refusal: "invalid",
    });
    client.dispose();
  });
  test("says a launch link an earlier start printed has expired, not that it is not valid", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const states: ConnectionStateEvent[] = [];
    client.onConnectionState((event) => states.push(event));
    server.current().socket.onclose?.({ code: 4401, reason: "expired token" });
    await eventually(() => client.connectionState === "closed");
    expect(states.at(-1)).toMatchObject({
      state: "closed",
      error: { code: "permission", message: "Launch link has expired", retryable: false },
      refusal: "expired",
    });
    client.dispose();
  });

  test("a listener that lets go of its hold during an event stops that hold's other listeners for it", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const seen: string[] = [];
    const held = await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: () => {
        seen.push("releases");
        void held.unsubscribe();
      },
    });
    held.onEvent(() => {
      seen.push("other");
    });
    const kept: number[] = [];
    await client.subscribe(EventPort, "updated", {
      scope: "thread-1",
      onEvent: (_payload, seq) => kept.push(seq),
    });
    server.emit("A0.testEvents/updated/thread-1", 1, { value: "one" });
    await eventually(() => kept.length === 1);
    expect(seen).toEqual(["releases"]);
    client.dispose();
  });

  test("a frame it cannot read closes that link, as a browser lets it, and a new one opens", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const first = server.current().socket;
    first.onmessage?.({ data: "{ not a frame" });
    await eventually(() => server.connections.length === 2 && client.connectionState === "open");
    // Left open, each link the page gives up on stays with the server until the page is reloaded.
    expect(first.closed).toBe(true);
  });

  test("a call made after the server refused the token fails with that refusal instead of waiting", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    server.current().socket.onclose?.({ code: 4401, reason: "invalid token" });
    await eventually(() => client.connectionState === "closed");
    const app = client.port(AppPort);
    const call = settle(app.capabilities({}));
    await eventually(() => call.settled);
    expect(call.error).toMatchObject({
      appError: { code: "permission", message: "Launch token is not valid", retryable: false },
    });
    client.dispose();
  });

  test("a disallowed page address closes the connection as an origin refusal, and later subscribes fail with it", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    const states: ConnectionStateEvent[] = [];
    client.onConnectionState((event) => states.push(event));
    await client.subscribe(EventPort, "updated", { scope: "thread-1" });
    server.current().socket.onclose?.({ code: 4403, reason: "origin not allowed" });
    await eventually(() => client.connectionState === "closed");
    expect(states.at(-1)).toMatchObject({
      state: "closed",
      error: {
        code: "permission",
        message: "This page address is not allowed to reach omp-app",
        retryable: false,
      },
      refusal: "origin",
    });
    const sameStream = settle(client.subscribe(EventPort, "updated", { scope: "thread-1" }));
    await eventually(() => sameStream.settled);
    expect(sameStream.error).toMatchObject({
      appError: {
        code: "permission",
        message: "This page address is not allowed to reach omp-app",
        retryable: false,
      },
    });
    const otherStream = settle(client.subscribe(EventPort, "updated", { scope: "thread-2" }));
    await eventually(() => otherStream.settled);
    expect(otherStream.error).toMatchObject({ appError: { code: "permission", retryable: false } });
    client.dispose();
  });

  test("after the reconnect budget is used up, a call fails at once instead of waiting", async () => {
    // Every connection closes before the server's welcome, so each attempt fails.
    const refusing: WebSocketFactory = () => {
      const socket = new FakeSocket(() => {});
      queueMicrotask(() => socket.close());
      return socket;
    };
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      token: "test-token",
      webSocketFactory: refusing,
      timers: immediateTimers,
      reconnect: { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 },
    });
    await eventually(() => client.connectionState === "closed");
    const call = settle(client.port(AppPort).capabilities({}));
    await eventually(() => call.settled);
    expect(call.error).toMatchObject({
      appError: { code: "unavailable", retryable: false },
    });
    client.dispose();
  });

  /** Lets queued microtasks run. */
  async function turns(count: number): Promise<void> {
    for (let turn = 0; turn < count; turn += 1)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
  }

  /**
   * A client on `server` whose timers run when the test says (`fire`), on the test's clock; `stallNext()` makes the next
   * connection one that takes frames and never answers, as a handshake that stalls.
   */
  async function openStallable(server: FakeServer): Promise<{
    client: AppClient;
    fire: () => void;
    stallNext: () => void;
    clock: { now: number };
  }> {
    const due: Array<() => void> = [];
    const clock = { now: 1_000 };
    const factory = server.connectFactory();
    let stall = false;
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      token: "test-token",
      webSocketFactory: (url) => {
        const socket = factory(url);
        if (stall) {
          stall = false;
          server.silent.add(server.current());
        }
        return socket;
      },
      timers: {
        setTimeout: (handler) => {
          due.push(handler);
          return handler;
        },
        clearTimeout: (handle) => {
          const at = due.indexOf(handle as () => void);
          if (at >= 0) due.splice(at, 1);
        },
      },
      clock: () => clock.now,
      reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    await eventually(() => client.connectionState === "open");
    return {
      client,
      fire: () => due.splice(0).forEach((handler) => handler()),
      stallNext: () => {
        stall = true;
      },
      clock,
    };
  }

  test("a try that is not welcomed in time is dropped, and the next one goes at once", async () => {
    const server = new FakeServer();
    const { client, fire, stallNext } = await openStallable(server);
    stallNext();
    server.closeCurrent();
    fire(); // the reconnect's wait: the second connection opens and never answers
    await eventually(() => server.connections.length === 2);
    await turns(20);
    expect(client.connectionState).toBe("reconnecting");
    fire(); // the try's time limit: dropped, and the next try is due at once
    expect(server.connections[1]?.socket.closed).toBe(true);
    fire();
    await eventually(() => server.connections.length === 3 && client.connectionState === "open");
    client.dispose();
  });

  test("nudge sends a reconnect that waits for its next try at once, and leaves an open link alone", async () => {
    const server = new FakeServer();
    const client = createAppClient({
      url: "ws://127.0.0.1:4317/ws",
      token: "test-token",
      webSocketFactory: server.connectFactory(),
      // The next try waits a minute: only a nudge can start it within the test.
      timers: { setTimeout: (handler) => handler, clearTimeout() {} },
      reconnect: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await eventually(() => client.connectionState === "open");
    client.nudge();
    await turns(20);
    expect(server.connections).toHaveLength(1);
    server.closeCurrent();
    await eventually(() => client.connectionState === "reconnecting");
    client.nudge();
    await eventually(() => client.connectionState === "open");
    expect(server.connections).toHaveLength(2);
    client.dispose();
  });

  test("nudge replaces a try that has gone 2 seconds without a welcome, and not a younger one", async () => {
    const server = new FakeServer();
    const { client, fire, stallNext, clock } = await openStallable(server);
    stallNext();
    server.closeCurrent();
    fire();
    await eventually(() => server.connections.length === 2);
    clock.now += 1_000;
    client.nudge();
    await turns(20);
    expect(server.connections).toHaveLength(2);
    clock.now += 1_500;
    client.nudge();
    expect(server.connections[1]?.socket.closed).toBe(true);
    await eventually(() => server.connections.length === 3 && client.connectionState === "open");
    client.dispose();
  });

  test("reports an outage once the new link's streams are resumed: why, how long, and how many tries", async () => {
    const server = new FakeServer();
    const { client, fire, clock } = await openStallable(server);
    const one = client.subscribe(EventPort, "updated", { scope: ThreadId.parse("thread-1") });
    const two = client.subscribe(EventPort, "updated", { scope: ThreadId.parse("thread-2") });
    await Promise.all([one, two]);
    const reports: OutageReport[] = [];
    client.onOutage((report) => reports.push(report));
    server.current().socket.onclose?.({ code: 1006, reason: "" });
    clock.now += 250;
    fire();
    await eventually(() => reports.length === 1);
    expect(reports[0]).toEqual({
      cause: "closed",
      closeCode: 1006,
      toWelcomeMs: 250,
      outageMs: 250,
      tries: 1,
      failedTries: 0,
      stalledTries: 0,
      openMs: 0,
      welcomeMs: 0,
      streams: 2,
      resumeMs: 0,
    });
    // A link a check found dead says so.
    client.reconnectNow("no-answer");
    await eventually(() => reports.length === 2);
    expect(reports[1]).toMatchObject({ cause: "no-answer", tries: 1 });
    client.dispose();
  });

  test("after a reconnect, every stream is subscribed again at once, not one after another", async () => {
    const server = new FakeServer();
    const client = await openClient(server);
    await client.subscribe(EventPort, "updated", { scope: ThreadId.parse("thread-1") });
    await client.subscribe(EventPort, "updated", { scope: ThreadId.parse("thread-2") });
    server.holdNextSubscribe = true;
    server.closeCurrent();
    await eventually(
      () =>
        server.connections.length === 2 &&
        server.current().received.filter((frame) => frame.type === "subscribe").length === 2,
    );
    // The first is still unanswered: the second went without waiting for it.
    expect(server.heldSubscribes).toHaveLength(1);
    server.answerHeldSubscribe(false);
    client.dispose();
  });
});

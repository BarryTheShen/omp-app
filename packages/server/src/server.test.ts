import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@omp-app/contracts";

import {
  AppFailure,
  CapabilityMap,
  definePort,
  serializeFrame,
  streamKey,
  WelcomeFrame,
} from "@omp-app/contracts";
import { z } from "zod";

import { Dispatcher, type DispatcherSocket } from "./dispatcher";
import {
  createPortRegistry,
  type PortHandlerContext,
  type PortRegistration,
} from "./registry/ports";
import { EventReplayHub } from "./replay";
import { authorizeWebSocketUpgrade, createAppServer } from "./server";

const TestPort = definePort({
  name: "A0.test",
  methods: {
    echo: {
      args: z.object({ value: z.string().min(1) }).strict(),
      result: z.object({ echoed: z.string() }).strict(),
    },
    fail: {
      args: z.null(),
      result: z.null(),
    },
    internal: {
      args: z.null(),
      result: z.null(),
    },
    invalidResult: {
      args: z.null(),
      result: z.object({ ok: z.literal(true) }).strict(),
    },
    wait: {
      args: z.null(),
      result: z.null(),
    },
  },
  events: {
    changed: {
      payload: z.object({ value: z.string() }).strict(),
    },
  },
});

type TestSocket = DispatcherSocket & {
  readonly frames: ServerFrame[];
  readonly closed: { code: number; reason: string }[];
};

function createSocket(id: string): TestSocket {
  const frames: ServerFrame[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    id,
    frames,
    closed,
    send(frame) {
      frames.push(frame);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
  };
}

function createWelcome() {
  return WelcomeFrame.parse({
    type: "welcome",
    protocol: "omp-app/1",
    instanceId: "instance-1",
    serverVersion: "test",
    omp: null,
    capabilities: CapabilityMap.parse({}),
  });
}

function registration(): PortRegistration {
  const handlers = {
    echo: async (args: unknown) => ({
      echoed: TestPort.methods.echo.args.parse(args).value,
    }),
    fail: async () => {
      throw new AppFailure({ code: "permission", message: "blocked", retryable: false });
    },
    internal: async () => {
      throw new Error("secret should not cross the boundary");
    },
    invalidResult: async () => 42,
    wait: async (_args: unknown, context: PortHandlerContext) =>
      await new Promise<null>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  return { port: TestPort, handlers };
}

function createDispatcher(limit = 2): { dispatcher: Dispatcher } {
  const registry = createPortRegistry([registration()]);
  const replay = new EventReplayHub(limit);
  return {
    dispatcher: new Dispatcher({ registry, replay, welcome: createWelcome() }),
  };
}

function hello(session: { receive(frame: string): void }): void {
  session.receive(
    serializeFrame({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "test-client", version: "1.0.0" },
    }),
  );
}

function resultFrames(socket: TestSocket): Extract<ServerFrame, { type: "result" }>[] {
  return socket.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result",
  );
}

function eventFrames(socket: TestSocket): Extract<ServerFrame, { type: "event" }>[] {
  return socket.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "event" }> => frame.type === "event",
  );
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("A0.6 dispatcher", () => {
  test("welcomes, validates args/results and maps AppFailure or unknown errors", async () => {
    const { dispatcher } = createDispatcher();
    const socket = createSocket("connection-1");
    const session = dispatcher.open(socket);
    hello(session);
    expect(socket.frames[0]).toMatchObject({ type: "welcome", instanceId: "instance-1" });

    session.receive(
      JSON.stringify({
        type: "call",
        id: "echo-1",
        port: "A0.test",
        method: "echo",
        args: { value: "hello" },
      }),
    );
    session.receive(
      JSON.stringify({
        type: "call",
        id: "bad-args",
        port: "A0.test",
        method: "echo",
        args: {},
      }),
    );
    session.receive(
      JSON.stringify({
        type: "call",
        id: "app-failure",
        port: "A0.test",
        method: "fail",
        args: null,
      }),
    );
    session.receive(
      JSON.stringify({
        type: "call",
        id: "internal",
        port: "A0.test",
        method: "internal",
        args: null,
      }),
    );
    session.receive(
      JSON.stringify({
        type: "call",
        id: "invalid-result",
        port: "A0.test",
        method: "invalidResult",
        args: null,
      }),
    );
    await settle();

    const results = resultFrames(socket);
    expect(results.find((frame) => frame.id === "echo-1")).toMatchObject({
      type: "result",
      id: "echo-1",
      ok: true,
      value: { echoed: "hello" },
    });
    expect(results.find((frame) => frame.id === "bad-args")).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
    expect(results.find((frame) => frame.id === "app-failure")).toMatchObject({
      ok: false,
      error: { code: "permission", message: "blocked" },
    });
    const internal = results.find((frame) => frame.id === "internal");
    expect(internal).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(internal)).not.toContain("secret should not cross the boundary");
    expect(results.find((frame) => frame.id === "invalid-result")).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  });

  test("cancels a running handler through its AbortSignal", async () => {
    const { dispatcher } = createDispatcher();
    const socket = createSocket("connection-2");
    const session = dispatcher.open(socket);
    hello(session);
    session.receive(
      JSON.stringify({ type: "call", id: "wait-1", port: "A0.test", method: "wait", args: null }),
    );
    session.receive(JSON.stringify({ type: "cancel", id: "wait-1" }));
    await settle();

    expect(resultFrames(socket).find((frame) => frame.id === "wait-1")).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("replays retained events and reports stale cursors as conflict", () => {
    const { dispatcher } = createDispatcher(2);
    const stream = streamKey(TestPort.name, "changed", "thread-1");
    const firstSocket = createSocket("connection-3");
    const first = dispatcher.open(firstSocket);
    hello(first);
    first.receive(JSON.stringify({ type: "subscribe", id: "sub-1", stream }));
    dispatcher.publish(stream, { value: "one" });
    dispatcher.publish(stream, { value: "two" });
    dispatcher.publish(stream, { value: "three" });
    expect(eventFrames(firstSocket).map((frame) => frame.seq)).toEqual([1, 2, 3]);

    const resumedSocket = createSocket("connection-4");
    const resumed = dispatcher.open(resumedSocket);
    hello(resumed);
    resumed.receive(JSON.stringify({ type: "subscribe", id: "sub-2", stream, afterSeq: 1 }));
    expect(eventFrames(resumedSocket).map((frame) => frame.seq)).toEqual([2, 3]);
    expect(resultFrames(resumedSocket).find((frame) => frame.id === "sub-2")).toMatchObject({
      ok: true,
    });

    const staleSocket = createSocket("connection-5");
    const stale = dispatcher.open(staleSocket);
    hello(stale);
    stale.receive(JSON.stringify({ type: "subscribe", id: "sub-3", stream, afterSeq: 0 }));
    expect(resultFrames(staleSocket).find((frame) => frame.id === "sub-3")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  test("rejects malformed protocol frames and unknown event streams", () => {
    const { dispatcher } = createDispatcher();
    const socket = createSocket("connection-6");
    const session = dispatcher.open(socket);
    session.receive("not-json");
    expect(socket.closed).toEqual([{ code: 1002, reason: "Invalid app protocol frame" }]);

    const secondSocket = createSocket("connection-7");
    const second = dispatcher.open(secondSocket);
    hello(second);
    second.receive(
      JSON.stringify({
        type: "subscribe",
        id: "missing-stream",
        stream: "A0.test/missing/thread-1",
      }),
    );
    expect(resultFrames(secondSocket).find((frame) => frame.id === "missing-stream")).toMatchObject(
      {
        ok: false,
        error: { code: "not_found" },
      },
    );
  });
});

describe("A0.6 upgrade and static serving", () => {
  test("rejects bad token, Origin and Host before upgrade", async () => {
    const request = (token: string, origin: string, host = "127.0.0.1:4317") =>
      new Request(`http://127.0.0.1:4317/ws?token=${token}`, {
        headers: { origin, host },
      });
    const badToken = authorizeWebSocketUpgrade(request("wrong", "http://allowed.test"), {
      token: "right",
      origins: ["http://allowed.test"],
      port: 4317,
    });
    expect(badToken?.status).toBe(403);
    expect(await badToken?.text()).toBe("");
    expect(
      authorizeWebSocketUpgrade(request("right", "http://denied.test"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      })?.status,
    ).toBe(403);
    expect(
      authorizeWebSocketUpgrade(request("right", "http://allowed.test", "evil.test:4317"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      })?.status,
    ).toBe(403);
    expect(
      authorizeWebSocketUpgrade(request("right", "http://allowed.test"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      }),
    ).toBeUndefined();
  });

  test("binds loopback, serves the static root and exposes a random token", async () => {
    const app = createAppServer({
      port: 0,
      staticRoot: new URL("./test-fixtures", import.meta.url).pathname,
      origins: ["http://allowed.test"],
    });
    try {
      expect(app.port).toBeGreaterThan(0);
      expect(app.url).toBe(`http://127.0.0.1:${app.port}`);
      expect(app.token.length).toBe(43);
      const response = await fetch(`${app.url}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("A0.6 static fixture");
    } finally {
      await app.stop();
    }
  });
  test("accepts a tokenized loopback WebSocket and sends the C0 welcome", async () => {
    const app = createAppServer({
      port: 0,
      staticRoot: new URL("./test-fixtures", import.meta.url).pathname,
      token: "right",
      origins: ["http://allowed.test"],
    });
    let socket: WebSocket | undefined;
    try {
      socket = await new Promise<WebSocket>((resolve, reject) => {
        const candidate = new WebSocket(`${app.url}/ws?token=${app.token}`, {
          headers: { origin: "http://allowed.test" },
        });
        candidate.onopen = () => resolve(candidate);
        candidate.onerror = () => reject(new Error("WebSocket upgrade failed"));
      });
      const welcome = await new Promise<unknown>((resolve, reject) => {
        socket?.addEventListener(
          "message",
          (event) => {
            try {
              resolve(JSON.parse(String(event.data)));
            } catch {
              reject(new Error("Welcome frame was not JSON"));
            }
          },
          { once: true },
        );
        socket?.send(
          JSON.stringify({
            type: "hello",
            protocols: ["omp-app/1"],
            client: { name: "test-client", version: "1.0.0" },
          }),
        );
      });
      expect(welcome).toMatchObject({ type: "welcome", protocol: "omp-app/1" });
    } finally {
      if (socket !== undefined) socket.close();
      await app.stop();
    }
  });
});

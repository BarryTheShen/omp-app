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
import { launchTokenDigest } from "./launch-history";
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

  test("tells every port which connection closed, exactly once, and a failing port stops no other", async () => {
    const released: string[] = [];
    const failing: PortRegistration = {
      ...registration(),
      onConnectionClosed: () => {
        throw new Error("could not release");
      },
    };
    const second: PortRegistration = {
      port: { ...TestPort, name: "A0.second" as typeof TestPort.name },
      handlers: registration().handlers,
      onConnectionClosed: async (connectionId) => {
        released.push(connectionId);
      },
    };
    const registry = createPortRegistry([failing, second]);
    const dispatcher = new Dispatcher({
      registry,
      replay: new EventReplayHub(2),
      welcome: createWelcome(),
    });
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const session = dispatcher.open(createSocket("connection-7"));
      hello(session);
      session.close();
      session.close();
      await new Promise((done) => setTimeout(done, 20));
    } finally {
      console.error = original;
    }
    expect(released).toEqual(["connection-7"]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toContain("could not release a closed connection");
  });
});

describe("A0.6 upgrade and static serving", () => {
  test("closes bad token and Origin after upgrade, while rejecting bad Host before upgrade", async () => {
    const request = (token: string, origin: string, host = "127.0.0.1:4317") =>
      new Request(`http://127.0.0.1:4317/ws?token=${token}`, {
        headers: { origin, host },
      });
    expect(
      authorizeWebSocketUpgrade(request("wrong", "http://allowed.test"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      }),
    ).toEqual({ closeCode: 4401, reason: "invalid token" });
    expect(
      authorizeWebSocketUpgrade(request("right", "http://denied.test"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      }),
    ).toEqual({ closeCode: 4403, reason: "origin not allowed" });
    expect(
      authorizeWebSocketUpgrade(request("right", "http://allowed.test", "evil.test:4317"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      }),
    ).toMatchObject({ status: 403 });
    expect(
      authorizeWebSocketUpgrade(request("right", "http://allowed.test"), {
        token: "right",
        origins: ["http://allowed.test"],
        port: 4317,
      }),
    ).toBeUndefined();
  });

  test("says a token an earlier start printed is expired, and a token never printed is invalid", () => {
    const request = (token: string) =>
      new Request(`http://127.0.0.1:4317/ws?token=${token}`, {
        headers: { origin: "http://allowed.test", host: "127.0.0.1:4317" },
      });
    const policy = {
      token: "right",
      origins: ["http://allowed.test"],
      port: 4317,
      earlierLaunchTokens: new Set([launchTokenDigest("printed-by-an-earlier-start")]),
    };
    expect(authorizeWebSocketUpgrade(request("printed-by-an-earlier-start"), policy)).toEqual({
      closeCode: 4401,
      reason: "expired token",
    });
    expect(authorizeWebSocketUpgrade(request("never-printed"), policy)).toEqual({
      closeCode: 4401,
      reason: "invalid token",
    });
    expect(authorizeWebSocketUpgrade(request("right"), policy)).toBeUndefined();
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
  test("closes unauthorized upgraded sockets with typed auth codes and no welcome", async () => {
    const app = createAppServer({
      port: 0,
      staticRoot: new URL("./test-fixtures", import.meta.url).pathname,
      token: "right",
      origins: ["http://allowed.test"],
    });
    try {
      const close = async (
        url: string,
        origin: string,
      ): Promise<{ code: number; reason: string }> => {
        const socket = new WebSocket(url, { headers: { origin } });
        return new Promise((resolve, reject) => {
          socket.onerror = () => undefined;
          socket.onclose = (event) => {
            resolve({ code: event.code, reason: event.reason });
            socket.close();
          };
          setTimeout(() => reject(new Error("unauthorized socket did not close")), 1_000);
        });
      };
      await expect(close(`${app.url}/ws?token=wrong`, "http://allowed.test")).resolves.toEqual({
        code: 4401,
        reason: "invalid token",
      });
      await expect(close(`${app.url}/ws?token=right`, "http://denied.test")).resolves.toEqual({
        code: 4403,
        reason: "origin not allowed",
      });
    } finally {
      void app.stop();
    }
  });
});

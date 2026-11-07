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

  test("a name every object has (toString, constructor) is no port's method: unknown, and the connection goes on", async () => {
    const { dispatcher } = createDispatcher();
    const socket = createSocket("connection-8");
    const session = dispatcher.open(socket);
    hello(session);
    for (const method of ["toString", "constructor", "hasOwnProperty"]) {
      session.receive(
        JSON.stringify({ type: "call", id: method, port: "A0.test", method, args: null }),
      );
    }
    session.receive(
      JSON.stringify({
        type: "call",
        id: "echo",
        port: "A0.test",
        method: "echo",
        args: { value: "still here" },
      }),
    );
    await settle();
    expect(
      resultFrames(socket).map((frame) => [frame.id, frame.ok ? "ok" : frame.error.code]),
    ).toEqual([
      ["toString", "not_found"],
      ["constructor", "not_found"],
      ["hasOwnProperty", "not_found"],
      ["echo", "ok"],
    ]);
    expect(socket.closed).toEqual([]);
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
    ).toEqual({ deviceId: null });
  });

  test("with a remote origin, accepts that Tailscale host and origin besides loopback, and nothing else", () => {
    const remote = { origin: "https://devbox.tail1234.ts.net", host: "devbox.tail1234.ts.net" };
    const policy = { token: "right", port: 4317, remote };
    const request = (origin: string, host: string) =>
      new Request(`http://127.0.0.1:4317/ws?token=right`, { headers: { origin, host } });

    // Through `tailscale serve`: the browser's Host and Origin reach the server unchanged.
    expect(
      authorizeWebSocketUpgrade(
        request("https://devbox.tail1234.ts.net", "devbox.tail1234.ts.net"),
        policy,
      ),
    ).toEqual({ deviceId: null });
    // The loopback page still works.
    expect(
      authorizeWebSocketUpgrade(request("http://127.0.0.1:4317", "127.0.0.1:4317"), policy),
    ).toEqual({ deviceId: null });
    // Another tailnet name, plain HTTP for the same name, or a page on another site are turned away.
    expect(
      authorizeWebSocketUpgrade(
        request("https://devbox.tail1234.ts.net", "other.tail1234.ts.net"),
        policy,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      authorizeWebSocketUpgrade(
        request("http://devbox.tail1234.ts.net", "devbox.tail1234.ts.net"),
        policy,
      ),
    ).toEqual({ closeCode: 4403, reason: "origin not allowed" });
    expect(
      authorizeWebSocketUpgrade(request("https://evil.example", "devbox.tail1234.ts.net"), policy),
    ).toEqual({ closeCode: 4403, reason: "origin not allowed" });
    // Without a remote origin, the Tailscale host is a bad Host.
    expect(
      authorizeWebSocketUpgrade(
        request("https://devbox.tail1234.ts.net", "devbox.tail1234.ts.net"),
        {
          token: "right",
          port: 4317,
        },
      ),
    ).toMatchObject({ status: 403 });
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
    expect(authorizeWebSocketUpgrade(request("right"), policy)).toEqual({ deviceId: null });
  });

  test("the printed token counts on this computer only: through a proxy such as `tailscale serve` it lets nothing in", () => {
    const request = (headers: Record<string, string> = {}) =>
      new Request("http://127.0.0.1:4317/ws?token=right", {
        headers: { origin: "http://127.0.0.1:4317", host: "127.0.0.1:4317", ...headers },
      });
    const policy = { token: "right", origins: ["http://127.0.0.1:4317"], port: 4317 };
    expect(authorizeWebSocketUpgrade(request(), policy)).toEqual({ deviceId: null });
    // `tailscale serve` sets both on everything it passes on, whatever Host and Origin the other computer chose.
    const proxied: Record<string, string>[] = [
      { "x-forwarded-for": "100.64.0.7" },
      { "x-forwarded-host": "127.0.0.1:4317" },
    ];
    for (const headers of proxied) {
      expect(authorizeWebSocketUpgrade(request(headers), policy)).toEqual({
        closeCode: 4401,
        reason: "not paired",
      });
    }
  });

  test("binds loopback, serves the static root and exposes a random token", async () => {
    const fixtures = new URL("./test-fixtures", import.meta.url).pathname;
    const app = createAppServer({
      port: 0,
      staticRoot: fixtures,
      uiRoot: `${fixtures}/ui`,
      origins: ["http://allowed.test"],
    });
    try {
      expect(app.port).toBeGreaterThan(0);
      expect(app.url).toBe(`http://127.0.0.1:${app.port}`);
      expect(app.token.length).toBe(43);
      const response = await fetch(`${app.url}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("v2 static fixture");
    } finally {
      await app.stop();
    }
  });
  test("serves the new UI at the root and the old one under /old/, and sends old addresses on with their query", async () => {
    const fixtures = new URL("./test-fixtures", import.meta.url).pathname;
    const app = createAppServer({
      port: 0,
      staticRoot: fixtures,
      uiRoot: `${fixtures}/ui`,
      origins: ["http://allowed.test"],
    });
    const location = async (path: string) =>
      (await fetch(`${app.url}${path}`, { redirect: "manual" })).headers.get("location");
    try {
      expect(await (await fetch(`${app.url}/`)).text()).toContain("v2 static fixture");
      expect(await (await fetch(`${app.url}/old/`)).text()).toContain("A0.6 static fixture");
      // A file only the old UI has, such as one of its own pages, is still served at the root.
      expect(await (await fetch(`${app.url}/old-page.html`)).text()).toContain("old page fixture");
      expect(await location("/old?folder=a")).toBe("/old/?folder=a");
      expect(await location("/v2?folder=a")).toBe("/?folder=a");
      expect(await location("/v2/?folder=a")).toBe("/?folder=a");
      expect(await location("/v2/assets/a.js")).toBe("/assets/a.js");
      // Never `//elsewhere.example/x`, which a browser takes for another site.
      expect(await location("/v2//elsewhere.example/x")).toBe("/elsewhere.example/x");
      expect((await fetch(`${app.url}/missing.js`)).status).toBe(404);
    } finally {
      await app.stop();
    }
  });
  test("only the lite view may be framed, by the pages OMP_APP_FRAME_ANCESTORS names; with none, by no page (#2843)", async () => {
    const fixtures = new URL("./test-fixtures", import.meta.url).pathname;
    const framing = async (url: string) => {
      const response = await fetch(url);
      return {
        status: response.status,
        page: (await response.text()).includes("v2 static fixture"),
        csp: response.headers.get("content-security-policy"),
        xfo: response.headers.get("x-frame-options"),
      };
    };
    const refused = { status: 200, page: true, csp: "frame-ancestors 'none'", xfo: "DENY" };
    const named = createAppServer({
      port: 0,
      staticRoot: fixtures,
      uiRoot: `${fixtures}/ui`,
      origins: ["http://allowed.test"],
      frameAncestors: ["https://notes.tail1234.ts.net:8443", "http://127.0.0.1:9000"],
    });
    const none = createAppServer({
      port: 0,
      staticRoot: fixtures,
      uiRoot: `${fixtures}/ui`,
      origins: ["http://allowed.test"],
    });
    try {
      // The lite view is the new UI's page, which the named pages may frame (and no browser refuses for X-Frame-Options).
      expect(await framing(`${named.url}/lite?theme=dark`)).toEqual({
        status: 200,
        page: true,
        csp: "frame-ancestors https://notes.tail1234.ts.net:8443 http://127.0.0.1:9000",
        xfo: null,
      });
      // Every other page of the app still refuses every frame.
      expect(await framing(`${named.url}/`)).toEqual(refused);
      expect((await framing(`${named.url}/assets/app-fixture.js`)).csp).toBe(
        "frame-ancestors 'none'",
      );
      // With no page named, the lite view refuses every frame too.
      expect(await framing(`${none.url}/lite`)).toEqual(refused);
    } finally {
      await named.stop();
      await none.stop();
    }
  });
  test("a built asset is kept for good and goes gzipped to a browser that takes gzip; the page is never kept", async () => {
    const fixtures = new URL("./test-fixtures", import.meta.url).pathname;
    const app = createAppServer({
      port: 0,
      staticRoot: fixtures,
      uiRoot: `${fixtures}/ui`,
      origins: ["http://allowed.test"],
    });
    const get = (path: string, encoding: string) =>
      fetch(`${app.url}${path}`, { headers: { "Accept-Encoding": encoding }, decompress: false });
    const unzipped = async (response: Response) =>
      new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())));
    try {
      const built = await Bun.file(`${fixtures}/ui/assets/app-fixture.js`).text();

      const zipped = await get("/assets/app-fixture.js", "br, gzip;q=0.8");
      expect(zipped.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(zipped.headers.get("content-encoding")).toBe("gzip");
      expect(zipped.headers.get("vary")).toBe("Accept-Encoding");
      expect(zipped.headers.get("content-type")).toContain("javascript");
      expect(await unzipped(zipped)).toBe(built);

      // A browser that refuses gzip gets the file as it is, kept for good all the same.
      const plain = await get("/assets/app-fixture.js", "gzip;q=0, identity");
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(plain.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await plain.text()).toBe(built);

      const page = await get("/", "gzip");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-encoding")).toBe("gzip");
      expect(await unzipped(page)).toContain("v2 static fixture");
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

  test("with a remote origin, a WebSocket that arrives as `tailscale serve` passes it on gets the welcome", async () => {
    const remote = { origin: "https://devbox.tail1234.ts.net", host: "devbox.tail1234.ts.net" };
    const app = createAppServer({
      port: 0,
      staticRoot: new URL("./test-fixtures", import.meta.url).pathname,
      token: "right",
      remote,
    });
    /**
     * Opens a socket with the Host and Origin a browser sends through `tailscale serve`, and says how it ended: the
     * welcome, refused before the upgrade (the socket never opened), or closed after it with a code.
     */
    const attempt = (host: string, origin: string) =>
      new Promise<"welcome" | "refused" | `closed ${number}`>((resolve) => {
        let opened = false;
        const socket = new WebSocket(`${app.url}/ws?token=right`, { headers: { host, origin } });
        socket.onopen = () => {
          opened = true;
          socket.send(
            JSON.stringify({
              type: "hello",
              protocols: ["omp-app/1"],
              client: { name: "test-client", version: "1.0.0" },
            }),
          );
        };
        socket.onmessage = () => {
          resolve("welcome");
          socket.close();
        };
        socket.onclose = (event) => resolve(opened ? `closed ${event.code}` : "refused");
        socket.onerror = () => undefined;
      });
    try {
      expect(await attempt(remote.host, remote.origin)).toBe("welcome");
      // Another tailnet name is refused before the upgrade, so the custom Host really reached the server.
      expect(await attempt("other.tail1234.ts.net", remote.origin)).toBe("refused");
      expect(await attempt(remote.host, "https://evil.example")).toBe("closed 4403");
    } finally {
      await app.stop();
    }
  });
});

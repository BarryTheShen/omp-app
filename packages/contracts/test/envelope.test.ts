import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type AbortSignalLike,
  APP_PROTOCOL,
  type AppError,
  type ClientFrame,
  definePort,
  type PortClient,
  type PortHandlers,
  parseClientFrame,
  parseServerFrame,
  RequestId,
  type ServerFrame,
  serializeFrame,
  streamKey,
} from "../src";

const id = RequestId.parse("call-1");

const clientFrames: ClientFrame[] = [
  { type: "hello", protocols: [APP_PROTOCOL], client: { name: "web", version: "0.0.0" } },
  { type: "call", id, port: "A1.configStore", method: "read", args: { key: "compaction.enabled" } },
  { type: "cancel", id },
  { type: "subscribe", id, stream: "A0.session/event/01a10931-thread", afterSeq: 41 },
  { type: "subscribe", id, stream: "R1.catalog/changed//home/folder" },
  { type: "unsubscribe", id, stream: "A0.session/event" },
];

const serverFrames: ServerFrame[] = [
  {
    type: "welcome",
    protocol: APP_PROTOCOL,
    instanceId: "server-1",
    serverVersion: "0.0.0",
    omp: { version: "18.6.1" },
    capabilities: {
      "omp.ui": { state: "available", via: "omp" },
      "upstream.plan-mode": { state: "unavailable", via: "upstream", detail: "needs new RPC" },
    },
  },
  {
    type: "welcome",
    protocol: APP_PROTOCOL,
    instanceId: "s",
    serverVersion: "0.0.0",
    omp: null,
    capabilities: {},
  },
  { type: "result", id, ok: true, value: { anything: [1, 2, 3] } },
  {
    type: "result",
    id,
    ok: false,
    error: {
      code: "omp_error",
      message: "Model not found",
      retryable: false,
      omp: { command: "set_model", error: "Model not found: a/b" },
    },
  },
  { type: "event", stream: "A0.session/event/thread-1", seq: 1, payload: { type: "agent_start" } },
];

describe("app wire frames", () => {
  test("client frames survive serialize and parse", () => {
    for (const frame of clientFrames) {
      expect(parseClientFrame(serializeFrame(frame))).toEqual({ ok: true, value: frame });
    }
  });

  test("server frames survive serialize and parse", () => {
    for (const frame of serverFrames) {
      expect(parseServerFrame(serializeFrame(frame))).toEqual({ ok: true, value: frame });
    }
  });

  const badClientFrames: Array<[string, unknown]> = [
    ["unknown type", { type: "shout", id }],
    ["call without id", { type: "call", port: "A1.configStore", method: "read", args: {} }],
    ["empty id", { type: "call", id: "", port: "A1.configStore", method: "read", args: {} }],
    ["port of no module", { type: "call", id, port: "X9.store", method: "read", args: {} }],
    ["port without name", { type: "call", id, port: "A1", method: "read", args: {} }],
    [
      "method not lowerCamel",
      { type: "call", id, port: "A1.configStore", method: "Read", args: {} },
    ],
    ["stream without event", { type: "subscribe", id, stream: "A0.session" }],
    ["stream with empty scope", { type: "subscribe", id, stream: "A0.session/event/" }],
    ["negative afterSeq", { type: "subscribe", id, stream: "A0.session/event", afterSeq: -1 }],
    [
      "hello without protocols",
      { type: "hello", protocols: [], client: { name: "web", version: "1" } },
    ],
  ];

  test.each(badClientFrames)("rejects a client frame: %s", (_, frame) => {
    const parsed = parseClientFrame(JSON.stringify(frame));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("invalid_args");
  });

  const badServerFrames: Array<[string, unknown]> = [
    ["seq 0", { type: "event", stream: "A0.session/event", seq: 0, payload: null }],
    ["fractional seq", { type: "event", stream: "A0.session/event", seq: 1.5, payload: null }],
    ["failed result without error", { type: "result", id, ok: false }],
    [
      "error with unknown code",
      { type: "result", id, ok: false, error: { code: "oops", message: "", retryable: false } },
    ],
    ["other app protocol", { ...serverFrames[1], protocol: "omp-app/2" }],
    ["omp without its release", { ...serverFrames[1], omp: {} }],
    [
      "bad capability key",
      { ...serverFrames[1], capabilities: { "omp.cmd.nope": { state: "available", via: "omp" } } },
    ],
  ];

  test.each(badServerFrames)("rejects a server frame: %s", (_, frame) => {
    expect(parseServerFrame(JSON.stringify(frame)).ok).toBe(false);
  });

  test("text that is not JSON fails without echoing it", () => {
    const parsed = parseClientFrame('{"type":"call","secret":');
    expect(parsed).toEqual({
      ok: false,
      error: { code: "invalid_args", message: "Not valid JSON", retryable: false },
    });
  });

  test("serializeFrame refuses a frame that breaks the schema", () => {
    expect(() => serializeFrame({ type: "cancel", id: "" } as unknown as ClientFrame)).toThrow();
  });

  test("streamKey builds and checks keys", () => {
    expect(streamKey("A0.session", "event")).toBe("A0.session/event");
    expect(streamKey("A0.session", "event", "a/b")).toBe("A0.session/event/a/b");
    expect(() => streamKey("A0.session", "Event")).toThrow();
  });
});

describe("definePort", () => {
  const configStore = definePort({
    name: "A1.configStore",
    methods: {
      read: {
        args: z.object({ key: z.string() }),
        result: z.object({ value: z.unknown() }),
        capability: "host.config-files",
      },
    },
    events: { changed: { payload: z.object({ key: z.string() }) } },
  });

  test("returns the frozen definition", () => {
    expect(configStore.name).toBe("A1.configStore");
    expect(Object.isFrozen(configStore)).toBe(true);
    expect(Object.keys(configStore.methods)).toEqual(["read"]);
  });

  test("client and handler types follow the schemas", async () => {
    const handlers: PortHandlers<typeof configStore, { user: string }> = {
      read: async ({ key }) => ({ value: key.length }),
    };
    const client: PortClient<typeof configStore> = {
      read: (args) => handlers.read(configStore.methods.read.args.parse(args), { user: "user" }),
    };
    expect(await client.read({ key: "abc" })).toEqual({ value: 3 });
  });

  test("a real AbortController's signal is an AbortSignalLike", () => {
    const controller = new AbortController();
    const signal: AbortSignalLike = controller.signal;
    let aborts = 0;
    const onAbort = () => {
      aborts += 1;
    };
    signal.addEventListener("abort", onAbort, { once: true });
    controller.abort("closed");
    signal.removeEventListener("abort", onAbort);
    expect({ aborted: signal.aborted, reason: signal.reason, aborts }).toEqual({
      aborted: true,
      reason: "closed",
      aborts: 1,
    });
  });

  test("client methods take a signal; aborting cancels the call", async () => {
    // A stand-in proxy following the PortCallOptions contract, called with a real signal.
    const sent: ClientFrame[] = [];
    const cancelled: AppError = { code: "cancelled", message: "Cancelled", retryable: false };
    const client: PortClient<typeof configStore> = {
      read: (args, options) => {
        const { promise, reject } = Promise.withResolvers<{ value: unknown }>();
        if (options?.signal?.aborted) {
          reject(cancelled);
          return promise;
        }
        sent.push({ type: "call", id, port: configStore.name, method: "read", args });
        options?.signal?.addEventListener("abort", () => {
          sent.push({ type: "cancel", id });
          reject(cancelled);
        });
        return promise;
      },
    };
    const controller = new AbortController();
    const pending = client.read({ key: "a" }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toEqual(cancelled);
    await expect(client.read({ key: "b" }, { signal: controller.signal })).rejects.toEqual(
      cancelled,
    );
    expect(sent.map((frame) => frame.type)).toEqual(["call", "cancel"]);
  });

  test("rejects a bad port or member name", () => {
    expect(() => definePort({ name: "Z1.thing" as "A1.thing", methods: {}, events: {} })).toThrow();
    expect(() =>
      definePort({
        name: "A1.thing",
        methods: { "do-it": { args: z.null(), result: z.null() } },
        events: {},
      }),
    ).toThrow();
  });
});

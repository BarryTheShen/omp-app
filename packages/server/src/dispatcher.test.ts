import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ServerFrame } from "@omp-app/contracts";
import {
  AppFailure,
  CapabilityMap,
  definePort,
  serializeFrame,
  WelcomeFrame,
} from "@omp-app/contracts";
import { z } from "zod";
import { Dispatcher, type DispatcherSocket } from "./dispatcher";
import { createLogger, readLogTail } from "./logging";
import { createPortRegistry } from "./registry/ports";
import { EventReplayHub } from "./replay";

const DATA = join(import.meta.dir, "../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(join(DATA, "dispatcher-"));
  roots.push(root);
  return root;
}

const TestPort = definePort({
  name: "A0.dispatchertest",
  methods: {
    crash: { args: z.object({}).strict(), result: z.null() },
    refuse: { args: z.object({}).strict(), result: z.null() },
    slow: { args: z.object({}).strict(), result: z.null() },
  },
  events: {},
});

/** A socket that records its frames and reports when `count` results have been sent. */
function socketAwaiting(id: string, count: number) {
  const frames: ServerFrame[] = [];
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const socket: DispatcherSocket & { readonly frames: ServerFrame[] } = {
    id,
    frames,
    send: (frame) => {
      frames.push(frame);
      if (frames.filter((sent) => sent.type === "result").length >= count) resolveDone();
    },
    close: () => undefined,
  };
  return { socket, done };
}

/** Opens a connection to a dispatcher whose two methods throw the given errors, and calls both. */
async function callBoth(
  dir: string,
  crash: unknown,
  refuse: unknown,
): Promise<{ readonly frames: ServerFrame[] }> {
  const logger = createLogger({ dir });
  const registry = createPortRegistry([
    {
      port: TestPort,
      handlers: {
        crash: async () => {
          throw crash;
        },
        refuse: async () => {
          throw refuse;
        },
        slow: async () => undefined,
      },
    },
  ]);
  const dispatcher = new Dispatcher({
    registry,
    replay: new EventReplayHub(2),
    welcome: WelcomeFrame.parse({
      type: "welcome",
      protocol: "omp-app/1",
      instanceId: "instance-1",
      serverVersion: "test",
      omp: null,
      capabilities: CapabilityMap.parse({}),
    }),
    logger,
  });
  const { socket, done } = socketAwaiting("abcdef12-3456-7890-abcd-ef1234567890", 2);
  const session = dispatcher.open(socket);
  session.receive(
    serializeFrame({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "test", version: "1" },
    }),
  );
  for (const [id, method] of [
    ["call-1", "crash"],
    ["call-2", "refuse"],
  ] as const) {
    session.receive(
      JSON.stringify({ type: "call", id, port: "A0.dispatchertest", method, args: {} }),
    );
  }
  await done;
  dispatcher.close(session);
  return { frames: socket.frames };
}
async function callSlow(dir: string): Promise<void> {
  const logger = createLogger({ dir });
  const registry = createPortRegistry([
    {
      port: TestPort,
      handlers: {
        crash: async () => null,
        refuse: async () => null,
        slow: async () => {
          await Bun.sleep(300);
          return null;
        },
      },
    },
  ]);
  const dispatcher = new Dispatcher({
    registry,
    replay: new EventReplayHub(2),
    welcome: WelcomeFrame.parse({
      type: "welcome",
      protocol: "omp-app/1",
      instanceId: "instance-1",
      serverVersion: "test",
      omp: null,
      capabilities: CapabilityMap.parse({}),
    }),
    logger,
  });
  const { socket, done } = socketAwaiting("abcdef12-3456-7890-abcd-ef1234567890", 1);
  const session = dispatcher.open(socket);
  session.receive(
    serializeFrame({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "test", version: "1" },
    }),
  );
  session.receive(
    JSON.stringify({
      type: "call",
      id: "call-slow",
      port: "A0.dispatchertest",
      method: "slow",
      args: {},
    }),
  );
  await done;
  dispatcher.close(session);
}

describe("the dispatcher's fallback for an unexpected error", () => {
  test("the app reads a plain sentence with no internal word, and the detail is only in the debug log", async () => {
    const dir = await tempDir();
    const { frames } = await callBoth(dir, new Error("disk on fire at /srv/data"), undefined);

    const reply = frames.find((frame) => frame.type === "result" && frame.id === "call-1");
    expect(reply).toMatchObject({
      type: "result",
      ok: false,
      error: {
        code: "internal",
        message: "The app ran into an unexpected problem.",
        retryable: false,
      },
    });
    const wire = JSON.stringify(reply);
    expect(wire).not.toContain("port handler");
    expect(wire).not.toContain("disk on fire");

    const text = readLogTail(dir, 20);
    expect(text).toContain("ERROR port.crash call=A0.dispatchertest.crash");
    expect(text).toContain("disk on fire at /srv/data");
  });

  test("an AppFailure's cause reaches the debug log as its code and message, and the reply carries only the app's own sentence", async () => {
    const dir = await tempDir();
    const refusal = new AppFailure(
      {
        code: "permission",
        message: "Unable to read the installed extensions.",
        retryable: true,
      },
      {
        cause: Object.assign(
          new Error("EACCES: permission denied, scandir '/home/u/.omp/agent/extensions'"),
          { code: "EACCES" },
        ),
      },
    );
    const { frames } = await callBoth(dir, undefined, refusal);

    const reply = frames.find((frame) => frame.type === "result" && frame.id === "call-2");
    expect(reply).toMatchObject({
      type: "result",
      ok: false,
      error: {
        code: "permission",
        message: "Unable to read the installed extensions.",
        retryable: true,
      },
    });
    expect(JSON.stringify(reply)).not.toContain("EACCES");

    const text = readLogTail(dir, 20);
    expect(text).toContain("WARN  port.error call=A0.dispatchertest.refuse code=permission");
    expect(text).toContain("cause_code=EACCES");
    expect(text).toContain("EACCES: permission denied");
  });

  test("a secret in a failure's cause stays out of the debug log, even a bearer token or a password in a URL", async () => {
    const dir = await tempDir();
    const refusal = new AppFailure(
      { code: "internal", message: "The app ran into an unexpected problem.", retryable: false },
      {
        cause: new Error(
          "git said Authorization: Bearer abcdefghijklmnop1234 and unable to access 'https://alice:hunter2pass@github.com/owner/repo.git/'",
        ),
      },
    );
    await callBoth(dir, undefined, refusal);

    const text = readLogTail(dir, 20);
    expect(text).toContain("port.error call=A0.dispatchertest.refuse");
    expect(text).toContain("cause=");
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text).not.toContain("hunter2pass");
  });
  test("logs slow calls with method, duration, memory and loop lag without arguments", async () => {
    const dir = await tempDir();
    // This deliberately uses wall time: the slow-call threshold is an integration boundary around an awaited handler.
    await callSlow(dir);
    const text = readLogTail(dir, 20);
    expect(text).toMatch(
      /WARN {2}port\.slow call=A0\.dispatchertest\.slow ms=\d+ rss_before_mb=\d+ rss_after_mb=\d+ loop_lag_ms=\d+/,
    );
    expect(text).not.toContain("args");
  });
});

describe("a connection whose socket closed without the server hearing of it", () => {
  test("a sweep ends it once, its ports let go of what it held, and the log names the client", async () => {
    const dir = await tempDir();
    const released: string[] = [];
    const registry = createPortRegistry([
      {
        port: TestPort,
        handlers: {
          crash: async () => null,
          refuse: async () => null,
          slow: async () => null,
        },
        onConnectionClosed: (connectionId) => {
          released.push(connectionId);
        },
      },
    ]);
    const dispatcher = new Dispatcher({
      registry,
      replay: new EventReplayHub(2),
      welcome: WelcomeFrame.parse({
        type: "welcome",
        protocol: "omp-app/1",
        instanceId: "instance-1",
        serverVersion: "test",
        omp: null,
        capabilities: CapabilityMap.parse({}),
      }),
      logger: createLogger({ dir }),
    });
    let open = true;
    const socket = (id: string, isOpen: () => boolean): DispatcherSocket => ({
      id,
      send: () => undefined,
      close: () => undefined,
      isOpen,
    });
    dispatcher.open(
      socket("gone0000-0000-0000-0000-000000000000", () => open),
      "TestBrowser/1.0 (phone)",
    );
    dispatcher.open(socket("alive000-0000-0000-0000-000000000000", () => true));

    expect(dispatcher.sweep()).toBe(0);
    open = false;
    expect(dispatcher.sweep()).toBe(1);
    expect(dispatcher.sweep()).toBe(0);
    // Ports hear of a closed connection right after it closes, as with a socket's own close.
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toEqual(["gone0000-0000-0000-0000-000000000000"]);

    const text = readLogTail(dir, 20);
    expect(text).toContain("connection.open id=gone0000 total=1 client=");
    expect(text).toContain("TestBrowser/1.0 (phone)");
    expect(text).toMatch(/connection\.close id=gone0000 pending_calls=0 reason=reaped/);
    expect(text).toMatch(/WARN {2}connection\.reaped count=1 total=1/);
  });
});

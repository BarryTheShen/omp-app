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
import { Dispatcher, type DispatcherSocket } from "../dispatcher";
import { createPortRegistry } from "../registry/ports";
import { EventReplayHub } from "../replay";
import { createAppServer } from "../server";
import { createLogger, readLogTail } from "./index";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(join(DATA, "log-integration-"));
  roots.push(root);
  return root;
}

const LogPort = definePort({
  name: "A0.logtest",
  methods: {
    fail: { args: z.object({ prompt: z.string() }).strict(), result: z.null() },
    crash: { args: z.object({ prompt: z.string() }).strict(), result: z.null() },
  },
  events: {},
});

function socketFor(id: string): DispatcherSocket & { readonly frames: ServerFrame[] } {
  const frames: ServerFrame[] = [];
  return { id, frames, send: (frame) => frames.push(frame), close: () => undefined };
}

describe("the debug log and the dispatcher", () => {
  test("records connections, failed calls and crashes, and never the call's arguments", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir });
    const registry = createPortRegistry([
      {
        port: LogPort,
        handlers: {
          fail: async () => {
            throw new AppFailure({ code: "permission", message: "blocked", retryable: false });
          },
          crash: async () => {
            throw new Error("exploded");
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
    const socket = socketFor("abcdef12-3456-7890-abcd-ef1234567890");
    const session = dispatcher.open(socket);
    session.receive(
      serializeFrame({
        type: "hello",
        protocols: ["omp-app/1"],
        client: { name: "test", version: "1" },
      }),
    );
    const prompt = "TOP-SECRET-PROMPT: please read my private notes";
    for (const [id, method] of [
      ["call-1", "fail"],
      ["call-2", "crash"],
    ] as const) {
      session.receive(
        JSON.stringify({ type: "call", id, port: "A0.logtest", method, args: { prompt } }),
      );
    }
    await Bun.sleep(30);
    dispatcher.close(session);

    const text = readLogTail(dir, 20);
    expect(text).toContain("INFO  connection.open id=abcdef12 total=1");
    expect(text).toContain("WARN  port.error call=A0.logtest.fail code=permission message=blocked");
    expect(text).toContain("ERROR port.crash call=A0.logtest.crash message=exploded");
    expect(text).toContain("INFO  connection.close id=abcdef12");
    expect(text).not.toContain("TOP-SECRET-PROMPT");
    expect(text).not.toContain("private notes");
  });
});

describe("the debug log and the server", () => {
  test("records a rejected connection by its reason alone, never the token that was tried or ours", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir });
    const origin = "http://allowed.test";
    const server = createAppServer({
      port: 0,
      logger,
      registry: createPortRegistry([]),
      origins: [origin],
    });
    logger.addSecret(server.token);
    try {
      const tried = "attempt-token-9876543210";
      const closed = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`${server.url}/ws?token=${tried}`, { headers: { origin } });
        socket.onerror = () => undefined;
        socket.onclose = (event) => {
          resolve(event.code);
          socket.close();
        };
      });
      expect(closed).toBe(4401);
      const text = readLogTail(dir, 10);
      expect(text).toContain('WARN  connection.rejected reason="invalid token"');
      expect(text).not.toContain(tried);
      expect(text).not.toContain(server.token);

      // A good connection is recorded as opened and, once it ends, as closed.
      const good = await new Promise<WebSocket>((resolve, reject) => {
        const candidate = new WebSocket(`${server.url}/ws?token=${server.token}`, {
          headers: { origin },
        });
        candidate.onopen = () => resolve(candidate);
        candidate.onerror = () => reject(new Error("WebSocket upgrade failed"));
      });
      good.send(
        JSON.stringify({
          type: "hello",
          protocols: ["omp-app/1"],
          client: { name: "test-client", version: "1.0.0" },
        }),
      );
      await Bun.sleep(80);
      good.close();
      await Bun.sleep(150);
      const after = readLogTail(dir, 10);
      expect(after).toContain("INFO  connection.open");
      expect(after).toContain("INFO  connection.close");
      expect(after).not.toContain(server.token);
    } finally {
      await server.stop();
    }
  });

  test("stop() returns after the server has turned a connection away (it used to hang, so the app could not quit)", async () => {
    const origin = "http://allowed.test";
    const server = createAppServer({
      port: 0,
      registry: createPortRegistry([]),
      origins: [origin],
    });
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(`${server.url}/ws?token=stale-link-token`, {
        headers: { origin },
      });
      socket.onerror = () => undefined;
      socket.onclose = () => {
        socket.close();
        resolve();
      };
    });
    const started = Date.now();
    await server.stop();
    // Bun's stop(true) never resolves in this case; the app's stop gives up after a second.
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});

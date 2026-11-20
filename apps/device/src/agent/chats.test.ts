import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "./agent";

let dir: string | null = null;
let stop: (() => void) | null = null;
afterEach(async () => {
  stop?.();
  stop = null;
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const SERVER = "https://server.example";

/** A server's side of the link: what the machine sent, and frames to send it. */
class FakeLink {
  readonly sent: Record<string, unknown>[] = [];
  readyState = 1;
  readonly #listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  frame(frame: object): void {
    for (const listener of this.#listeners.get("message") ?? [])
      listener({ data: JSON.stringify(frame) });
  }
  last(type: string): Record<string, unknown> | undefined {
    return this.sent.filter((each) => each.type === type).at(-1);
  }
}

test("the computer keeps the chats allowed to reach it: others are refused and asked about once; an allowed chat's streams open; Remove takes it away (PLAN §7f)", async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-agent-chats-"));
  const data = join(dir, "data");
  await mkdir(data, { recursive: true });
  await writeFile(
    join(data, "machine.json"),
    JSON.stringify({ serverOrigin: SERVER, machineId: "m-1", alias: "laptop" }),
  );
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(join(data, "identity.pem"), privateKey.export({ format: "pem", type: "pkcs8" }));
  // A guard that turns on, asks no password (granted), and refuses every session it is asked to open.
  const guardSocket = join(dir, "guard.sock");
  const asked: Record<string, unknown>[] = [];
  let watcher: { write(line: string): unknown } | null = null;
  const on = { on: true, until: new Date(Date.now() + 3_600_000).toISOString(), sessions: 0 };
  const state = (overrides: object = {}) => ({
    ...on,
    hostKey: join(dir ?? "", "host"),
    reviewPending: false,
    changed: [],
    removed: [],
    sudoUntil: null,
    ...overrides,
  });
  const listener = Bun.listen<{ buffer: string }>({
    unix: guardSocket,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      data(socket, chunk) {
        socket.data.buffer += new TextDecoder().decode(chunk);
        const at = socket.data.buffer.indexOf("\n");
        if (at === -1) return;
        const request = JSON.parse(socket.data.buffer.slice(0, at)) as Record<string, unknown>;
        socket.data.buffer = "";
        asked.push(request);
        if (request.op === "watch") {
          watcher = socket;
          socket.write(`${JSON.stringify({ type: "state", state: state({ on: false }) })}\n`);
          return;
        }
        if (request.op === "open") return void socket.end("error the test guard opens nothing\n");
        if (request.op === "on") {
          socket.end(`ok ${JSON.stringify(state())}\n`);
          watcher?.write(`${JSON.stringify({ type: "state", state: state() })}\n`);
          return;
        }
        socket.end("ok {}\n");
      },
    },
  });
  stop = () => listener.stop(true);
  const told: string[] = [];
  const links: FakeLink[] = [];
  const agent = await Agent.open({
    dataDir: data,
    runtimeDir: join(dir, "run"),
    guardSocket,
    tellTerminals: async (text) => told.push(text),
    readReach: async () => [],
    socket: () => {
      const link = new FakeLink();
      links.push(link);
      return link as unknown as WebSocket;
    },
  });
  const events: AgentEvent[] = [];
  agent.watch((event) => events.push(event));
  await agent.start();
  await Bun.sleep(100);
  expect(await agent.on(4242, 30)).toBeNull();
  const link = links[0];
  if (link === undefined) throw new Error("no link opened");
  link.frame({ type: "challenge", nonce: "n".repeat(43) });
  await Bun.sleep(50);
  // The machine advertises its grants (none yet), so the server enforces them too.
  expect(link.last("state")).toMatchObject({ grants: [] });

  // A chat without a grant: refused before the guard is asked, and its person asked once.
  link.frame({ type: "open", stream: 1, threadId: "t-1", chat: "Fix the\u0007 build" });
  link.frame({ type: "ask", threadId: "t-1", chat: "Fix the build" });
  await Bun.sleep(50);
  expect(link.last("refused")).toMatchObject({
    stream: 1,
    reason: expect.stringContaining("its owner was asked"),
  });
  expect(asked.filter((each) => each.op === "open")).toEqual([]);
  expect(agent.chats.requests).toMatchObject([{ threadId: "t-1", chat: "Fix the  build" }]);
  expect(told.filter((each) => each.includes("asks to reach this computer"))).toEqual([
    'The chat "Fix the  build" on server.example asks to reach this computer. Allow or deny it in Agent access.',
  ]);
  // No chat at all: refused, nobody asked.
  link.frame({ type: "open", stream: 2, threadId: null });
  await Bun.sleep(50);
  expect(link.last("refused")).toMatchObject({
    stream: 2,
    reason: "only a chat in omp-app can reach this computer",
  });

  // Allowed with the password: the server hears the grant; the chat's next stream goes to the guard.
  expect(await agent.allowChat(4242, "t-1")).toBeNull();
  expect(asked.find((each) => each.op === "grant-chat")).toEqual({
    op: "grant-chat",
    pid: 4242,
    chat: "Fix the  build",
    server: "server.example",
  });
  expect(link.last("state")).toMatchObject({ grants: ["t-1"] });
  expect(agent.chats.granted).toMatchObject([{ threadId: "t-1", server: SERVER }]);
  expect(JSON.parse(await readFile(join(data, "chat-grants.json"), "utf8")).grants).toHaveLength(1);
  link.frame({ type: "open", stream: 3, threadId: "t-1", chat: "Fix the build" });
  await Bun.sleep(100);
  expect(asked.filter((each) => each.op === "open")).toEqual([{ op: "open", stream: 3 }]);

  // Another chat denied; then the grant removed: the server hears it, and the chat is asked about again.
  link.frame({ type: "ask", threadId: "t-2", chat: "Other" });
  await Bun.sleep(50);
  expect(agent.denyChat("t-2")).toBeNull();
  expect(agent.chats.requests).toEqual([]);
  expect(await agent.removeChat("t-1")).toBeNull();
  expect(link.last("state")).toMatchObject({ grants: [] });
  expect(await agent.removeChat("t-1")).toBe("that chat has no access");
  expect(events.filter((event) => event.type === "chats").length).toBeGreaterThanOrEqual(4);
  await agent.stop();
});

/**
 * D2 (`D2-hot-reload.md`, `D2-step1-plan.md`) through the whole server, on the fake model, with
 * `OMP_APP_DETACHED_HOSTS=1`: a chat's host outlives the server that started it; a server that starts attaches to it, so
 * a reply, a tool or a question under way at a restart goes on and reaches the new server whole, once; a host no server
 * comes back to hands its chat back after its wait, and `omp-app tui` takes it back at once. The test's own runtime
 * folder has no systemd bus, so hosts start in a session of their own, as on a machine without a user service manager.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import { ChatSessionPort, FolderPath, ThreadId } from "@omp-app/contracts";
import { type CompositionServer, createCompositionServer } from "../../scripts/dev";
import {
  chatFiles,
  closeTerminals,
  SCRIPT,
  TERMINAL_CONFIG,
  TMUX,
  terminalOn,
} from "./tui-terminal";

const FAKE_PROVIDER = resolve(import.meta.dir, "../fake-provider/fake-openai-server.ts");
const realTest = Bun.env.OMP_APP_REAL_OMP === "1" ? test : test.skip;
const terminalTest = TMUX !== null && SCRIPT !== null ? realTest : test.skip;
const roots: string[] = [];
const servers: CompositionServer[] = [];
const providers: Bun.Subprocess[] = [];

afterEach(async () => {
  await closeTerminals();
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const provider of providers.splice(0)) {
    provider.kill();
    await provider.exited;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 90_000);

async function startFakeProvider(agentDir: string, env: Record<string, string>): Promise<void> {
  const provider = Bun.spawn(["bun", FAKE_PROVIDER, agentDir], {
    cwd: agentDir,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  providers.push(provider);
  const reader = provider.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("READY ")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("the fake provider exited before READY");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Whether a chat session event is the host's `prompt_result`: a turn ended. */
function isPromptResult(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("event" in payload)) return false;
  const event = payload.event;
  return (
    typeof event === "object" && event !== null && "type" in event && event.type === "prompt_result"
  );
}

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

/** The chat event inside a chat session event, if it carries one. */
function chatEventOf(payload: unknown): { type: string; [key: string]: unknown } | undefined {
  if (typeof payload !== "object" || payload === null || !("event" in payload)) return undefined;
  const event = payload.event;
  return typeof event === "object" && event !== null && "type" in event
    ? (event as { type: string })
    : undefined;
}

/** A message's text parts, joined. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : "",
    )
    .join("");
}

/** A test's folders and the fake model, and how to start a server on them with detached hosts. */
async function setup(handbackMs: string) {
  const root = await mkdtemp(join(tmpdir(), "omp-d2-"));
  roots.push(root);
  const [home, agentDir, appDataDir, folder, runtime] = [
    "home",
    "agent",
    "app",
    "workspace",
    "run",
  ].map((name) => join(root, name)) as [string, string, string, string, string];
  await Promise.all([home, agentDir, appDataDir, folder, runtime].map((dir) => mkdir(dir)));
  const env = {
    ...Bun.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_APP_DATA_DIR: appDataDir,
    XDG_RUNTIME_DIR: runtime,
    ANTHROPIC_API_KEY: ["sk", "ant", "k".repeat(30)].join("-"),
    OMP_APP_DETACHED_HOSTS: "1",
    OMP_APP_HANDBACK_MS: handbackMs,
  } as Record<string, string>;
  await startFakeProvider(agentDir, env);
  const start = async () => {
    const server = await createCompositionServer({
      port: 0,
      env,
      homeDir: home,
      agentDir,
      appDataDir,
      ompArgs: ["--model", "fake/fake-model"],
      staticRoot: resolve(import.meta.dir, "../../../../apps/web/dist"),
    });
    servers.push(server);
    const client = createAppClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: server.token,
      webSocketFactory: (url) =>
        new WebSocket(url, { headers: { Origin: server.url } }) as unknown as WebSocketLike,
      reconnect: { maxAttempts: 1 },
    });
    return { server, client };
  };
  const stop = async (running: Awaited<ReturnType<typeof start>>) => {
    running.client.dispose();
    await running.server.stop();
    servers.splice(servers.indexOf(running.server), 1);
  };
  /** The hosts' sockets, by name, in the server's own folder of them. */
  const sockets = async (): Promise<string[]> => {
    const dirs = (await readdir(runtime)).filter((name) => name.startsWith("omp-app-hosts-"));
    if (dirs.length !== 1) return [];
    const dir = join(runtime, dirs[0] as string);
    return (await readdir(dir))
      .filter((name) => name.endsWith(".sock"))
      .map((name) => join(dir, name));
  };
  return { folder, env, agentDir, start, stop, sockets };
}

/** The text of each result of `toolName` in a chat's file, in order. */
async function toolResultsIn(sessionFile: string, toolName: string): Promise<string[]> {
  const results: string[] = [];
  for (const line of (await Bun.file(sessionFile).text()).split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { role?: string; toolName?: string };
    };
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    if (entry.message.toolName === toolName) results.push(textOf(entry.message));
  }
  return results;
}

describe("D2: hosts that outlive the server", () => {
  realTest(
    "a chat's host outlives its server, hands the chat back after its wait, and a new server continues the chat",
    async () => {
      const { folder, start, stop, sockets } = await setup("3000");

      // A chat and a turn on the first server.
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const events = await first.client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      const turn = new Promise<void>((done) =>
        events.onEvent((payload) => isPromptResult(payload) && done()),
      );
      await chat.request({
        threadId: opened.threadId,
        method: "prompt",
        params: { text: "hello" },
      });
      await turn;

      // The host is on a socket in this server's own folder.
      const [socket] = await sockets();
      expect(socket).toBeDefined();

      // The server stops: the host keeps running and still answers on its socket.
      await stop(first);
      const probe = await Bun.connect({
        unix: socket as string,
        socket: { data: () => undefined },
      });
      probe.end();

      // No server comes: the host hands the chat back and ends; its socket goes.
      await until(() => !existsSync(socket as string), 20_000);

      // A new server opens the chat and continues it.
      const second = await start();
      const again = second.client.port(ChatSessionPort);
      const reopened = await again.open({ threadId: ThreadId.parse(opened.threadId) });
      expect(reopened.threadId).toBe(opened.threadId);
      const moreEvents = await second.client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      const secondTurn = new Promise<void>((done) =>
        moreEvents.onEvent((payload) => isPromptResult(payload) && done()),
      );
      await again.request({
        threadId: opened.threadId,
        method: "prompt",
        params: { text: "again" },
      });
      await secondTurn;
      await again.close({ threadId: opened.threadId });
      second.client.dispose();
    },
    120_000,
  );

  realTest(
    "a reply under way when the server restarts goes on in the same host and reaches the new server whole, once",
    async () => {
      const { folder, start, stop, sockets } = await setup("60000");

      // A long reply starts on the first server.
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const events = await first.client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      let streamed = 0;
      events.onEvent((payload) => {
        if (chatEventOf(payload)?.type === "message_update") streamed++;
      });
      await chat.request({
        threadId: opened.threadId,
        method: "prompt",
        params: { text: "stream_steady" },
      });
      await until(() => streamed > 20, 30_000);
      const before = await sockets();
      expect(before.length).toBe(1);

      // The server restarts in the middle of the reply.
      await stop(first);
      const second = await start();
      // The same host goes on: no other was started.
      expect(await sockets()).toEqual(before);

      const again = second.client.port(ChatSessionPort);
      const reopened = await again.open({ threadId: ThreadId.parse(opened.threadId) });
      const later = await second.client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      const finished: string[] = [];
      let ended = false;
      later.onEvent((payload) => {
        const event = chatEventOf(payload);
        if (
          event?.type === "message_end" &&
          (event.message as { role?: string }).role === "assistant"
        )
          finished.push(textOf(event.message));
        if (event?.type === "prompt_result") ended = true;
      });
      await until(() => ended, 120_000);

      // The reply is whole: its first line and its last.
      const reply = finished.at(-1) ?? "";
      expect(reply.startsWith("Steady line 0:")).toBe(true);
      expect(reply).toContain("Steady line 239:");
      // And the chat's file holds it once.
      const saved = await Bun.file(reopened.sessionFile).text();
      expect(saved.split("Steady line 239:").length - 1).toBe(1);
      await again.close({ threadId: opened.threadId });
      second.client.dispose();
    },
    240_000,
  );

  realTest(
    "a tool running when the server restarts finishes in the same host, and its result reaches the new server, once",
    async () => {
      const { folder, start, stop, sockets } = await setup("60000");
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const events = await first.client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      let running = false;
      events.onEvent((payload) => {
        if (chatEventOf(payload)?.type === "tool_execution_start") running = true;
      });
      await chat.request({
        threadId: opened.threadId,
        method: "prompt",
        params: { text: "slow_tool 12" },
      });
      await until(() => running, 60_000);
      const before = await sockets();

      // The server restarts while the command sleeps.
      await stop(first);
      const second = await start();
      expect(await sockets()).toEqual(before);
      const again = second.client.port(ChatSessionPort);
      const reopened = await again.open({ threadId: ThreadId.parse(opened.threadId) });
      const later = await second.client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      const outputs: string[] = [];
      let ended = false;
      later.onEvent((payload) => {
        const event = chatEventOf(payload);
        if (event?.type === "tool_execution_end") outputs.push(textOf(event.result));
        if (event?.type === "prompt_result") ended = true;
      });
      await until(() => ended, 120_000);

      // The command's result reached the new server, and the chat's file holds it once.
      expect(outputs.some((output) => output.includes("slow-tool-done"))).toBe(true);
      const saved = await toolResultsIn(reopened.sessionFile, "bash");
      expect(saved.filter((text) => text.includes("slow-tool-done")).length).toBe(1);
      await again.close({ threadId: opened.threadId });
      second.client.dispose();
    },
    240_000,
  );

  realTest(
    "a question open when the server restarts is open on the new server, and its answer goes on",
    async () => {
      const { folder, start, stop, sockets } = await setup("60000");
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const threadId = ThreadId.parse(opened.threadId);
      const events = await first.client.subscribe(ChatSessionPort, "event", { scope: threadId });
      let asked: { method: string; params: unknown } | undefined;
      events.onEvent((payload) => {
        if (payload.kind === "host_request") asked = payload.request;
      });
      await chat.request({
        threadId,
        method: "prompt",
        params: { text: "Please ask_user which database to use." },
      });
      await until(() => asked !== undefined, 60_000);
      const before = await sockets();

      // The server restarts while the question waits for its answer.
      await stop(first);
      const second = await start();
      expect(await sockets()).toEqual(before);
      const again = second.client.port(ChatSessionPort);
      const reopened = await again.open({ threadId });
      const later = await second.client.subscribe(ChatSessionPort, "event", { scope: threadId });
      let ended = false;
      later.onEvent((payload) => {
        if (chatEventOf(payload)?.type === "prompt_result") ended = true;
      });

      // The same question is open on the new server; its answer reaches omp, and the turn goes on to its end.
      let open: Awaited<ReturnType<typeof again.openRequests>> = [];
      await until(async () => {
        open = await again.openRequests({ threadId });
        return open.length === 1;
      }, 30_000);
      const question = open[0]?.request;
      expect(question?.method).toBe("ui.select");
      const reAsked: unknown = { method: question?.method, params: question?.params };
      expect(reAsked).toEqual({ method: asked?.method, params: asked?.params });
      await again.answer({ threadId, id: question?.id as string, answer: { value: "Postgres" } });
      await until(() => ended, 60_000);
      const answers = await toolResultsIn(reopened.sessionFile, "ask");
      expect(answers.length).toBe(1);
      expect(answers[0]).toContain("Postgres");
      await again.close({ threadId });
      second.client.dispose();
    },
    240_000,
  );

  realTest(
    "two chats replying when the server restarts go on, each in its own host, and each reply is whole, once",
    async () => {
      const { folder, start, stop, sockets } = await setup("60000");
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const chats = await Promise.all(
        [0, 1].map(() => chat.open({ folderPath: FolderPath.parse(folder), start: "new" })),
      );
      const ids = chats.map((opened) => ThreadId.parse(opened.threadId));
      let streamed = 0;
      for (const threadId of ids) {
        const events = await first.client.subscribe(ChatSessionPort, "event", { scope: threadId });
        events.onEvent((payload) => {
          if (chatEventOf(payload)?.type === "message_update") streamed++;
        });
        await chat.request({ threadId, method: "prompt", params: { text: "stream_steady" } });
      }
      await until(() => streamed > 40, 30_000);
      const before = await sockets();
      expect(before.length).toBe(2);

      await stop(first);
      const second = await start();
      expect(await sockets()).toEqual(before);
      const again = second.client.port(ChatSessionPort);
      const ended = new Set<string>();
      for (const threadId of ids) {
        await again.open({ threadId });
        const later = await second.client.subscribe(ChatSessionPort, "event", { scope: threadId });
        later.onEvent((payload) => {
          if (chatEventOf(payload)?.type === "prompt_result") ended.add(threadId);
        });
      }
      await until(() => ended.size === 2, 150_000);
      for (const opened of chats) {
        const saved = await readFile(opened.sessionFile, "utf8");
        expect(saved.split("Steady line 0:").length - 1).toBe(1);
        expect(saved.split("Steady line 239:").length - 1).toBe(1);
      }
      second.client.dispose();
    },
    240_000,
  );

  realTest(
    "a subagent running when the server restarts goes on, the new server lists it, and its result reaches the chat once",
    async () => {
      const { folder, start, stop } = await setup("60000");
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const threadId = ThreadId.parse(opened.threadId);
      const running = async (port: typeof chat) => {
        const { subagents } = (await port.request({
          threadId,
          method: "get_subagents",
          params: {},
        })) as { subagents: { status: string }[] };
        return subagents.some((subagent) => subagent.status === "running");
      };
      // omp's task tool answers at once; the subagent runs on in the chat's host, and its result comes back to the chat.
      await chat.request({
        threadId,
        method: "prompt",
        params: { text: "spawn_intent_subagent 20" },
      });
      await until(() => running(chat), 60_000);

      await stop(first);
      const second = await start();
      const again = second.client.port(ChatSessionPort);
      const reopened = await again.open({ threadId });
      expect(await running(again)).toBe(true);

      // Its result reaches the chat once, and the chat settles.
      const results = async () =>
        (await readFile(reopened.sessionFile, "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line.includes('"async-result"'));
      await until(async () => (await results()).length > 0, 120_000);
      await until(async () => {
        const state = (await again.request({ threadId, method: "get_state", params: {} })) as {
          isSettled: boolean;
        };
        return state.isSettled;
      }, 60_000);
      const saved = await results();
      expect(saved.length).toBe(1);
      expect(saved[0]).toContain("intent-child-done");
      second.client.dispose();
    },
    240_000,
  );

  terminalTest(
    "with the server stopped for good, omp-app tui takes the chat back at once, and omp writes to the chat itself",
    async () => {
      const { folder, env, agentDir, start, stop, sockets } = await setup("120000");
      await Bun.write(join(agentDir, "config.yml"), TERMINAL_CONFIG);
      const first = await start();
      const chat = first.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const threadId = ThreadId.parse(opened.threadId);
      const events = await first.client.subscribe(ChatSessionPort, "event", { scope: threadId });
      const turn = new Promise<void>((done) =>
        events.onEvent((payload) => isPromptResult(payload) && done()),
      );
      await chat.request({ threadId, method: "prompt", params: { text: "count_reply app-first" } });
      await turn;

      // The server stops for good; its host keeps the chat, for two minutes.
      await stop(first);
      expect((await sockets()).length).toBe(1);

      // The terminal takes it back at once, and omp opens the chat itself: the app's turn shows, the terminal's goes on.
      const terminal = await terminalOn({ folder, env }, Bun.env.OMP_APP_CHAT_HOST_BIN);
      terminal.open(["--resume", threadId]);
      await terminal.shows(/count-\d+ app-first/);
      expect(await terminal.printed()).toContain("Taking a chat back from the app");
      expect(await sockets()).toEqual([]);
      await terminal.type("count_reply terminal-second");
      await terminal.shows(/count-\d+ terminal-second/);

      // Both turns are in the chat's own file: no copy was made, as one is while the app holds the chat.
      const files = await chatFiles({ folder, env });
      expect([...files.keys()]).toEqual([threadId]);
      const written = await readFile(files.get(threadId) ?? "", "utf8");
      expect(written).toMatch(/count-\d+ app-first/);
      expect(written).toMatch(/count-\d+ terminal-second/);
    },
    240_000,
  );

  realTest(
    "a command a chat runs gets neither its host's socket nor the server's switches, so a server it starts cannot take the host's place",
    async () => {
      const { folder, start, sockets } = await setup("60000");
      const running = await start();
      const chat = running.client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folder), start: "new" });
      const [socket] = await sockets();
      expect(socket).toBeDefined();
      const run = (await chat.request({
        threadId: opened.threadId,
        method: "bash",
        params: { command: 'printf "[%s|%s]" "$OMP_APP_HOST_SOCKET" "$OMP_APP_DETACHED_HOSTS"' },
      })) as { readonly output: string };
      expect(run.output).toContain("[|]");
      expect(existsSync(socket as string)).toBe(true);
      await chat.close({ threadId: opened.threadId });
    },
    120_000,
  );
});

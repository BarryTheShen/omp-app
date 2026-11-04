/**
 * Chats on the chat host (SDK plan H5) for the server's live tests: a fresh home and agent folder per chat, the fake
 * model provider, and the server's chat host client over the host's stdin and stdout. Each test runs from source, and on
 * the compiled program when OMP_APP_CHAT_HOST_BIN names one (the e2e global setup builds it). Runs when asked:
 * OMP_APP_REAL_OMP=1.
 */
import { test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FolderPath, ThreadId } from "@omp-app/contracts";
import {
  CHAT_HOST_CHAT_ARG,
  type ChatEvent,
  type PromptResultEvent,
} from "@omp-app/contracts/chat-host";
import { ChatHostClient } from "../../src/chat-host/client";
import { type OmpProcess, spawnOmpProcess } from "../../src/process/omp-process";

const FAKE_PROVIDER = resolve(import.meta.dir, "../fake-provider/fake-openai-server.ts");

export const realTest = Bun.env.OMP_APP_REAL_OMP === "1" ? test : test.skip;

/** The two ways the program runs: from source always, compiled when the e2e setup built it. */
export const PROGRAMS: readonly {
  readonly name: string;
  readonly command: readonly string[] | undefined;
}[] = [
  {
    name: "from source",
    command: [process.execPath, resolve(import.meta.dir, "../../src/chat-host/main.ts")],
  },
  {
    name: "compiled",
    command: Bun.env.OMP_APP_CHAT_HOST_BIN ? [Bun.env.OMP_APP_CHAT_HOST_BIN] : undefined,
  },
];

export interface Chat {
  readonly client: ChatHostClient;
  readonly process: OmpProcess;
  readonly folder: string;
  readonly events: { readonly seq: number; readonly event: ChatEvent }[];
  /** Resolves with the first event that matches, among those already received or the next ones. */
  next(match: (event: ChatEvent) => boolean): Promise<ChatEvent>;
  /**
   * As `next`, among the events from index `mark` on: take `events.length` before the request that causes the event, so
   * an earlier turn's event of the same type cannot answer.
   */
  nextAfter(mark: number, match: (event: ChatEvent) => boolean): Promise<ChatEvent>;
}

export interface ChatOptions {
  /** omp's launch flags after `--model fake/fake-model`. */
  readonly args?: readonly string[];
  /** Files written into the chat's agent folder before it starts (a skill, a setting), by relative path. */
  readonly agentFiles?: Readonly<Record<string, string>>;
  /**
   * Keep omp's own discovery of the agent folder on (skills, rules). The fake provider turns it off by default
   * (`disabledProviders` in the `config.yml` it writes), so a chat starts the same on any machine.
   */
  readonly nativeDiscovery?: boolean;
  /** omp settings as YAML, added to the `config.yml` the fake provider writes (top-level keys it does not set). */
  readonly config?: string;
}

/** A chat's folders, prepared with the fake model provider: for chats a test starts its own way (a process registry). */
export interface ChatFolders {
  readonly home: string;
  readonly agentDir: string;
  /** The chat's workspace, its working folder. */
  readonly folder: string;
  /** The environment a chat needs to run in these folders, on the fake model. */
  readonly env: Readonly<Record<string, string>>;
}

/** Starts chats for one test file; call `stopAll` in its `afterEach` (with a long timeout: a chat closes its session). */
export function chatHostChats() {
  const roots: string[] = [];
  const processes: OmpProcess[] = [];
  const providers: Bun.Subprocess[] = [];

  /** The fake provider writes `fake/fake-model` into the agent folder's models.yml, then says READY. */
  const startFakeProvider = async (agentDir: string, nativeDiscovery: boolean): Promise<void> => {
    const provider = Bun.spawn(["bun", FAKE_PROVIDER, agentDir], {
      cwd: agentDir,
      env: { ...process.env, FAKE_OPENAI_ENABLE_RULES: nativeDiscovery ? "1" : undefined },
      // It runs until its stdin ends, so it ends with the test.
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
  };

  const prepare = async (
    options: Pick<ChatOptions, "agentFiles" | "nativeDiscovery" | "config"> = {},
  ): Promise<ChatFolders> => {
    const root = await mkdtemp(join(tmpdir(), "omp-app-sdk-chat-host-"));
    roots.push(root);
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const folder = join(root, "workspace");
    await Promise.all([home, agentDir, folder].map((dir) => mkdir(dir, { recursive: true })));
    for (const [path, content] of Object.entries(options.agentFiles ?? {})) {
      const file = join(agentDir, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await startFakeProvider(agentDir, options.nativeDiscovery === true);
    if (options.config !== undefined)
      await appendFile(join(agentDir, "config.yml"), options.config);
    const env = {
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      ANTHROPIC_API_KEY: ["sk", "ant", "k".repeat(30)].join("-"),
      // omp names chats itself since #2798; these tests read the names they give (an approved plan's, a rename), so
      // omp leaves chats unnamed here, as the web specs' harness does.
      PI_NO_TITLE: "1",
    };
    return { home, agentDir, folder, env };
  };

  return {
    prepare,

    async start(command: readonly string[], options: ChatOptions = {}): Promise<Chat> {
      const { home, folder, env } = await prepare(options);
      const chatProcess = spawnOmpProcess({
        threadId: ThreadId.parse("thread-sdk-chat-host"),
        folder: FolderPath.parse(folder),
        homeDir: home,
        chatCommand: [...command, CHAT_HOST_CHAT_ARG],
        args: ["--model", "fake/fake-model", ...(options.args ?? [])],
        env,
      });
      processes.push(chatProcess);
      const client = new ChatHostClient(chatProcess);
      const events: { seq: number; event: ChatEvent }[] = [];
      const waiters: {
        match: (event: ChatEvent) => boolean;
        resolve: (event: ChatEvent) => void;
      }[] = [];
      client.onEvent((event, seq) => {
        events.push({ seq, event });
        for (const waiter of [...waiters]) {
          if (!waiter.match(event)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      });
      await chatProcess.start();
      return {
        client,
        process: chatProcess,
        folder,
        events,
        next: (match) => {
          const found = events.find((entry) => match(entry.event));
          if (found) return Promise.resolve(found.event);
          return new Promise((resolveEvent) => waiters.push({ match, resolve: resolveEvent }));
        },
        nextAfter: (mark, match) => {
          const found = events.slice(mark).find((entry) => match(entry.event));
          if (found) return Promise.resolve(found.event);
          return new Promise((resolveEvent) => waiters.push({ match, resolve: resolveEvent }));
        },
      };
    },

    async stopAll(): Promise<void> {
      await Promise.all(processes.splice(0).map((chat) => chat.stop().catch(() => undefined)));
      for (const provider of providers.splice(0)) {
        provider.kill();
        await provider.exited;
      }
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}

/** Matches the `prompt_result` of one prompt request. */
export const resultOf =
  (requestId: string) =>
  (event: ChatEvent): event is PromptResultEvent =>
    event.type === "prompt_result" && event.requestId === requestId;

/** The text of the last assistant message the chat finished. */
export function lastReply(chat: Chat): string {
  for (let index = chat.events.length - 1; index >= 0; index--) {
    const event = chat.events[index]?.event;
    if (event?.type !== "message_end" || event.message.role !== "assistant") continue;
    const { content } = event.message;
    return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }
  return "";
}

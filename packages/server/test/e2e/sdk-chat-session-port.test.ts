/**
 * The server's chat session port on the chat host (SDK plan H5.3a), end to end: the port's runtime over a process
 * registry that starts real chat hosts on the fake model, and the replay hub the browser reads. Runs from source and
 * compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppFailure,
  CapabilityMap,
  type ChatSessionEvent,
  FolderPath,
  RequestId,
  type SessionFilePath,
  type ThreadId,
} from "@omp-app/contracts";
import { CHAT_HOST_CHAT_ARG } from "@omp-app/contracts/chat-host";
import { ChatSessionPortRuntime } from "../../src/ports/A0/chat-session";
import type { A0PortContext } from "../../src/ports/A0/rpc-session";
import { OmpProcessRegistry, spawnOmpProcess } from "../../src/process";
import type { PortHandlerContext } from "../../src/registry/ports";
import { EventReplayHub } from "../../src/replay";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
const runtimes: ChatSessionPortRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await chats.stopAll();
}, 60_000);

function call(connectionId = "connection-1"): PortHandlerContext {
  return {
    connectionId,
    signal: new AbortController().signal,
    requestId: RequestId.parse(`request-${connectionId}`),
    portContext: undefined,
  };
}

/** A port runtime whose chats run the program on the fake model; chats it has opened resume by their thread id. */
async function portRuntime(command: readonly string[]) {
  const { home, folder, env } = await chats.prepare();
  const registry = new OmpProcessRegistry({
    createProcess: (options) =>
      spawnOmpProcess({
        ...options,
        homeDir: home,
        chatCommand: [...command, CHAT_HOST_CHAT_ARG],
        args: ["--model", "fake/fake-model", ...(options.args ?? [])],
        env,
      }),
  });
  const replay = new EventReplayHub(4096);
  const files = new Map<ThreadId, SessionFilePath>();
  const context: A0PortContext = {
    processRegistry: registry,
    replay,
    capabilities: CapabilityMap.parse({}),
    serverInfo: {
      instanceId: "chat-session-port-test",
      serverVersion: "0.0.0",
      launchFolder: FolderPath.parse(folder),
      omp: null,
    },
    health: { status: "ok" },
    resolveThread: async (threadId) => {
      const sessionFile = files.get(threadId);
      return sessionFile === undefined
        ? undefined
        : { threadId, folderPath: FolderPath.parse(folder), sessionFile };
    },
    latestThread: async () => undefined,
    externalOmp: async () => "none",
  };
  const runtime = new ChatSessionPortRuntime(context);
  runtimes.push(runtime);
  return { runtime, replay, registry, folder: FolderPath.parse(folder), files };
}

/** A chat's stream as the replay hub keeps it, from its first event. */
function streamOf(replay: EventReplayHub, runtime: ChatSessionPortRuntime, threadId: ThreadId) {
  const { stream } = runtime.subscribe({ threadId });
  const replayed = replay.replay(stream, 0);
  if ("error" in replayed) throw new Error(replayed.error.message);
  return replayed.frames.map((frame) => frame.payload as ChatSessionEvent);
}

async function until<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

/** Opens a new chat and finishes one turn, so omp has written the chat's file. */
async function chatWithOneTurn(setup: Awaited<ReturnType<typeof portRuntime>>) {
  const { runtime, replay, folder, files } = setup;
  const opened = await runtime.open({ folderPath: folder, start: "new" }, call());
  files.set(opened.threadId, opened.sessionFile);
  await runtime.request({ threadId: opened.threadId, method: "prompt", params: { text: "hello" } });
  await until(() =>
    streamOf(replay, runtime, opened.threadId).find(
      (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
    ),
  );
  return opened;
}

async function failureOf(promise: Promise<unknown>): Promise<AppFailure["appError"]> {
  try {
    await promise;
  } catch (error) {
    return (error as AppFailure).appError;
  }
  throw new Error("the request succeeded");
}

describe("the chat session port on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a new chat opens under its own id, streams its turn on its stream, and maps the host's refusals`,
      async () => {
        const setup = await portRuntime(command);
        const { runtime, replay } = setup;
        const opened = await chatWithOneTurn(setup);
        expect(opened.threadId.startsWith("provisional-")).toBe(false);
        expect(opened.methods).toContain("prompt");
        const state = await runtime.request({
          threadId: opened.threadId,
          method: "get_state",
          params: {},
        });
        expect(state).toMatchObject({
          sessionId: opened.threadId,
          sessionFile: opened.sessionFile,
        });

        const stream = streamOf(replay, runtime, opened.threadId);
        // The events before the chat's own id was known were held, then published on its stream, the ready first.
        expect(stream[0]).toMatchObject({ kind: "process" });
        expect(
          stream.some((payload) => payload.kind === "process" && payload.status === "ready"),
        ).toBe(true);
        expect(
          stream.some(
            (payload) => payload.kind === "event" && payload.event.type === "message_end",
          ),
        ).toBe(true);

        expect(
          await failureOf(
            runtime.request({ threadId: opened.threadId, method: "set_session_name", params: {} }),
          ),
        ).toMatchObject({ code: "invalid_args" });
        expect(
          await failureOf(
            runtime.request({
              threadId: opened.threadId,
              method: "approve_plan",
              params: { planFilePath: "local://PLAN.md" },
            }),
          ),
        ).toMatchObject({
          code: "omp_error",
          omp: { command: "approve_plan", code: "plan_mode_off" },
        });
      },
      90_000,
    );

    programTest(
      `${program.name}: a chat whose process stopped opens again from its file, with its turn`,
      async () => {
        const setup = await portRuntime(command);
        const { runtime, registry } = setup;
        const opened = await chatWithOneTurn(setup);
        await runtime.close({ threadId: opened.threadId }, call());
        await registry.stopIfUnwatched(opened.threadId, "opened");
        expect(registry.has(opened.threadId)).toBe(false);

        const again = await runtime.open({ threadId: opened.threadId }, call());
        expect(again).toMatchObject({ threadId: opened.threadId, sessionFile: opened.sessionFile });
        const state = await runtime.request({
          threadId: opened.threadId,
          method: "get_state",
          params: {},
        });
        expect(state).toMatchObject({ messageCount: 2 });
      },
      90_000,
    );

    programTest(
      `${program.name}: two connections view a chat, and a closed connection lets only its views go`,
      async () => {
        const setup = await portRuntime(command);
        const { runtime, registry } = setup;
        const opened = await runtime.open({ folderPath: setup.folder, start: "new" }, call());
        setup.files.set(opened.threadId, opened.sessionFile);
        await runtime.open({ threadId: opened.threadId }, call("connection-2"));
        expect(runtime.watcherCount(opened.threadId)).toBe(2);
        expect(registry.watcherCount(opened.threadId)).toBe(2);

        await runtime.releaseConnection("connection-1");
        expect(runtime.viewsOf(opened.threadId, "connection-1")).toBe(0);
        expect(runtime.viewsOf(opened.threadId, "connection-2")).toBe(1);
        expect(registry.watcherCount(opened.threadId)).toBe(1);
      },
      90_000,
    );

    programTest(
      `${program.name}: restart starts the chat again from its file, and a killed process is repaired before a request`,
      async () => {
        const setup = await portRuntime(command);
        const { runtime, registry } = setup;
        const opened = await chatWithOneTurn(setup);
        const first = registry.get(opened.threadId)?.pid;
        await runtime.restart({ threadId: opened.threadId });
        const second = registry.get(opened.threadId)?.pid;
        expect(second).toBeDefined();
        expect(second).not.toBe(first);

        process.kill(second ?? 0, "SIGKILL");
        await until(() => (registry.get(opened.threadId)?.status === "exited" ? true : undefined));
        const state = await runtime.request({
          threadId: opened.threadId,
          method: "get_state",
          params: {},
        });
        expect(state).toMatchObject({ sessionId: opened.threadId, messageCount: 2 });
        expect(registry.get(opened.threadId)?.pid).not.toBe(second);
      },
      90_000,
    );
  }
});

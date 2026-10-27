/**
 * The server's chat session port on real chat hosts (SDK plan H5.3), for the port's live tests: the port's runtime over a
 * process registry that starts the chat host on the fake model, and the replay hub the browser reads. Chats the runtime
 * has opened resume by their thread id.
 */
import {
  CapabilityMap,
  type ChatSessionEvent,
  FolderPath,
  RequestId,
  type SessionFilePath,
  type ThreadId,
} from "@omp-app/contracts";
import { CHAT_HOST_CHAT_ARG } from "@omp-app/contracts/chat-host";
import { ChatSessionPortRuntime } from "../../src/ports/A0/chat-session";
import type { A0PortContext } from "../../src/ports/A0/context";
import {
  OmpProcessRegistry,
  type OmpProcessRegistryOptions,
  spawnOmpProcess,
} from "../../src/process";
import type { PortHandlerContext } from "../../src/registry/ports";
import { EventReplayHub } from "../../src/replay";
import { type ChatOptions, chatHostChats } from "./sdk-chat-host-harness";

/** A port call from one browser connection. */
export function call(connectionId = "connection-1"): PortHandlerContext {
  return {
    connectionId,
    signal: new AbortController().signal,
    requestId: RequestId.parse(`request-${connectionId}`),
    portContext: undefined,
  };
}

export interface PortSetup {
  readonly runtime: ChatSessionPortRuntime;
  readonly replay: EventReplayHub;
  readonly registry: OmpProcessRegistry;
  readonly folder: FolderPath;
  /** The session files of the chats a test opened, by thread id: what `resolveThread` finds. */
  readonly files: Map<ThreadId, SessionFilePath>;
}

/** Starts port runtimes for one test file; call `stopAll` in its `afterEach`. */
export function chatSessionPorts() {
  const chats = chatHostChats();
  const runtimes: ChatSessionPortRuntime[] = [];
  return {
    async start(
      command: readonly string[],
      options: Pick<ChatOptions, "agentFiles" | "nativeDiscovery" | "config"> & {
        /** Another omp's lease on a chat, as the server reads it; "none" when unset. */
        readonly externalOmp?: A0PortContext["externalOmp"];
        /** The registry's wait for a stop reaches its limit at once, so a delete is refused while its stop goes on. */
        readonly stopLimitAtOnce?: boolean;
      } = {},
    ): Promise<PortSetup> {
      const { home, folder, env } = await chats.prepare(options);
      const registry = new OmpProcessRegistry({
        createProcess: (processOptions) =>
          spawnOmpProcess({
            ...processOptions,
            homeDir: home,
            chatCommand: [...command, CHAT_HOST_CHAT_ARG],
            args: ["--model", "fake/fake-model", ...(processOptions.args ?? [])],
            env,
          }),
        ...(options.stopLimitAtOnce === true ? { timer: stopLimitAtOnce() } : {}),
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
        externalOmp: options.externalOmp ?? (async () => "none"),
      };
      const runtime = new ChatSessionPortRuntime(context);
      runtimes.push(runtime);
      return { runtime, replay, registry, folder: FolderPath.parse(folder), files };
    },

    async stopAll(): Promise<void> {
      await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
      await chats.stopAll();
    },
  };
}

/**
 * A registry timer whose stop limit (ten seconds) runs out at once; its other timers never fire, so nothing is closed
 * for being idle.
 */
function stopLimitAtOnce(): NonNullable<OmpProcessRegistryOptions["timer"]> {
  return {
    setTimeout: (handler, delayMs) => {
      if (delayMs === 10 * 1000) handler();
      return 0;
    },
    clearTimeout: () => undefined,
  };
}

/** A chat's stream as the replay hub keeps it, from its first event. */
export function streamOf(setup: PortSetup, threadId: ThreadId): ChatSessionEvent[] {
  const { stream } = setup.runtime.subscribe({ threadId });
  const replayed = setup.replay.replay(stream, 0);
  if ("error" in replayed) throw new Error(replayed.error.message);
  return replayed.frames.map((frame) => frame.payload as ChatSessionEvent);
}

/** Reads until `read` finds something. */
export async function until<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

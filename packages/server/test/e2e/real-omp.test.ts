import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import { ChatSessionPort, FolderPath, ThreadId } from "@omp-app/contracts";
import { type CompositionServer, createCompositionServer } from "../../scripts/dev";

/** Whether a chat session event is the host's `prompt_result`: a turn the app asked for has ended. */
function isPromptResult(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    payload.kind === "event" &&
    "event" in payload &&
    typeof payload.event === "object" &&
    payload.event !== null &&
    "type" in payload.event &&
    payload.event.type === "prompt_result"
  );
}

const FAKE_PROVIDER = resolve(import.meta.dir, "../fake-provider/fake-openai-server.ts");
// Runs when asked (OMP_APP_REAL_OMP=1). omp is the app's own build of its command line: the compiled chat host when
// OMP_APP_CHAT_HOST_BIN names it (the e2e global setup builds it), else the chat host's entry from source.
const realTest = Bun.env.OMP_APP_REAL_OMP === "1" ? test : test.skip;
const roots: string[] = [];
const servers: CompositionServer[] = [];
const providers: Bun.Subprocess[] = [];

interface ReadyProvider {
  readonly process: Bun.Subprocess;
  readonly port: number;
}

async function startFakeProvider(
  agentDir: string,
  env: Record<string, string>,
): Promise<ReadyProvider> {
  const process = Bun.spawn(["bun", FAKE_PROVIDER, agentDir], {
    cwd: agentDir,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  providers.push(process);
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("fake provider exited before READY");
      text += decoder.decode(value, { stream: true });
      const line = text.split("\n")[0];
      if (line === undefined || !line.startsWith("READY ")) continue;
      const port = Number(line.slice("READY ".length));
      if (!Number.isInteger(port) || port < 1)
        throw new Error("fake provider returned an invalid port");
      return { process, port };
    }
  } finally {
    reader.releaseLock();
  }
}

function waitForEvent<Payload>(
  subscription: { onEvent(listener: (payload: Payload, seq: number) => void): () => void },
  predicate: (payload: Payload) => boolean,
): Promise<{ payload: Payload; seq: number }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error("Timed out waiting for the real omp event"));
    }, 10_000);
    unsubscribe = subscription.onEvent((payload, seq) => {
      if (settled || !predicate(payload)) return;
      settled = true;
      clearTimeout(guard);
      unsubscribe();
      resolvePromise({ payload, seq });
    });
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const provider of providers.splice(0)) {
    try {
      const stdin = provider.stdin;
      if (stdin !== undefined && typeof stdin !== "number") stdin.end();
    } catch {
      // The child may already have exited.
    }
    await provider.exited;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("A0.9 real omp composition", () => {
  realTest(
    "opens, prompts, reconnects with afterSeq replay, and closes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "omp-app-a0-9-e2e-"));
      roots.push(root);
      const home = join(root, "home");
      const agentDir = join(root, "agent");
      const appDataDir = join(root, "app");
      const folderPath = join(root, "workspace");
      await Promise.all([mkdir(home), mkdir(agentDir), mkdir(appDataDir), mkdir(folderPath)]);
      const fakeKey = ["sk", "ant", "k".repeat(30)].join("-");
      const env = {
        ...Bun.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        OMP_APP_DATA_DIR: appDataDir,
        ANTHROPIC_API_KEY: fakeKey,
        // omp names chats itself since #2798; these tests read the names they give, so omp leaves chats unnamed here, as
        // the web specs' harness does.
        PI_NO_TITLE: "1",
      };
      await startFakeProvider(agentDir, env);
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

      const url = `ws://127.0.0.1:${server.port}/ws`;
      const webSocketFactory = (socketUrl: string): WebSocketLike => {
        const socket = new WebSocket(socketUrl, {
          headers: { Origin: server.url },
        });
        return socket as unknown as WebSocketLike;
      };
      const client = createAppClient({
        url,
        token: server.token,
        webSocketFactory,
        reconnect: { maxAttempts: 2 },
      });
      const chat = client.port(ChatSessionPort);
      const opened = await chat.open({ folderPath: FolderPath.parse(folderPath), start: "new" });
      const subscription = await client.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
      });
      const firstEvents: Array<{ prompted: boolean; seq: number }> = [];
      const stopFirst = subscription.onEvent((payload, seq) => {
        firstEvents.push({ prompted: isPromptResult(payload), seq });
      });

      await chat.request({
        threadId: opened.threadId,
        method: "prompt",
        params: { text: "hello from A0.9" },
      });
      const prompt = await waitForEvent(subscription, isPromptResult);
      expect(firstEvents.some((event) => event.prompted)).toBe(true);
      const lastSeq = Math.max(subscription.lastSeq, prompt.seq);
      stopFirst();
      client.dispose();

      const reconnectingClient = createAppClient({
        url,
        token: server.token,
        webSocketFactory,
        reconnect: { maxAttempts: 2 },
      });
      const reconnectingChat = reconnectingClient.port(ChatSessionPort);
      const reopened = await reconnectingChat.open({ threadId: ThreadId.parse(opened.threadId) });
      expect(reopened.threadId).toBe(opened.threadId);
      const replayed = await reconnectingClient.subscribe(ChatSessionPort, "event", {
        scope: opened.threadId,
        afterSeq: Math.max(0, lastSeq - 1),
      });
      expect(replayed.lastSeq).toBeGreaterThanOrEqual(lastSeq);

      await reconnectingChat.request({
        threadId: opened.threadId,
        method: "prompt",
        params: { text: "second turn" },
      });
      const secondPrompt = await waitForEvent(replayed, isPromptResult);
      expect(secondPrompt.seq).toBeGreaterThan(lastSeq);
      await reconnectingChat.close({ threadId: opened.threadId });
      reconnectingClient.dispose();
      // Two of omp's turns and a reconnect on real omp: about 10 s on the build server, past bun's 5 s default.
    },
    60_000,
  );
});

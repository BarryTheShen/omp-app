import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import { FolderPath, RpcSessionPort, ThreadId } from "@omp-app/contracts";
import { type CompositionServer, createCompositionServer } from "../../scripts/dev";

const REAL_OMP = "/home/user/.bun/bin/omp";
const FAKE_PROVIDER = resolve(import.meta.dir, "../../../omp-rpc/scripts/fake-openai-server.ts");
const realTest = Bun.env.OMP_APP_REAL_OMP === "1" && existsSync(REAL_OMP) ? test : test.skip;
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
  realTest("opens, prompts, reconnects with afterSeq replay, and closes", async () => {
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
    };
    await startFakeProvider(agentDir, env);
    const server = await createCompositionServer({
      port: 0,
      env,
      homeDir: home,
      agentDir,
      appDataDir,
      ompBin: REAL_OMP,
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
    const rpc = client.port(RpcSessionPort);
    const opened = await rpc.open({ folderPath: FolderPath.parse(folderPath), start: "new" });
    const subscription = await client.subscribe(RpcSessionPort, "event", {
      scope: opened.threadId,
    });
    const firstEvents: Array<{ kind: string; seq: number }> = [];
    const stopFirst = subscription.onEvent((payload, seq) => {
      if (typeof payload === "object" && payload !== null && "kind" in payload) {
        firstEvents.push({ kind: String(payload.kind), seq });
      }
    });

    await rpc.send({
      threadId: opened.threadId,
      command: { type: "prompt", message: "hello from A0.9" },
    });
    const prompt = await waitForEvent(subscription, (payload) => {
      return (
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        payload.kind === "prompt_result"
      );
    });
    expect(firstEvents.some((event) => event.kind === "prompt_result")).toBe(true);
    const lastSeq = Math.max(subscription.lastSeq, prompt.seq);
    stopFirst();
    client.dispose();

    const reconnectingClient = createAppClient({
      url,
      token: server.token,
      webSocketFactory,
      reconnect: { maxAttempts: 2 },
    });
    const reconnectingRpc = reconnectingClient.port(RpcSessionPort);
    const reopened = await reconnectingRpc.open({ threadId: ThreadId.parse(opened.threadId) });
    expect(reopened.threadId).toBe(opened.threadId);
    const replayed = await reconnectingClient.subscribe(RpcSessionPort, "event", {
      scope: opened.threadId,
      afterSeq: Math.max(0, lastSeq - 1),
    });
    expect(replayed.lastSeq).toBeGreaterThanOrEqual(lastSeq);

    await reconnectingRpc.send({
      threadId: opened.threadId,
      command: { type: "prompt", message: "second turn" },
    });
    const secondPrompt = await waitForEvent(replayed, (payload) => {
      return (
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        payload.kind === "prompt_result"
      );
    });
    expect(secondPrompt.seq).toBeGreaterThan(lastSeq);
    await reconnectingRpc.close({ threadId: opened.threadId });
    reconnectingClient.dispose();
  });
});

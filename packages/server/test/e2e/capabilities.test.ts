import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import { AppPort, FolderPath, RpcSessionPort, WelcomeFrame } from "@omp-app/contracts";
import { type CompositionServer, createCompositionServer } from "../../scripts/dev";

const dataRoot = resolve(import.meta.dir, "../../../../../.data");
const roots: string[] = [];
const servers: CompositionServer[] = [];

const FAKE_OMP = `#!/usr/bin/env bun
if (Bun.argv.includes("--version")) {
  process.stdout.write("omp 18.6.1\\n");
  process.exit(0);
}
if (Bun.argv.slice(-3).join(" ") === "config list --json") {
  process.stdout.write(JSON.stringify({ model: { type: "string", value: "fake-default" } }));
  process.exit(0);
}
console.log(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
let pending = "";
function respond(command) {
  if (command.type === "negotiate_protocol") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { protocolVersion: 2 } }));
    return;
  }
  if (command.type === "prompt" || command.type === "abort_and_prompt") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "message is required" }));
    return;
  }
  if (command.type === "get_state") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "thread-capability", sessionFile: process.cwd() + "/session.jsonl" } }));
    return;
  }
  console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }));
}
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  const lines = pending.split("\\n");
  pending = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) respond(JSON.parse(line));
}
`;

async function temporaryRoot(prefix: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, prefix));
  roots.push(root);
  return root;
}

async function fakeOmp(root: string): Promise<string> {
  const path = join(root, "fake-omp");
  await writeFile(path, FAKE_OMP, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function startServer(ompBin: string): Promise<CompositionServer> {
  const root = await temporaryRoot("capabilities-server-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const appDataDir = join(root, "app-data");
  await Promise.all([mkdir(home), mkdir(agentDir), mkdir(appDataDir)]);
  const env = {
    ...Bun.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_APP_DATA_DIR: appDataDir,
  };
  const server = await createCompositionServer({
    port: 0,
    env,
    homeDir: home,
    agentDir,
    appDataDir,
    ompBin,
    staticRoot: resolve(import.meta.dir, "../../../../apps/web/dist"),
  });
  servers.push(server);
  return server;
}

function clientFor(server: CompositionServer) {
  const webSocketFactory = (socketUrl: string): WebSocketLike => {
    const socket = new WebSocket(socketUrl, { headers: { Origin: server.url } });
    return socket as unknown as WebSocketLike;
  };
  return createAppClient({
    url: `ws://127.0.0.1:${server.port}/ws`,
    token: server.token,
    webSocketFactory,
    reconnect: { maxAttempts: 1 },
  });
}

async function welcomeFor(server: CompositionServer) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(server.token)}`,
    { headers: { Origin: server.url } },
  );
  return new Promise<ReturnType<typeof WelcomeFrame.parse>>((resolveWelcome, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for welcome")), 5_000);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocols: ["omp-app/1"],
          client: { name: "capability-test", version: "0.0.0" },
        }),
      );
    };
    socket.onmessage = (event) => {
      try {
        const parsed = WelcomeFrame.parse(JSON.parse(String(event.data)));
        clearTimeout(timer);
        socket.close();
        resolveWelcome(parsed);
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Welcome WebSocket failed"));
    };
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("composition capability wiring", () => {
  test("publishes the same server metadata and capabilities in welcome and AppPort", async () => {
    const root = await temporaryRoot("capabilities-bin-");
    const binary = await fakeOmp(root);
    const server = await startServer(binary);
    const welcome = await welcomeFor(server);
    const client = clientFor(server);
    const app = client.port(AppPort);
    expect(await app.serverInfo({})).toEqual({
      instanceId: welcome.instanceId,
      serverVersion: welcome.serverVersion,
      launchFolder: FolderPath.parse(process.cwd()),
      omp: welcome.omp,
    });
    const folder = await temporaryRoot("capabilities-thread-");
    const rpc = client.port(RpcSessionPort);
    const opened = await rpc.open({ folderPath: FolderPath.parse(folder), start: "new" });
    expect(opened.capabilities).toEqual(welcome.capabilities);
    await rpc.close({ threadId: opened.threadId });
    client.dispose();
  });

  test("reports unhealthy and rejects open when omp is missing", async () => {
    const root = await temporaryRoot("capabilities-missing-");
    const server = await startServer(join(root, "missing-omp"));
    const client = clientFor(server);
    expect(await client.port(AppPort).health({})).toMatchObject({ status: "unhealthy" });
    const folder = join(root, "workspace");
    await mkdir(folder);
    await expect(
      client.port(RpcSessionPort).open({ folderPath: FolderPath.parse(folder), start: "new" }),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    client.dispose();
  });
});

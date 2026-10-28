import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import {
  AppPort,
  ChatSessionPort,
  ConfigStore,
  FolderPath,
  WelcomeFrame,
} from "@omp-app/contracts";
import { CHAT_HOST_METHODS } from "@omp-app/contracts/chat-host";
import {
  type CompositionServer,
  type CompositionServerOptions,
  createCompositionServer,
} from "../../scripts/dev";

const dataRoot = resolve(import.meta.dir, "../../../../../.data");
const roots: string[] = [];
const servers: CompositionServer[] = [];

// A server start runs real omp probes, and a check that times out waits out its limit twice (the patient retry, #2217).
// bun's 5 s default failed these tests under load, so each one allows 30 s.

/** omp's command line for `--version` and `config list --json`; with `__omp_app_chat`, a chat host that says hello. */
const FAKE_OMP = `#!/usr/bin/env bun
require("node:fs").appendFileSync(import.meta.path + ".spawnlog", Bun.argv.slice(2).join(" ") + "\\n");
if (Bun.argv.includes("--version")) {
  process.stdout.write("omp 18.6.1\\n");
  process.exit(0);
}
if (Bun.argv.slice(-3).join(" ") === "config list --json") {
  process.stdout.write(JSON.stringify({ model: { type: "string", value: "fake-default" }, "registry.only": { type: "string" } }));
  process.exit(0);
}
// The fake speaks no omp RPC: a start without the chat host's argument ends at once.
if (!Bun.argv.includes("__omp_app_chat")) process.exit(2);
if (Bun.env.FAKE_NO_HELLO !== "1") {
  console.log(JSON.stringify({
    kind: "hello",
    protocol: 1,
    ompVersion: "18.6.1",
    methods: ${JSON.stringify(CHAT_HOST_METHODS)},
    session: { id: "thread-capability", file: process.cwd() + "/session.jsonl", cwd: process.cwd() },
  }));
}
for await (const _chunk of Bun.stdin.stream()) {
  // A chat host reads requests until it is stopped; the check sends none.
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

/** A line of the fake's spawn log that started a chat (or the probe's chat), not one of omp's commands. */
function isChatStart(args: string): boolean {
  return args !== "" && args !== "--version" && args !== "config list --json";
}

async function startServer(
  ompBin: string,
  environment: Readonly<Record<string, string>> = {},
  sharedRoot?: string,
  capabilityProbeSettings?: CompositionServerOptions["capabilityProbeSettings"],
  leaseProbe?: CompositionServerOptions["leaseProbe"],
): Promise<CompositionServer> {
  const root = sharedRoot ?? (await temporaryRoot("capabilities-server-"));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const appDataDir = join(root, "app-data");
  await Promise.all(
    [root, home, agentDir, appDataDir].map((path) => mkdir(path, { recursive: true })),
  );
  const env = {
    ...Bun.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_APP_DATA_DIR: appDataDir,
    ...environment,
  };
  const server = await createCompositionServer({
    port: 0,
    env,
    homeDir: home,
    agentDir,
    appDataDir,
    // The fake is the chat host: it answers omp's commands, and the probe's and the chats' requests.
    chatHostBinary: ompBin,
    staticRoot: resolve(import.meta.dir, "../../../../apps/web/dist"),
    ...(capabilityProbeSettings === undefined ? {} : { capabilityProbeSettings }),
    ...(leaseProbe === undefined ? {} : { leaseProbe }),
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

describe("the omp the app runs", () => {
  /** A server started with only a chat host: omp's commands and its chats both run it. */
  async function startWithChatHost(
    root: string,
    chatHost: string,
    environment: Readonly<Record<string, string>>,
  ): Promise<CompositionServer> {
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const appDataDir = join(root, "app-data");
    await Promise.all([home, agentDir, appDataDir].map((path) => mkdir(path, { recursive: true })));
    const server = await createCompositionServer({
      port: 0,
      env: { ...Bun.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, ...environment },
      homeDir: home,
      agentDir,
      appDataDir,
      staticRoot: resolve(import.meta.dir, "../../../../apps/web/dist"),
      chatHostBinary: chatHost,
    });
    servers.push(server);
    return server;
  }

  test("runs omp's commands with the chat host, never an omp found on PATH", async () => {
    const root = await temporaryRoot("chat-host-omp-");
    const pathDir = join(root, "path-bin");
    await mkdir(pathDir, { recursive: true });
    const chatHost = await fakeOmp(root);
    // An omp on PATH that would fail every probe and records any start.
    await writeFile(
      join(pathDir, "omp"),
      `#!/bin/sh\necho "$@" >> "${join(pathDir, "omp.spawnlog")}"\nexit 1\n`,
      { mode: 0o755 },
    );

    const server = await startWithChatHost(root, chatHost, {
      PATH: `${pathDir}:${Bun.env.PATH ?? ""}`,
    });

    expect(server.health.status).toBe("ok");
    const runs = (await readFile(`${chatHost}.spawnlog`, "utf8")).trim().split("\n");
    expect(runs).toContain("--version");
    expect(runs).toContain("config list --json");
    await expect(readFile(join(pathDir, "omp.spawnlog"), "utf8")).rejects.toThrow();
  }, 30_000);

  test("starts, and says why, when the chat host is missing", async () => {
    const root = await temporaryRoot("chat-host-missing-");

    const server = await startWithChatHost(root, join(root, "missing-chat-host"), {});

    expect(server.health).toEqual({ status: "unhealthy", detail: "omp was not found." });
    // The server still answers, so the page can show the reason.
    expect((await welcomeFor(server)).type).toBe("welcome");
  }, 30_000);

  test("deletes the omp release that earlier versions downloaded into its data folder", async () => {
    const root = await temporaryRoot("old-omp-download-");
    const oldDownload = join(root, "app-data", "omp");
    await mkdir(oldDownload, { recursive: true });
    await writeFile(join(oldDownload, "omp-18.12.6"), "an earlier version's download");

    const server = await startWithChatHost(root, await fakeOmp(root), {});

    expect(server.health.status).toBe("ok");
    expect(existsSync(oldDownload)).toBe(false);
  }, 30_000);
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
    // A chat's open answers with its host's methods; the capabilities the browser uses are the app's, as in the welcome.
    expect(await app.capabilities({})).toEqual(welcome.capabilities);
    client.dispose();
  }, 30_000);

  test("reuses omp probe output on an unchanged second server start and keeps no-default registry keys", async () => {
    const root = await temporaryRoot("capabilities-cache-");
    const binary = await fakeOmp(root);
    const environment = {};
    const firstServer = await startServer(binary, environment, root);
    const firstClient = clientFor(firstServer);
    const firstKeys = (await firstClient.port(ConfigStore).list({ folder: null })).availableKeys;
    firstClient.dispose();

    const secondServer = await startServer(binary, environment, root);
    const secondClient = clientFor(secondServer);
    const secondKeys = (await secondClient.port(ConfigStore).list({ folder: null })).availableKeys;
    secondClient.dispose();

    expect(firstKeys).toContain("registry.only");
    expect(secondKeys).toEqual(firstKeys);
    const invocations = (await readFile(`${binary}.spawnlog`, "utf8")).trim().split("\n");
    expect(invocations.filter((args) => args === "--version")).toHaveLength(2);
    expect(invocations.filter((args) => args === "config list --json")).toHaveLength(1);
    expect(invocations.filter(isChatStart)).toHaveLength(1);
    expect(invocations).toHaveLength(4);
  }, 30_000);
  test("entire capability timeouts make server health unhealthy and are not cached", async () => {
    const root = await temporaryRoot("capabilities-entire-timeout-");
    const binary = await fakeOmp(root);
    const server = await startServer(binary, { FAKE_NO_HELLO: "1" }, root, {
      timeoutMs: 200,
      deadlineMs: 400,
      patient: { timeoutMs: 200, deadlineMs: 400 },
    });
    const client = clientFor(server);
    expect(await client.port(AppPort).health({})).toMatchObject({
      status: "unhealthy",
      detail: expect.stringContaining("did not answer the app's checks"),
    });
    client.dispose();
    expect(
      await readFile(join(root, "app-data", "omp-probe-cache.json"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  }, 30_000);

  test("publishes what the chats answer: the chat host's methods", async () => {
    const root = await temporaryRoot("capabilities-hello-");
    const server = await startServer(await fakeOmp(root), {}, root);
    const client = clientFor(server);
    expect(await client.port(AppPort).health({})).toEqual({ status: "ok" });
    const capabilities = await client.port(AppPort).capabilities({});
    expect(capabilities["omp.cmd.get_state"]).toEqual({ state: "available", via: "omp" });
    client.dispose();
  }, 30_000);
  test("reports unhealthy and rejects open when omp is missing", async () => {
    const root = await temporaryRoot("capabilities-missing-");
    const server = await startServer(join(root, "missing-omp"));
    const client = clientFor(server);
    expect(await client.port(AppPort).health({})).toMatchObject({ status: "unhealthy" });
    const folder = join(root, "workspace");
    await mkdir(folder);
    await expect(
      client.port(ChatSessionPort).open({ folderPath: FolderPath.parse(folder), start: "new" }),
    ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    client.dispose();
  }, 30_000);
});

describe("composition environment wiring", () => {
  test("the ConfigStore reports omp's environment values as their source", async () => {
    const root = await temporaryRoot("environment-bin-");
    const binary = await fakeOmp(root);
    const server = await startServer(binary, { PI_AUTO_QA: "0", PI_INTENT_TRACING: "0" });
    const client = clientFor(server);
    const config = client.port(ConfigStore);
    expect(await config.read({ key: "dev.autoqa", folder: null })).toMatchObject({
      value: false,
      source: "env",
    });
    expect(await config.read({ key: "tools.intentTracing", folder: null })).toMatchObject({
      value: false,
      source: "env",
    });
    client.dispose();
  }, 30_000);
});

describe("composition open of a chat another omp holds", () => {
  test("an open whose chat another omp holds fails at once with the terminal sentence, and starts no chat", async () => {
    const root = await temporaryRoot("capabilities-held-");
    const binary = await fakeOmp(root);
    const server = await startServer(binary, {}, root, undefined, async () => "active");
    const client = clientFor(server);
    // The first call connects the client, so the bound below measures the refusal, not the connection.
    await client.port(AppPort).serverInfo({});
    const folder = await temporaryRoot("capabilities-held-folder-");
    const omp = async () =>
      (await readFile(`${binary}.spawnlog`, "utf8")).split("\n").filter(isChatStart);
    const before = await omp();
    const started = performance.now();
    await expect(
      client.port(ChatSessionPort).open({ folderPath: FolderPath.parse(folder), start: "new" }),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        conflictReason: "held_elsewhere",
        message:
          "This chat is open in another omp, for example in a terminal. Close it there, then open it here.",
      },
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(await omp()).toEqual(before);
    client.dispose();
  }, 30_000);
});

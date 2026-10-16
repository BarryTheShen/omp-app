import { afterEach, describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import {
  AppPort,
  ConfigStore,
  DraftStore,
  ExtensionCatalog,
  RuleStore,
  SessionPinStore,
} from "@omp-app/contracts";
import { type CompositionServer, createCompositionServer } from "../../scripts/dev";
import { FileWatchRegistry } from "../../src/modules/A1/fs";

const dataRoot = resolve(import.meta.dir, "../../../../../.data");
const roots: string[] = [];
const servers: CompositionServer[] = [];

// The same fake omp the capabilities test uses: it answers the start-up checks, so the health starts "ok".
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
  console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }));
}
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  const lines = pending.split("\\n");
  pending = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) respond(JSON.parse(line));
}
`;

async function temporaryRoot(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, "file-watch-server-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A composition server whose watches start unavailable, then recover when watcher slots are freed. */
async function startServerWithFailingWatches(): Promise<{
  readonly server: CompositionServer;
  readonly registry: FileWatchRegistry;
  readonly freeWatcherSlots: () => void;
}> {
  const root = await temporaryRoot();
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const appDataDir = join(root, "app-data");
  await Promise.all([mkdir(home), mkdir(agentDir), mkdir(appDataDir)]);
  // One file in each folder a store watches, so each store has something to watch.
  await mkdir(join(agentDir, "extensions"));
  await writeFile(join(agentDir, "extensions", "demo.ts"), "export {};\n");
  await mkdir(join(agentDir, "rules"));
  await writeFile(join(agentDir, "rules", "demo.md"), "# demo\n");
  await writeFile(join(agentDir, "config.yml"), "model: fake\n");
  const ompBin = join(root, "fake-omp");
  await writeFile(ompBin, FAKE_OMP, { mode: 0o755 });
  await chmod(ompBin, 0o755);
  let watcherSlotsAvailable = false;
  const registry = new FileWatchRegistry({
    watchDirectory: (directory, listener) => {
      if (!watcherSlotsAvailable) {
        throw Object.assign(new Error("ENOSPC: System limit for number of file watchers reached"), {
          code: "ENOSPC",
        });
      }
      return watch(directory, { persistent: false }, listener);
    },
  });
  const server = await createCompositionServer({
    port: 0,
    env: { ...Bun.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, OMP_APP_DATA_DIR: appDataDir },
    homeDir: home,
    agentDir,
    appDataDir,
    ompBin,
    staticRoot: resolve(import.meta.dir, "../../../../apps/web/dist"),
    fileWatch: registry,
  });
  servers.push(server);
  return { server, registry, freeWatcherSlots: () => (watcherSlotsAvailable = true) };
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

describe("watch failures through the production server", () => {
  test("reports failed watches, clears disposed watches, and recovers when watcher slots return", async () => {
    const { server, registry, freeWatcherSlots } = await startServerWithFailingWatches();
    const client = clientFor(server);
    // Subscribing is what starts each store's watchers, as the settings, drafts, sessions, extensions and
    // rules screens do when they open.
    const subscriptions = await Promise.all([
      client.subscribe(ConfigStore, "changed", { scope: "global" }),
      client.subscribe(DraftStore, "changed", { scope: "thread:thread-watch" }),
      client.subscribe(SessionPinStore, "changed"),
      client.subscribe(ExtensionCatalog, "changed"),
      client.subscribe(RuleStore, "changed", { scope: "global" }),
    ]);

    const health = await client.port(AppPort).health({});
    expect(health).toMatchObject({ status: "degraded", code: "watch_limited" });
    expect(health.detail).toContain("omp app can't watch some of its files for changes");

    const failing = registry.failingPaths();
    expect(failing.some((path) => path.endsWith("config.yml"))).toBe(true);
    expect(failing.some((path) => path.includes("extensions"))).toBe(true);
    expect(failing.some((path) => path.includes("rules"))).toBe(true);
    expect(failing.some((path) => path.endsWith("session-pins.json"))).toBe(true);
    expect(failing.some((path) => path.includes("drafts"))).toBe(true);
    const draftSubscription = subscriptions[1];
    await draftSubscription.unsubscribe();
    expect(registry.failingPaths().some((path) => path.includes("drafts"))).toBe(false);

    freeWatcherSlots();
    let recoveredHealth = await client.port(AppPort).health({});
    // A1's watcher retries every 1000 ms by default (`file-watcher.ts:94`), so this production check uses its real timer.
    for (let attempt = 0; attempt < 50 && recoveredHealth.status !== "ok"; attempt += 1) {
      await Bun.sleep(100);
      recoveredHealth = await client.port(AppPort).health({});
    }
    expect(recoveredHealth).toEqual({ status: "ok" });
    expect(registry.failingPaths()).toEqual([]);

    for (const [index, subscription] of subscriptions.entries()) {
      if (index !== 1) await subscription.unsubscribe();
    }
    client.dispose();
  }, 60_000);
});

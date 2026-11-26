import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { EdgeRelay } from "../browser/edge-relay";
import { openDevicePairing } from "../devices";
import { createAppServer } from "../server";
import { startRelayCarrier } from "./relay-carrier";

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

const EXTENSION = `chrome-extension://${"a".repeat(32)}`;

const until = async (what: string, check: () => Promise<boolean> | boolean): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`never: ${what}`);
};

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const each of cleanup.splice(0).reverse()) await each();
});

test("omp-app relay pairs once with a code, carries the browser's extension to the app's relay, refuses web pages, and stops when its device is removed", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omp-app-relay-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const devices = await openDevicePairing({ appDataDir: folder });
  // omp's discovery in memory: the real one writes under the user's `~/.omp`.
  const relay = new EdgeRelay({
    port: freePort(),
    discovery: { publish: async () => async () => undefined, endpoints: () => [] },
  });
  cleanup.push(() => relay.stop());
  const app = createAppServer({
    port: 0,
    uiRoot: `${import.meta.dir}/../test-fixtures/ui`,
    devices,
    browserRelay: relay,
  });
  cleanup.push(() => app.stop());
  await relay.ensure();

  const said: string[] = [];
  const keysFile = join(folder, "state", "relay-keys.json");
  const start = (code: string | undefined) =>
    startRelayCarrier({
      server: app.url,
      port: freePort(),
      keysFile,
      name: "Browser relay on test",
      code,
      askCode: async () => {
        throw new Error("a paired carrier does not ask for a code");
      },
      say: (line) => said.push(line),
      // No relay of omp's native host on this computer: the user's own `~/.omp` is not read.
      endpoints: () => [],
    });
  const code = devices.desk.newCode().code;
  expect(await start("WRONG1")).toStartWith("Not paired: that code is not right");
  const carrier = await start(code);
  if (typeof carrier === "string") throw new Error(carrier);
  cleanup.push(() => carrier.stop());
  // A device of its own, listed as a browser relay; its key kept for the next start, readable by this account only.
  expect(devices.store.list()).toMatchObject([
    { name: "Browser relay on test", kind: "browser-relay" },
  ]);
  expect(Object.keys(JSON.parse(await readFile(keysFile, "utf8")))).toEqual([app.url]);
  // Unix modes only: Windows keeps it in the account's own profile folder instead.
  if (process.platform !== "win32") {
    expect((await Bun.file(keysFile).stat()).mode & 0o777).toBe(0o600);
  }

  // A web page cannot use it: only a browser extension's socket is carried.
  const page = await fetch(`http://127.0.0.1:${carrier.port}/ext`, {
    headers: { origin: "https://example.com", upgrade: "websocket", connection: "Upgrade" },
  });
  expect(page.status).toBe(403);

  // The extension connects on this computer, and the app's relay sees the browser.
  const extension = new WebSocket(`ws://127.0.0.1:${carrier.port}/ext`, {
    headers: { Origin: EXTENSION },
  } as unknown as string[]);
  await new Promise((opened) => {
    extension.onopen = opened;
  });
  extension.send(
    JSON.stringify({
      t: "hello",
      userAgent: "Test",
      browserVersion: "TestBrowser/1",
      tabs: [],
      attachedTabIds: [],
    }),
  );
  await until("the browser reaches the app's relay", async () => (await relay.refresh()).connected);
  expect(relay.state().carried).toBe(true);

  // Removed in Devices: its connection ends, the carrier stops and says why, and forgets the key.
  const [device] = devices.store.list();
  await devices.store.remove(device?.id ?? "");
  expect(await carrier.done).toContain("no longer paired");
  await until("the key is forgotten", async () => {
    const left = JSON.parse(await readFile(keysFile, "utf8")) as Record<string, unknown>;
    return Object.keys(left).length === 0;
  });
});

test("omp-app relay links the relay omp 19.1's native host serves on its computer: the app's chats reach the browser through a proxy published on the app's computer, while the browser runs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omp-app-relay-native-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const devices = await openDevicePairing({ appDataDir: folder });
  // The app's computer: omp's discovery in memory, as its chats read it.
  const published: number[] = [];
  const relay = new EdgeRelay({
    port: freePort(),
    discovery: {
      publish: async (port) => {
        published.unshift(port);
        return async () => {
          published.splice(published.indexOf(port), 1);
        };
      },
      endpoints: () => published.map((port) => `http://127.0.0.1:${port}`),
    },
  });
  cleanup.push(() => relay.stop());
  const app = createAppServer({
    port: 0,
    uiRoot: `${import.meta.dir}/../test-fixtures/ui`,
    devices,
    browserRelay: relay,
  });
  cleanup.push(() => app.stop());
  await relay.ensure();

  // The browser's computer: omp 19.1.1's own relay server, as its native host runs it, with the browser's extension.
  const browserRelay = startRelayServer({ port: 0, group: false });
  cleanup.push(() => browserRelay.stop());
  const extension = new WebSocket(`ws://127.0.0.1:${browserRelay.port}/ext`, {
    headers: { Origin: EXTENSION },
  } as unknown as string[]);
  await new Promise((opened) => {
    extension.onopen = opened;
  });
  cleanup.push(() => extension.close());
  extension.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { t: string; id?: number };
    if (message.t === "rpc")
      extension.send(JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} }));
  };
  extension.send(
    JSON.stringify({
      t: "hello",
      userAgent: "Mozilla/5.0 Chrome/151.0.0.0",
      browserVersion: "Chrome/151.0",
      tabs: [
        {
          tabId: 7,
          url: "https://a.test/",
          title: "A page",
          active: true,
          discarded: false,
          windowId: 1,
          pinned: false,
          groupId: -1,
        },
      ],
      attachedTabIds: [],
      discardedTabsProtocol: 1,
      instanceId: "laptop-browser",
      browserSession: "run-1",
    }),
  );
  let browserRuns = true;
  const carrier = await startRelayCarrier({
    server: app.url,
    port: freePort(),
    keysFile: join(folder, "state", "relay-keys.json"),
    name: "Browser relay on test",
    code: devices.desk.newCode().code,
    askCode: async () => "",
    say: () => undefined,
    endpoints: () => (browserRuns ? [`http://127.0.0.1:${browserRelay.port}`] : []),
  });
  if (typeof carrier === "string") throw new Error(carrier);
  cleanup.push(() => carrier.stop());

  // The browser shows in the app, carried, with its tab; its proxy is what the chats find.
  await until("the browser reaches the app", async () => (await relay.refresh()).connected);
  expect(relay.state()).toMatchObject({
    carried: true,
    browser: "Chrome/151.0",
    tabs: [{ url: "https://a.test/", title: "A page" }],
  });
  await until("the chats find it", () => published.length === 1);
  const proxy = `127.0.0.1:${published[0]}`;

  // As a chat reads it: the relay's socket address is the proxy's, not the browser computer's port.
  const version = (await (await fetch(`http://${proxy}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
    ompRelayVersion: string;
  };
  expect(version.webSocketDebuggerUrl).toBe(`ws://${proxy}/cdp`);
  expect(version.ompRelayVersion).toBe("19.1.1");
  // A web page cannot use the proxy.
  expect(
    (await fetch(`http://${proxy}/json/version`, { headers: { origin: "https://example.com" } }))
      .status,
  ).toBe(403);

  // A CDP client on the app's computer drives the browser through the proxy and the carrier.
  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  const answer = new Promise<{ id: number; result?: { targetInfos?: { url: string }[] } }>(
    (got) => {
      cdp.onmessage = (event) => got(JSON.parse(String(event.data)));
    },
  );
  await new Promise((opened) => {
    cdp.onopen = opened;
  });
  cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
  const targets = await answer;
  expect(targets.id).toBe(1);
  expect(targets.result?.targetInfos?.map((target) => target.url)).toContain("https://a.test/");
  cdp.close();

  // The browser quits: its relay is no longer published here, the link ends, and the proxy is withdrawn.
  browserRuns = false;
  await until("the proxy is withdrawn", () => published.length === 0);
  expect((await relay.refresh()).carried).toBe(false);
});

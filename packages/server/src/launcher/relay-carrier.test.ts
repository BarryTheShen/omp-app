import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const relay = new EdgeRelay({ port: freePort() });
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
  expect((await Bun.file(keysFile).stat()).mode & 0o777).toBe(0o600);

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

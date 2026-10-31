/**
 * Device pairing through a running server: the `/pair/*` routes as a new device's page and `omp-app pair` call them, and
 * a paired device signing in on the WebSocket with its key's cookie.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEVICE_COOKIE, PAIRING_PATHS } from "@omp-app/contracts";
import { type AppServer, createAppServer } from "../server";
import { type DevicePairing, openDevicePairing } from "./index";

const DATA = join(import.meta.dir, "../../../../.data");
const FIXTURES = new URL("../test-fixtures", import.meta.url).pathname;
const REMOTE = { origin: "https://devbox.tail1234.ts.net", host: "devbox.tail1234.ts.net" };
const roots: string[] = [];
const apps: AppServer[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function serve(): Promise<{ app: AppServer; pairing: DevicePairing; origin: string }> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "pairing-"));
  roots.push(root);
  const pairing = await openDevicePairing({ appDataDir: root });
  const app = createAppServer({
    port: 0,
    token: "launch-token",
    staticRoot: FIXTURES,
    uiRoot: `${FIXTURES}/ui`,
    remote: REMOTE,
    devices: pairing,
  });
  apps.push(app);
  return { app, pairing, origin: app.url };
}

/** A request from one of the app's pages: its own origin, or the Tailscale address through `tailscale serve`. */
function post(
  app: AppServer,
  path: string,
  body: unknown,
  from: "page" | "https" | "elsewhere" = "page",
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (from === "page") headers.origin = app.url;
  if (from === "https") {
    headers.origin = REMOTE.origin;
    headers.host = REMOTE.host;
  }
  if (from === "elsewhere") headers.origin = "https://evil.example";
  return fetch(`${app.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const keyOf = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").match(new RegExp(`${DEVICE_COOKIE}=([^;]+)`))?.[1] ??
  "";

/** Opens the WebSocket as a page would, and resolves with its welcome or its close. */
function connect(
  app: AppServer,
  options: { readonly key?: string; readonly token?: string },
): Promise<{ welcome: boolean; code?: number; reason?: string; socket: WebSocket }> {
  const headers: Record<string, string> = { origin: app.url };
  if (options.key !== undefined) headers.cookie = `${DEVICE_COOKIE}=${options.key}`;
  const url = `${app.url.replace("http", "ws")}/ws${options.token === undefined ? "" : `?token=${options.token}`}`;
  const socket = new WebSocket(url, { headers });
  return new Promise((resolve) => {
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "hello",
          protocols: ["omp-app/1"],
          client: { name: "test-client", version: "1.0.0" },
        }),
      );
    socket.onmessage = (event) => {
      if (String(event.data).includes('"welcome"')) resolve({ welcome: true, socket });
    };
    socket.onclose = (event) =>
      resolve({ welcome: false, code: event.code, reason: event.reason, socket });
  });
}

describe("device pairing on a running server", () => {
  test("a device asks, a paired device allows it, and it signs in with its key's cookie and nothing else", async () => {
    const { app, pairing } = await serve();
    const asked = await post(app, PAIRING_PATHS.ask, { name: "Laptop", kind: "browser" });
    expect(asked.status).toBe(200);
    const { requestId, code } = (await asked.json()) as { requestId: string; code: string };
    expect(code).toMatch(/^\d{6}$/);
    expect(await (await post(app, PAIRING_PATHS.claim, { requestId })).json()).toEqual({
      status: "waiting",
    });

    expect(pairing.desk.allow(pairing.desk.waiting()[0]?.id ?? "")).toBe(true);
    const claimed = await post(app, PAIRING_PATHS.claim, { requestId });
    const body = (await claimed.json()) as { status: string; deviceId: string };
    expect(body.status).toBe("paired");
    const cookie = claimed.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Plain HTTP on the loopback address: a Secure cookie would not be kept there.
    expect(cookie).not.toContain("Secure");

    const signedIn = await connect(app, { key: keyOf(claimed) });
    expect(signedIn.welcome).toBe(true);
    signedIn.socket.close();
    expect(pairing.connections.deviceOf("none")).toBeNull();

    const stranger = await connect(app, {});
    expect(stranger).toMatchObject({ welcome: false, code: 4401, reason: "not paired" });
    // The launch link still opens the app.
    const linked = await connect(app, { token: "launch-token" });
    expect(linked.welcome).toBe(true);
    linked.socket.close();
  });

  test("over HTTPS the key's cookie is Secure", async () => {
    const { app, pairing } = await serve();
    const { requestId } = (await (
      await post(app, PAIRING_PATHS.ask, { name: "iPhone", kind: "home-screen-app" }, "https")
    ).json()) as { requestId: string };
    pairing.desk.allow(pairing.desk.waiting()[0]?.id ?? "");
    const claimed = await post(app, PAIRING_PATHS.claim, { requestId }, "https");
    expect(claimed.headers.get("set-cookie") ?? "").toContain("Secure");
  });

  test("a one-time code pairs once; a turned-down request and a wrong code pair nothing", async () => {
    const { app, pairing } = await serve();
    const { code } = pairing.desk.newCode();
    const entered = await post(app, PAIRING_PATHS.code, {
      code,
      name: "iPhone",
      kind: "home-screen-app",
    });
    expect(((await entered.json()) as { status: string }).status).toBe("paired");
    expect(keyOf(entered)).not.toBe("");
    const again = await post(app, PAIRING_PATHS.code, { code, name: "Other", kind: "browser" });
    expect(await again.json()).toEqual({ status: "expired" });
    expect(again.headers.get("set-cookie")).toBeNull();

    const { requestId } = (await (
      await post(app, PAIRING_PATHS.ask, { name: "Tablet", kind: "browser" })
    ).json()) as { requestId: string };
    pairing.desk.deny(pairing.desk.waiting()[0]?.id ?? "");
    const denied = await post(app, PAIRING_PATHS.claim, { requestId });
    expect(await denied.json()).toEqual({ status: "denied" });
    expect(pairing.store.list().map((device) => device.name)).toEqual(["iPhone"]);
  });

  test("a removed device is disconnected at once and refused afterwards", async () => {
    const { app, pairing } = await serve();
    const { code } = pairing.desk.newCode();
    const entered = await post(app, PAIRING_PATHS.code, {
      code,
      name: "Lost phone",
      kind: "browser",
    });
    const { deviceId } = (await entered.json()) as { deviceId: string };
    const key = keyOf(entered);
    const open = await connect(app, { key });
    expect(open.welcome).toBe(true);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      open.socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    expect(await pairing.store.remove(deviceId)).toBe(true);
    expect(await closed).toEqual({ code: 4401, reason: "not paired" });
    expect(await connect(app, { key })).toMatchObject({ welcome: false, code: 4401 });
  });

  test("a page with the launch link at the Tailscale address becomes a device once, and then signs in as it", async () => {
    const { app, pairing } = await serve();
    const phone = { name: "iPhone", kind: "home-screen-app" };
    const bearer = { authorization: "Bearer launch-token" };
    // Pages on this computer keep the link, and a page without the token adopts nothing.
    expect((await post(app, PAIRING_PATHS.adopt, phone, "page", bearer)).status).toBe(403);
    expect((await post(app, PAIRING_PATHS.adopt, phone, "https")).status).toBe(401);
    const wrong = { authorization: "Bearer not-the-token" };
    expect((await post(app, PAIRING_PATHS.adopt, phone, "https", wrong)).status).toBe(401);
    expect(pairing.store.list()).toHaveLength(0);

    const adopted = await post(app, PAIRING_PATHS.adopt, phone, "https", bearer);
    const { deviceId } = (await adopted.json()) as { deviceId: string };
    expect(adopted.headers.get("set-cookie") ?? "").toContain("Secure");
    const key = keyOf(adopted);
    const withKey = { ...bearer, cookie: `${DEVICE_COOKIE}=${key}` };
    expect(await (await post(app, PAIRING_PATHS.adopt, phone, "https", withKey)).json()).toEqual({
      deviceId,
    });
    expect(pairing.store.list().map((device) => [device.id, device.name])).toEqual([
      [deviceId, "iPhone"],
    ]);

    // With its key and the link, the page is the device: removing it closes the page.
    const open = await connect(app, { key, token: "launch-token" });
    expect(open.welcome).toBe(true);
    const closed = new Promise<number>((resolve) => {
      open.socket.onclose = (event) => resolve(event.code);
    });
    expect(await pairing.store.remove(deviceId)).toBe(true);
    expect(await closed).toBe(4401);
  });

  test("the routes take only the app's own pages, and the server's own routes only the launch token from this computer", async () => {
    const { app } = await serve();
    expect(
      (await post(app, PAIRING_PATHS.ask, { name: "X", kind: "browser" }, "elsewhere")).status,
    ).toBe(403);
    expect((await fetch(`${app.url}${PAIRING_PATHS.newCode}`, { method: "POST" })).status).toBe(
      401,
    );
    const bearer = { authorization: "Bearer launch-token" };
    expect(
      (
        await fetch(`${app.url}${PAIRING_PATHS.newCode}`, {
          method: "POST",
          headers: { ...bearer, origin: app.url },
        })
      ).status,
    ).toBe(403);
    const made = await fetch(`${app.url}${PAIRING_PATHS.newCode}`, {
      method: "POST",
      headers: bearer,
    });
    expect(await made.json()).toMatchObject({
      code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/),
      address: REMOTE.origin,
    });
    const listed = await fetch(`${app.url}${PAIRING_PATHS.devices}`, { headers: bearer });
    expect(await listed.json()).toEqual({ devices: [], requests: [] });
  });

  test("the page a paired device loads sets its key's cookie again; another page's load sets none", async () => {
    const { app, pairing } = await serve();
    const { code } = pairing.desk.newCode();
    const key = keyOf(
      await post(app, PAIRING_PATHS.code, { code, name: "Laptop", kind: "browser" }),
    );
    const page = await fetch(`${app.url}/`, { headers: { cookie: `${DEVICE_COOKIE}=${key}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie") ?? "").toContain(`${DEVICE_COOKIE}=${key}`);
    const other = await fetch(`${app.url}/`);
    expect(other.headers.get("set-cookie")).toBeNull();
  });
});

/**
 * Device pairing through a running server: the `/pair/*` routes as a new device's page and `omp-app pair` call them, and
 * a paired device signing in on the WebSocket with its key's cookie, or a panel with its key in the socket's protocols.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEVICE_COOKIE,
  PAIRING_PATHS,
  SOCKET_DEVICE_PROTOCOL_PREFIX,
  SOCKET_PROTOCOL,
} from "@omp-app/contracts";
import { type AppServer, createAppServer } from "../server";
import {
  createMachineNames,
  type DevicePairing,
  type MachineNamer,
  openDevicePairing,
} from "./index";

const DATA = join(import.meta.dir, "../../../../.data");
const FIXTURES = new URL("../test-fixtures", import.meta.url).pathname;
const REMOTE = { origin: "https://devbox.tail1234.ts.net", host: "devbox.tail1234.ts.net" };
const roots: string[] = [];
const apps: AppServer[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function serve(
  machineOf?: MachineNamer,
): Promise<{ app: AppServer; pairing: DevicePairing; origin: string }> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "pairing-"));
  roots.push(root);
  const pairing = await openDevicePairing({ appDataDir: root });
  const app = createAppServer({
    port: 0,
    token: "launch-token",
    uiRoot: `${FIXTURES}/ui`,
    remote: REMOTE,
    devices: pairing,
    ...(machineOf === undefined ? {} : { machineOf }),
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
  more: Record<string, string> = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json", ...more };
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

/**
 * Opens the WebSocket as a page would (its own origin, or the Tailscale address), and resolves with its welcome or its
 * close, and the protocol the server named back. `offered`: a panel's key in the socket's protocols; `protocols`: the
 * exact list offered instead; `device`: the key in the address, as a panel loaded before the key moved to the protocols
 * sends it.
 */
function connect(
  app: AppServer,
  options: {
    readonly key?: string;
    readonly token?: string;
    readonly device?: string;
    readonly offered?: string;
    readonly protocols?: readonly string[];
    readonly from?: "page" | "https";
  },
): Promise<{
  welcome: boolean;
  protocol: string;
  code?: number;
  reason?: string;
  socket: WebSocket;
}> {
  const headers: Record<string, string> =
    options.from === "https" ? { origin: REMOTE.origin, host: REMOTE.host } : { origin: app.url };
  if (options.key !== undefined) headers.cookie = `${DEVICE_COOKIE}=${options.key}`;
  const query = new URLSearchParams({
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.device === undefined ? {} : { device: options.device }),
  }).toString();
  const url = `${app.url.replace("http", "ws")}/ws${query === "" ? "" : `?${query}`}`;
  const protocols =
    options.protocols ??
    (options.offered === undefined
      ? undefined
      : [SOCKET_PROTOCOL, `${SOCKET_DEVICE_PROTOCOL_PREFIX}${options.offered}`]);
  const socket = new WebSocket(url, {
    headers,
    ...(protocols === undefined ? {} : { protocols: [...protocols] }),
  });
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
      if (String(event.data).includes('"welcome"'))
        resolve({ welcome: true, protocol: socket.protocol, socket });
    };
    socket.onclose = (event) =>
      resolve({
        welcome: false,
        protocol: socket.protocol,
        code: event.code,
        reason: event.reason,
        socket,
      });
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

  test("a panel whose host keeps its key gets it in the answer, and signs in with it in the socket's protocols, which the server names back; others get none", async () => {
    const { app, pairing } = await serve();
    const asked = (await (
      await post(app, PAIRING_PATHS.ask, { name: "Zen panel", kind: "browser" }, "https")
    ).json()) as { requestId: string };
    pairing.desk.allow(pairing.desk.waiting()[0]?.id ?? "");
    const claimed = (await (
      await post(app, PAIRING_PATHS.claim, { requestId: asked.requestId, keep: "host" }, "https")
    ).json()) as { status: string; key?: string };
    expect(claimed.status).toBe("paired");
    expect(claimed.key).toMatch(/.{20,}/);

    // Through the Tailscale address, where the launch link opens nothing: the key alone signs the panel in, and the
    // server names the app's protocol back, which the browser requires of a socket that offered protocols.
    const signedIn = await connect(app, { offered: claimed.key ?? "", from: "https" });
    expect(signedIn).toMatchObject({ welcome: true, protocol: SOCKET_PROTOCOL });
    signedIn.socket.close();
    // A panel loaded before the key moved to the protocols sends it in the address; nothing is named back to it.
    const before = await connect(app, { device: claimed.key ?? "", from: "https" });
    expect(before).toMatchObject({ welcome: true, protocol: "" });
    before.socket.close();
    const wrong = await connect(app, { offered: "not-a-key", from: "https" });
    expect(wrong).toMatchObject({ welcome: false, code: 4401, reason: "not paired" });
    // A stale cookie hides no valid key after it.
    const stale = await connect(app, {
      key: "s".repeat(43),
      offered: claimed.key ?? "",
      from: "https",
    });
    expect(stale).toMatchObject({ welcome: true, protocol: SOCKET_PROTOCOL });
    stale.socket.close();
    // A socket that offers protocols but not the app's is refused before it opens: the server never names the key's
    // protocol back.
    const foreign = await connect(app, {
      protocols: [`${SOCKET_DEVICE_PROTOCOL_PREFIX}${claimed.key ?? ""}`],
      from: "https",
    });
    expect(foreign).toMatchObject({ welcome: false, protocol: "" });

    // A one-time code with no `keep`: the key goes as the cookie only.
    const { code } = pairing.desk.newCode();
    const entered = (await (
      await post(app, PAIRING_PATHS.code, { code, name: "Phone", kind: "browser" }, "https")
    ).json()) as { status: string; deviceId?: string; key?: string };
    expect(entered).toEqual({ status: "paired", deviceId: expect.any(String) });
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

  test("the launch link signs in on this computer only: a page at the Tailscale address pairs", async () => {
    const { app, pairing } = await serve();
    const linked = await connect(app, { token: "launch-token" });
    expect(linked.welcome).toBe(true);
    linked.socket.close();
    expect(await connect(app, { token: "launch-token", from: "https" })).toMatchObject({
      welcome: false,
      code: 4401,
      reason: "not paired",
    });

    // Paired, the page there is its device, whatever old token it still sends: removing it closes the page.
    const { code } = pairing.desk.newCode();
    const entered = await post(
      app,
      PAIRING_PATHS.code,
      { code, name: "iPhone", kind: "home-screen-app" },
      "https",
    );
    const { deviceId } = (await entered.json()) as { deviceId: string };
    const open = await connect(app, { key: keyOf(entered), token: "launch-token", from: "https" });
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

  test("the machine route names the computer a page is on, to the app's own pages and by POST only", async () => {
    const { app } = await serve(
      createMachineNames({
        whois: async (ip) => (ip === "100.64.1.2" ? "my-phone" : undefined),
        hostname: () => "my-laptop",
      }),
    );
    // A page on the server's computer: no proxy marked it, so the server's own name.
    const here = await post(app, PAIRING_PATHS.machine, undefined);
    expect(here.status).toBe(200);
    expect(await here.json()).toEqual({ machine: "my-laptop" });
    // A page through Tailscale Serve: the address it marked the request with names the computer.
    const there = await post(app, PAIRING_PATHS.machine, undefined, "https", {
      "x-forwarded-for": "100.64.1.2, 10.0.0.1",
    });
    expect(await there.json()).toEqual({ machine: "my-phone" });
    const unknown = await post(app, PAIRING_PATHS.machine, undefined, "https", {
      "x-forwarded-for": "198.51.100.7",
    });
    expect(await unknown.json()).toEqual({ machine: null });

    // Only the app's own pages ask, and only by POST.
    expect((await post(app, PAIRING_PATHS.machine, undefined, "elsewhere")).status).toBe(403);
    expect((await fetch(`${app.url}${PAIRING_PATHS.machine}`, { method: "POST" })).status).toBe(
      403,
    );
    const got = await fetch(`${app.url}${PAIRING_PATHS.machine}`, {
      headers: { origin: app.url },
    });
    expect(got.status).toBe(405);
  });

  test("without a way to name computers, the machine route answers null", async () => {
    const { app } = await serve();
    const answer = await post(app, PAIRING_PATHS.machine, undefined);
    expect(await answer.json()).toEqual({ machine: null });
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

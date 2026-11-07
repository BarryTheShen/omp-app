import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_COOKIE, SHARE_COOKIE_PREFIX } from "@omp-app/contracts";
import { type Gate, openGate } from "./gate";

const stops: (() => void)[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** A service on this machine, by its port: it echoes what it was sent, sets cookies, redirects to itself, and echoes
 * WebSockets. */
function service(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      const url = new URL(request.url);
      if (url.pathname === "/ws" && self.upgrade(request)) return undefined;
      if (url.pathname === "/set")
        return new Response("set", {
          headers: [
            ["set-cookie", `${DEVICE_COOKIE}=stolen; Path=/`],
            ["set-cookie", `${SHARE_COOKIE_PREFIX}other=x; Path=/`],
            ["set-cookie", "theme=dark; Path=/"],
          ],
        });
      if (url.pathname === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { location: `http://localhost:${self.port}/after?x=1` },
        });
      return new Response("hello from the service", {
        headers: {
          "x-seen-cookie": request.headers.get("cookie") ?? "",
          "x-seen-host": request.headers.get("host") ?? "",
          "x-seen-origin": request.headers.get("origin") ?? "",
        },
      });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  stops.push(() => server.stop(true));
  if (server.port === undefined) throw new Error("no port");
  return server.port;
}

async function gateFor(
  target: Parameters<typeof openGate>[0]["target"],
  now?: () => number,
): Promise<Gate> {
  const gate = await openGate({
    shareId: "s1",
    address: "127.0.0.1",
    port: 0,
    target,
    reserved: [DEVICE_COOKIE],
    ...(now === undefined ? {} : { now }),
  });
  stops.push(() => gate.stop());
  return gate;
}

/** Opens a ticket the way a browser does and returns the cookie it gives. */
async function signIn(gate: Gate): Promise<string> {
  const entered = await fetch(gate.ticket("device-1", "Phone"), { redirect: "manual" });
  expect(entered.status).toBe(303);
  const cookie = entered.headers.getSetCookie()[0] ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  return cookie.slice(0, cookie.indexOf(";"));
}

describe("a share's gate (#2788)", () => {
  test("nothing passes without the cookie a ticket gives, and a ticket counts once", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const bare = await fetch(gate.url);
    expect(bare.status).toBe(403);
    expect(await bare.text()).toContain("Open this from the app");
    const ticket = gate.ticket("device-1", "Phone");
    expect((await fetch(ticket, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(ticket, { redirect: "manual" })).status).toBe(403);
    expect(gate.openedBy()).toEqual(["Phone"]);
  });

  test("a ticket more than a minute old is refused", async () => {
    const upstream = service();
    let time = 1_000_000;
    const gate = await gateFor(
      { kind: "service", port: upstream, address: "127.0.0.1" },
      () => time,
    );
    const ticket = gate.ticket("device-1", "Phone");
    time += 61_000;
    expect((await fetch(ticket, { redirect: "manual" })).status).toBe(403);
  });

  test("the service gets its own host and none of the app's cookies, and sets none of them", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    const shown = await fetch(gate.url, {
      headers: { cookie: `${cookie}; ${DEVICE_COOKIE}=secret-key; theme=light` },
    });
    expect(shown.status).toBe(200);
    expect(await shown.text()).toBe("hello from the service");
    expect(shown.headers.get("x-seen-cookie")).toBe("theme=light");
    expect(shown.headers.get("x-seen-host")).toBe(`localhost:${upstream}`);
    const set = await fetch(`${gate.url}set`, { headers: { cookie } });
    expect(set.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
  });

  test("a redirect to the service's own local address stays inside the share", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    const moved = await fetch(`${gate.url}redirect`, { headers: { cookie }, redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/after?x=1");
  });

  test("a removed device's sessions end", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    gate.forget("device-1");
    expect((await fetch(gate.url, { headers: { cookie } })).status).toBe(403);
  });

  test("a page's files come from its folder only: not above it, not through a link, and none of its hidden files", async () => {
    const base = await mkdtemp(join(tmpdir(), "omp-app-page-"));
    folders.push(base);
    const root = join(base, "guide");
    await mkdir(join(root, "css"), { recursive: true });
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "exam.html"), "<h1>Exam guide</h1>");
    await writeFile(join(root, "css/site.css"), "h1 { color: red }");
    await writeFile(join(root, ".env"), "TOKEN=not-for-the-page");
    await writeFile(join(root, ".git/config"), "[core]");
    await writeFile(join(base, "secret.txt"), "not for the page");
    await symlink(join(base, "secret.txt"), join(root, "link.txt"));
    const gate = await gateFor({ kind: "page", root, entry: "exam.html" });
    const entered = await fetch(gate.ticket(null, "this computer"), { redirect: "manual" });
    expect(entered.headers.get("location")).toBe("/exam.html");
    const cookie = (entered.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const get = (path: string) => fetch(`${gate.url.slice(0, -1)}${path}`, { headers: { cookie } });
    expect(await (await get("/exam.html")).text()).toBe("<h1>Exam guide</h1>");
    expect((await get("/css/site.css")).status).toBe(200);
    expect((await get("/%2e%2e/secret.txt")).status).toBe(404);
    expect((await get("/..%2fsecret.txt")).status).toBe(404);
    expect((await get("/link.txt")).status).toBe(404);
    expect((await get("/.env")).status).toBe(404);
    expect((await get("/.git/config")).status).toBe(404);
    expect((await get("/css/%2e%2e/.env")).status).toBe(404);
  });

  test("a WebSocket passes both ways once signed in", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    const socket = new WebSocket(`${gate.url.replace("http", "ws")}ws`, {
      headers: { cookie },
    } as unknown as string[]);
    const echoed = await new Promise<string>((done, fail) => {
      socket.onopen = () => socket.send("ping through the gate");
      socket.onmessage = (event) => done(String(event.data));
      socket.onerror = () => fail(new Error("socket failed"));
      setTimeout(() => fail(new Error("no echo")), 5_000);
    });
    socket.close();
    expect(echoed).toBe("ping through the gate");
  });

  test("another page's request is refused and a link followed from anywhere opens; the share's own pages are the service's", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    const own = gate.url.slice(0, -1);
    const send = (method: "GET" | "POST", headers: Record<string, string>) =>
      fetch(gate.url, {
        method,
        headers: { cookie, ...headers },
        ...(method === "POST" ? { body: "x" } : {}),
      });
    // Another share on this address differs only by port, the same site to a browser: its pages' requests carry this
    // share's cookie.
    const elsewhere = "http://127.0.0.1:1";
    expect(
      (
        await send("POST", {
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "cors",
          origin: elsewhere,
        })
      ).status,
    ).toBe(403);
    expect(
      (await send("GET", { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" })).status,
    ).toBe(403);
    // A browser without Fetch Metadata: its Origin tells.
    expect((await send("POST", { origin: elsewhere })).status).toBe(403);
    // A link followed from another page, or an address typed in, opens the share.
    expect(
      (await send("GET", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status,
    ).toBe(200);
    expect(
      (await send("GET", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).status,
    ).toBe(200);
    // The share's own page reaches the service as one of the service's own.
    const posted = await send("POST", {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      origin: own,
    });
    expect(posted.status).toBe(200);
    expect(posted.headers.get("x-seen-origin")).toBe(`http://localhost:${upstream}`);
    // Any other Origin goes on as it came, for the service to judge.
    const other = await send("GET", { origin: "http://elsewhere.example" });
    expect(other.headers.get("x-seen-origin")).toBe("http://elsewhere.example");
  });

  test("a WebSocket opens from the share's own pages only", async () => {
    const upstream = service();
    const gate = await gateFor({ kind: "service", port: upstream, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    const opens = (origin: string) =>
      new Promise<boolean>((done) => {
        const socket = new WebSocket(`${gate.url.replace("http", "ws")}ws`, {
          headers: { cookie, origin },
        } as unknown as string[]);
        // Resolved first: Bun calls `onclose` inside `close()`.
        socket.onopen = () => {
          done(true);
          socket.close();
        };
        socket.onerror = () => done(false);
        socket.onclose = () => done(false);
      });
    expect(await opens(gate.url.slice(0, -1))).toBe(true);
    expect(await opens("http://127.0.0.1:1")).toBe(false);
  });

  test("a reply sent without a type gets the one a browser would give it, so a page shows instead of downloading", async () => {
    // node:http sends no type unless told to, as many small services do; Bun.serve would send such a reply as a download.
    const plain = createServer((request, response) => {
      if (request.url === "/typed") {
        response.setHeader("content-type", "application/json");
        response.end("{}");
      } else if (request.url === "/streamed") {
        response.write("<!doctype html><p>first");
        setTimeout(() => response.end(" and second</p>"), 20);
      } else if (request.url === "/nothing") {
        response.statusCode = 204;
        response.end();
      } else if (request.url === "/words" || request.url === "/style") response.end("body { }");
      else response.end("<!doctype html><h1>A page</h1>");
    });
    await new Promise<void>((done) => plain.listen(0, "127.0.0.1", done));
    stops.push(() => {
      plain.closeAllConnections();
      plain.close();
    });
    const port = (plain.address() as AddressInfo).port;
    const gate = await gateFor({ kind: "service", port, address: "127.0.0.1" });
    const cookie = await signIn(gate);
    const get = (path: string, destination = "document") =>
      fetch(`${gate.url.slice(0, -1)}${path}`, {
        headers: { cookie, "sec-fetch-dest": destination },
      });

    const shown = await get("/");
    expect(shown.headers.get("content-type")).toBe("text/html");
    expect(await shown.text()).toBe("<!doctype html><h1>A page</h1>");
    // Sniffed from what came first, and given on whole.
    const streamed = await get("/streamed");
    expect(streamed.headers.get("content-type")).toBe("text/html");
    expect(await streamed.text()).toBe("<!doctype html><p>first and second</p>");
    expect((await get("/words")).headers.get("content-type")).toBe("text/plain");
    // A stylesheet sniffed as text would be refused: it gets its own type.
    const style = await get("/style", "style");
    expect(style.headers.get("content-type")).toBe("text/css");
    expect(await style.text()).toBe("body { }");
    const typed = await get("/typed");
    expect(typed.headers.get("content-type")).toBe("application/json");
    expect(await typed.text()).toBe("{}");
    const nothing = await get("/nothing");
    expect(nothing.status).toBe(204);
    expect(nothing.headers.get("content-type")).toBeNull();
  });
});

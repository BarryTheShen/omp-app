import { afterEach, expect, test } from "bun:test";
import { createAppServer } from "../server";
import { EdgeRelay, type RelayDiscovery } from "./edge-relay";

/** A port nothing listens on now. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** The address the app's pages are at in these tests: a carrier names its server's own address as its Origin. */
const ORIGIN = "http://allowed.test";

/** A socket as a carrier opens it, or as another program on the computer would (`origin: null`). */
function open(url: string, origin: string | null = ORIGIN): WebSocket {
  return new WebSocket(
    url,
    (origin === null ? {} : { headers: { Origin: origin } }) as unknown as string[],
  );
}

/**
 * How a WebSocket ended: "closed <code>", or "open" when it was still open half a second after opening (then it is
 * closed). The server turns a socket away just after it opens, with the reason's code.
 */
function outcome(url: string, origin: string | null = ORIGIN): Promise<string> {
  return new Promise((done) => {
    const socket = open(url, origin);
    socket.onopen = () =>
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        done("open");
        socket.close();
      }, 500);
    socket.onclose = (event) => done(`closed ${event.code}`);
  });
}

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

/** omp's discovery as the chats read it, in memory: the published ports, the newest first. */
function memoryDiscovery(): RelayDiscovery & { readonly published: number[] } {
  const published: number[] = [];
  return {
    published,
    publish: async (port) => {
      published.unshift(port);
      return async () => {
        published.splice(published.indexOf(port), 1);
      };
    },
    endpoints: () => published.map((port) => `http://127.0.0.1:${port}`),
  };
}

test("the app's relay takes a browser from another computer only through a carrier the app's server let in, and lists itself for the chats only while one is joined", async () => {
  const port = freePort();
  const discovery = memoryDiscovery();
  const relay = new EdgeRelay({ port, discovery });
  cleanup.push(() => relay.stop());
  const app = createAppServer({
    port: 0,
    uiRoot: `${import.meta.dir}/../test-fixtures/ui`,
    origins: [ORIGIN],
    browserRelay: relay,
  });
  cleanup.push(() => app.stop());
  const carrierUrl = `${app.url.replace("http:", "ws:")}/browser-relay?token=${app.token}`;

  // Not chosen: no relay, and a carrier is turned away with the reason.
  expect(await outcome(carrierUrl)).toBe("closed 4409");

  await relay.ensure();
  expect(relay.state().running).toBe(true);
  // Running but holding no browser, it is not offered to the chats: a browser on this computer has its own relay.
  expect(discovery.published).toEqual([]);
  // A carrier the app's server does not know is turned away.
  expect(await outcome(`${app.url.replace("http:", "ws:")}/browser-relay?token=wrong`)).toBe(
    "closed 4401",
  );

  // A carrier the server let in: the extension's hello reaches the relay, and the browser shows as connected.
  const carrier = open(carrierUrl);
  await new Promise((opened) => {
    carrier.onopen = opened;
  });
  carrier.send(
    JSON.stringify({
      t: "hello",
      userAgent: "Test",
      browserVersion: "TestBrowser/1",
      tabs: [],
      attachedTabIds: [],
    }),
  );
  await until("the browser connects", async () => (await relay.refresh()).connected);
  expect(relay.state()).toMatchObject({ running: true, connected: true, carried: true });
  await until("the chats find it", () => discovery.published.includes(port));

  // The carrier gone, the browser is gone too, and the chats no longer find the relay.
  carrier.close();
  await until("the browser leaves", async () => !(await relay.refresh()).connected);
  expect(relay.state().carried).toBe(false);
  await until("the chats lose it", () => !discovery.published.includes(port));
});

test("with no browser carried, the state is the relay a browser on this computer published, as the chats use it", async () => {
  const own = freePort();
  const discovery = memoryDiscovery();
  // omp's native host for a browser on this computer: a relay on a port of its own, with that browser connected.
  const local = freePort();
  const native = Bun.serve({
    port: local,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/json/version") return Response.json({ Browser: "Chrome/151.0" });
      if (path === "/json/list")
        return Response.json([{ id: "t1", type: "page", url: "https://a.test/", title: "A" }]);
      return new Response("Not found", { status: 404 });
    },
  });
  cleanup.push(() => native.stop(true));
  await discovery.publish(local);
  const relay = new EdgeRelay({ port: own, discovery });
  cleanup.push(() => relay.stop());
  await relay.ensure();
  expect(await relay.refresh()).toMatchObject({
    connected: true,
    browser: "Chrome/151.0",
    tabs: [{ id: "t1", url: "https://a.test/" }],
    carried: false,
  });
});

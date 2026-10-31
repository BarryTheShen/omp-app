import type { CapabilityMap as CapabilityMapType, ServerFrame } from "@omp-app/contracts";
import {
  APP_PROTOCOL,
  CapabilityMap,
  ServerFrame as ServerFrameSchema,
  WelcomeFrame as WelcomeFrameSchema,
} from "@omp-app/contracts";

import { type DevicePairing, deviceCookie, deviceKeyOf, pairingRoute } from "./devices";
import { Dispatcher, type DispatcherSession } from "./dispatcher";
import { launchTokenDigest } from "./launch-history";
import { newLaunchToken } from "./launch-token";
import type { Logger } from "./logging";
import type { PortRegistry } from "./registry/ports";
import { PORT_REGISTRY } from "./registry/ports";
import type { RemoteOrigin } from "./remote-origin";
import { EventReplayHub } from "./replay";

const DEFAULT_PORT = 4317;
const DEFAULT_SERVER_VERSION = "0.0.0";
const DEFAULT_REPLAY_LIMIT = 256;
/** The most `stop()` waits for Bun to finish closing connections. */
const STOP_WAIT_MS = 1_000;
/** How often connections whose socket closed unheard are looked for (`Dispatcher.sweep`). */
const SWEEP_MS = 60_000;
/** How much of a client's user agent the log keeps, to tell the desktop app, a browser and a phone apart. */
const CLIENT_CHARACTERS = 160;

export interface AppServerOptions {
  readonly port?: number;
  readonly token?: string;
  readonly origins?: readonly string[];
  /** The Tailscale address the app may also be opened from (`OMP_APP_REMOTE_ORIGIN`, see `remote-origin.ts`). */
  readonly remote?: RemoteOrigin;
  readonly instanceId?: string;
  readonly serverVersion?: string;
  readonly omp?: { readonly version: string } | null;
  readonly capabilities?: CapabilityMapType;
  readonly replayLimit?: number;
  readonly replay?: EventReplayHub;
  /** The old UI's built folder: served under `/old/` while it stays, and for any file the new UI does not have. */
  readonly staticRoot?: string;
  /** The new UI's built folder, served at the app's root (default: `apps/ui/dist` in the working folder). */
  readonly uiRoot?: string;
  readonly registry?: PortRegistry;
  /** Where connections and failed calls are recorded; nothing is logged without one. */
  readonly logger?: Logger;
  /** Digests (`launchTokenDigest`) of the launch tokens earlier starts printed: a link with one of them reads as expired, not as never printed. */
  readonly earlierLaunchTokens?: ReadonlySet<string>;
  /** Device pairing: a paired device signs in with its key's cookie, and `/pair/*` pairs new ones. */
  readonly devices?: DevicePairing;
}

export interface AppServer {
  readonly port: number;
  readonly token: string;
  readonly instanceId: string;
  readonly url: string;
  readonly dispatcher: Dispatcher;
  readonly publish: Dispatcher["publish"];
  stop(): Promise<void>;
}

export interface UpgradeClose {
  readonly closeCode: 4401 | 4403;
  readonly reason: "invalid token" | "expired token" | "origin not allowed" | "not paired";
}

/** A connection let in: with the launch link (no device), or as a paired device. */
export interface UpgradeAccepted {
  readonly deviceId: string | null;
}

export interface UpgradePolicy {
  readonly token: string;
  readonly origins?: readonly string[];
  readonly port: number;
  readonly earlierLaunchTokens?: ReadonlySet<string>;
  /** The Tailscale address allowed besides the loopback ones. */
  readonly remote?: RemoteOrigin;
  /** The paired device a key belongs to; absent when the server pairs no devices. */
  readonly deviceForKey?: (key: string) => string | undefined;
}

function requestedPort(options: AppServerOptions): number {
  const configured = options.port ?? Number(Bun.env.OMP_APP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
    throw new Error("OMP_APP_PORT must be an integer from 0 through 65535");
  }
  return configured;
}

function defaultOrigins(port: number): readonly string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

function originAllowed(origin: string | null, policy: UpgradePolicy): boolean {
  if (origin === null) return false;
  if (origin === policy.remote?.origin) return true;
  return (policy.origins ?? defaultOrigins(policy.port)).includes(origin);
}

function hostAllowed(request: Request, policy: UpgradePolicy): boolean {
  const host = request.headers.get("host")?.toLowerCase();
  if (host !== undefined && host === policy.remote?.host) return true;
  return host === `127.0.0.1:${policy.port}` || host === `localhost:${policy.port}`;
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  if (expectedBytes.byteLength !== actualBytes.byteLength) return false;
  return crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function forbiddenUpgrade(): Response {
  return new Response(null, { status: 403 });
}

/**
 * Returns an HTTP rejection for a bad Host, a close decision after upgrade for auth failures, or who was let in: the
 * launch link's token, else a paired device's key (its cookie). A wrong token with a paired device's key still lets the
 * device in, so a page that kept an old link keeps working once its device is paired.
 */
export function authorizeWebSocketUpgrade(
  request: Request,
  policy: UpgradePolicy,
): Response | UpgradeClose | UpgradeAccepted {
  const url = new URL(request.url);
  const candidate = url.searchParams.get("token") ?? "";
  if (!hostAllowed(request, policy)) return forbiddenUpgrade();
  if (!originAllowed(request.headers.get("origin"), policy)) {
    return { closeCode: 4403, reason: "origin not allowed" };
  }
  if (candidate !== "" && constantTimeEqual(policy.token, candidate)) return { deviceId: null };
  const key = deviceKeyOf(request);
  const deviceId = key === undefined ? undefined : policy.deviceForKey?.(key);
  if (deviceId !== undefined) return { deviceId };
  if (candidate === "" && policy.deviceForKey !== undefined) {
    return { closeCode: 4401, reason: "not paired" };
  }
  const expired = policy.earlierLaunchTokens?.has(launchTokenDigest(candidate)) === true;
  return { closeCode: 4401, reason: expired ? "expired token" : "invalid token" };
}

/** Whether a request's Host and Origin are one of the app's own pages (the WebSocket's check, for `/pair/*`). */
function fromAppPage(request: Request, policy: UpgradePolicy): boolean {
  return hostAllowed(request, policy) && originAllowed(request.headers.get("origin"), policy);
}

/** Whether a request came to the loopback address from no web page: a program on the server's own computer. */
function fromThisComputer(request: Request, port: number): boolean {
  return hostAllowed(request, { token: "", port }) && request.headers.get("origin") === null;
}

function safeStaticPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative.split("/").includes("..")) return undefined;
  return `${root.replace(/\/+$/, "")}/${relative}`;
}

/** Sent with every static response: the app must not be framed by another page, sniffed or referred. */
const STATIC_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** Where the old UI is served while it stays: the new UI is the app's root. */
const OLD_PREFIX = "/old";
/** Where the new UI was served before it became the root; links to it are sent on. */
const FORMER_UI_PREFIX = "/v2";

function redirect(location: string): Response {
  return new Response(null, { status: 308, headers: { ...STATIC_HEADERS, Location: location } });
}

/** Vite names each file it builds under `assets/` after its contents, so a browser may keep it for good. */
const KEPT_FOR_GOOD = { "Cache-Control": "public, max-age=31536000, immutable" } as const;

/** Text a browser can take gzipped: the new UI's script is about 1.8 MB, a quarter of that gzipped. */
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|map|txt)$/;

/** Whether the request takes gzip: named in Accept-Encoding, and not with `q=0`. */
function acceptsGzip(request: Request): boolean {
  return (request.headers.get("accept-encoding") ?? "").split(",").some((part) => {
    const [name, ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
    return name === "gzip" && !parameters.some((parameter) => /^q=0(?:\.0*)?$/.test(parameter));
  });
}

/**
 * A file of a UI's build. index.html carries the build's asset hashes, so it is never kept; the hashed assets are kept
 * for good. Text goes gzipped, as a stream, to a browser that takes it, so a large script costs a quarter of the time
 * over a slow link and the server never holds one in memory.
 */
async function serveStatic(root: string, pathname: string, request: Request): Promise<Response> {
  const path = safeStaticPath(root, pathname);
  if (path === undefined) return new Response("Bad path", { status: 400, headers: STATIC_HEADERS });
  const file = Bun.file(path);
  if (!(await file.exists()))
    return new Response("Not found", { status: 404, headers: STATIC_HEADERS });
  const cache = path.endsWith("/index.html")
    ? { "Cache-Control": "no-store" }
    : /\/assets\/[^/]+$/.test(path)
      ? KEPT_FOR_GOOD
      : {};
  if (!COMPRESSIBLE.test(path))
    return new Response(file, { headers: { ...STATIC_HEADERS, ...cache } });
  const headers = { ...STATIC_HEADERS, ...cache, Vary: "Accept-Encoding" };
  if (!acceptsGzip(request)) return new Response(file, { headers });
  return new Response(file.stream().pipeThrough(new CompressionStream("gzip")), {
    headers: { ...headers, "Content-Type": file.type, "Content-Encoding": "gzip" },
  });
}

function randomId(): string {
  return crypto.randomUUID();
}

export function createAppServer(options: AppServerOptions = {}): AppServer {
  const token = options.token ?? newLaunchToken();
  if (token.length === 0) throw new Error("WebSocket token cannot be empty");
  const instanceId = options.instanceId ?? randomId();
  const replay = options.replay ?? new EventReplayHub(options.replayLimit ?? DEFAULT_REPLAY_LIMIT);
  const capabilities = CapabilityMap.parse(options.capabilities ?? {});
  const omp = options.omp ?? null;
  const welcome = WelcomeFrameSchema.parse({
    type: "welcome",
    protocol: APP_PROTOCOL,
    instanceId,
    serverVersion: options.serverVersion ?? DEFAULT_SERVER_VERSION,
    omp,
    capabilities,
  });
  const dispatcher = new Dispatcher({
    registry: options.registry ?? PORT_REGISTRY,
    replay,
    welcome,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const staticRoot = options.staticRoot ?? `${process.cwd()}/apps/web/dist`;
  const uiRoot = options.uiRoot ?? `${process.cwd()}/apps/ui/dist`;
  const port = requestedPort(options);
  const origins = options.origins;
  const devices = options.devices;
  const policy = (): UpgradePolicy => ({
    token,
    origins,
    port: bunServer.port ?? port,
    earlierLaunchTokens: options.earlierLaunchTokens,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    ...(devices === undefined
      ? {}
      : { deviceForKey: (key: string) => devices.store.deviceForKey(key)?.id }),
  });
  /** Whether a request came over HTTPS: through `tailscale serve`, which passes the browser's Host on. */
  const overHttps = (request: Request): boolean =>
    options.remote !== undefined &&
    request.headers.get("host")?.toLowerCase() === options.remote.host;
  /** The page a paired device loads sets its key's cookie again, so it lasts while the device is used. */
  const renewed = (request: Request, page: Response): Response => {
    if (devices === undefined || page.status !== 200) return page;
    const key = deviceKeyOf(request);
    if (key === undefined || devices.store.deviceForKey(key) === undefined) return page;
    page.headers.append("Set-Cookie", deviceCookie(key, overHttps(request)));
    return page;
  };

  interface SocketData {
    readonly id: string;
    readonly authFailure?: UpgradeClose;
    /** The paired device signed in; null with the launch link. */
    readonly deviceId: string | null;
    /** The client's user agent, for the log. */
    readonly client: string;
    session?: DispatcherSession;
  }

  let bunServer: Bun.Server<SocketData>;
  bunServer = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (devices !== undefined) {
        const answer = await pairingRoute(request, url, {
          pairing: devices,
          fromAppPage: (each) => fromAppPage(each, policy()),
          fromThisComputer: (each) => fromThisComputer(each, bunServer.port ?? port),
          overHttps,
          isLaunchToken: (candidate) => constantTimeEqual(token, candidate),
          address: () => options.remote?.origin ?? `http://127.0.0.1:${bunServer.port ?? port}`,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        });
        if (answer !== undefined) return answer;
      }
      if (url.pathname === "/ws") {
        const authorization = authorizeWebSocketUpgrade(request, policy());
        if (authorization instanceof Response) {
          options.logger?.warn("connection.rejected", {
            reason: "host",
            origin: request.headers.get("origin") ?? "none",
          });
          return authorization;
        }
        const upgraded = server.upgrade(request, {
          data: {
            id: randomId(),
            client: (request.headers.get("user-agent") ?? "none").slice(0, CLIENT_CHARACTERS),
            ...("closeCode" in authorization
              ? { authFailure: authorization, deviceId: null }
              : { deviceId: authorization.deviceId }),
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === OLD_PREFIX) return redirect(`${OLD_PREFIX}/${url.search}`);
      if (url.pathname.startsWith(`${OLD_PREFIX}/`)) {
        return serveStatic(staticRoot, url.pathname.slice(OLD_PREFIX.length), request);
      }
      if (url.pathname === FORMER_UI_PREFIX || url.pathname.startsWith(`${FORMER_UI_PREFIX}/`)) {
        return redirect(`${url.pathname.slice(FORMER_UI_PREFIX.length) || "/"}${url.search}`);
      }
      // The new UI first; a file it does not have may be one of the old UI's own pages or files, served as before.
      const page = await serveStatic(uiRoot, url.pathname, request);
      if (page.status === 404) return serveStatic(staticRoot, url.pathname, request);
      return url.pathname === "/" || url.pathname === "/index.html" ? renewed(request, page) : page;
    },
    websocket: {
      open: (socket) => {
        if (socket.data.authFailure) {
          options.logger?.warn("connection.rejected", { reason: socket.data.authFailure.reason });
          socket.close(socket.data.authFailure.closeCode, socket.data.authFailure.reason);
          return;
        }
        const dispatcherSocket = {
          id: socket.data.id,
          send: (frame: ServerFrame) => {
            // Bun drops what is sent on a closed connection (status 0): the session ends as the socket's close would end it.
            if (socket.send(JSON.stringify(ServerFrameSchema.parse(frame))) === 0) {
              throw new Error("The connection has closed.");
            }
          },
          close: (code: number, reason: string) => socket.close(code, reason),
          isOpen: () => socket.readyState === 1,
        };
        socket.data.session = dispatcher.open(dispatcherSocket, socket.data.client);
        const deviceId = socket.data.deviceId;
        if (devices !== undefined && deviceId !== null) {
          devices.connections.add(socket.data.id, deviceId, (code, reason) =>
            socket.close(code, reason),
          );
          devices.store.seen(deviceId);
        }
      },
      message: (socket, message) => {
        socket.data.session?.receive(message);
      },
      close: (socket) => {
        if (socket.data.session !== undefined) dispatcher.close(socket.data.session);
        devices?.connections.remove(socket.data.id);
      },
    },
  });
  const actualPort = bunServer.port ?? port;
  // It never holds the process up: a server that is not stopped still lets it exit.
  const sweeper = setInterval(() => dispatcher.sweep(), SWEEP_MS);
  sweeper.unref();
  let stopped = false;
  const appServer: AppServer = {
    port: actualPort,
    token,
    instanceId,
    url: `http://127.0.0.1:${actualPort}`,
    dispatcher,
    publish: dispatcher.publish.bind(dispatcher),
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(sweeper);
      dispatcher.closeAll();
      // Bun's stop(true) never resolves once the server itself has closed a socket (a rejected
      // token, a protocol error): quitting then hung forever, for example after an old tab with a
      // stale link had been turned away. It stops accepting at once, so waiting a moment is enough.
      await Promise.race([bunServer.stop(true), Bun.sleep(STOP_WAIT_MS)]);
    },
  };
  return appServer;
}

export { DEFAULT_PORT, DEFAULT_REPLAY_LIMIT };

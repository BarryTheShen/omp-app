import type { CapabilityMap as CapabilityMapType, ServerFrame } from "@omp-app/contracts";
import {
  APP_PROTOCOL,
  CapabilityMap,
  LINK_SILENCE_LIMIT_SECONDS,
  ServerFrame as ServerFrameSchema,
  SOCKET_PROTOCOL,
  WelcomeFrame as WelcomeFrameSchema,
} from "@omp-app/contracts";

import {
  type DevicePairing,
  deviceCookie,
  deviceKeyOf,
  deviceKeyOfProtocols,
  type MachineNamer,
  offeredProtocols,
  pairingRoute,
} from "./devices";
import { Dispatcher, type DispatcherSession } from "./dispatcher";
import { liteFrameAncestors } from "./frame-ancestors";
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
  /** The HTTPS address the app may also be opened at (`OMP_APP_REMOTE_ORIGIN`, see `remote-origin.ts`). */
  readonly remote?: RemoteOrigin;
  readonly instanceId?: string;
  readonly serverVersion?: string;
  readonly omp?: { readonly version: string } | null;
  readonly capabilities?: CapabilityMapType;
  readonly replayLimit?: number;
  readonly replay?: EventReplayHub;
  /** The new UI's built folder, served at the app's root (default: `apps/ui/dist` in the working folder). */
  readonly uiRoot?: string;
  /**
   * The pages that may show the lite view (`/lite`, #2843) in a frame, on top of the browser extensions' and
   * VS Code's panels, which always may (`OMP_APP_FRAME_ANCESTORS`, see `frame-ancestors.ts`); no other page of
   * the app may ever be framed.
   */
  readonly frameAncestors?: readonly string[];
  readonly registry?: PortRegistry;
  /** Where connections and failed calls are recorded; nothing is logged without one. */
  readonly logger?: Logger;
  /** Digests (`launchTokenDigest`) of the launch tokens earlier starts printed: a link with one of them reads as expired, not as never printed. */
  readonly earlierLaunchTokens?: ReadonlySet<string>;
  /** Device pairing: a paired device signs in with its key's cookie, and `/pair/*` pairs new ones. */
  readonly devices?: DevicePairing;
  /** Names the computer a pairing page is on, for the suggested name of a new device (`devices/machine.ts`); none by default. */
  readonly machineOf?: MachineNamer;
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
  /** The HTTPS address the app is also served at, besides the loopback ones. */
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
 * Whether a request came from another computer through what serves the app's remote address (a reverse proxy, a
 * tunnel, Tailscale Serve): it asks for that address (its Host), or the proxy marked it, as most do with `X-Forwarded-For`
 * or `X-Forwarded-Host` over anything the client sent (Tailscale Serve and Caddy always; nginx when set up to). Such a
 * request is from another computer whatever its Origin says.
 */
function throughProxy(request: Request, policy: UpgradePolicy): boolean {
  const host = request.headers.get("host")?.toLowerCase();
  return (
    (policy.remote !== undefined && host === policy.remote.host) ||
    request.headers.has("x-forwarded-for") ||
    request.headers.has("x-forwarded-host")
  );
}

/**
 * Returns an HTTP rejection for a bad Host, a close decision after upgrade for auth failures, or who was let in: a
 * paired device's key (its cookie, or the key a panel whose host keeps it offers in the socket's protocols: another
 * app's frame keeps no cookie of the app), else the launch link's token. The key comes first, so a page that holds both
 * is its device. The token is taken from the server's own computer only: a page at the remote address pairs instead, so
 * one with the token and no key is told it is not paired, and so is any request that came through a proxy, whatever
 * Host and Origin it names.
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
  // The first key that names a paired device: the cookie, the protocols, then `?device=` (a panel loaded before its key
  // moved to the protocols sends it in the address until it loads again). A stale cookie hides no valid key after it.
  const keys = [
    deviceKeyOf(request),
    deviceKeyOfProtocols(request),
    url.searchParams.get("device") || undefined,
  ];
  for (const key of keys) {
    const deviceId = key === undefined ? undefined : policy.deviceForKey?.(key);
    if (deviceId !== undefined) return { deviceId };
  }
  const remotePage =
    policy.remote !== undefined && request.headers.get("origin") === policy.remote.origin;
  if (policy.deviceForKey !== undefined && (candidate === "" || remotePage)) {
    return { closeCode: 4401, reason: "not paired" };
  }
  if (throughProxy(request, policy)) return { closeCode: 4401, reason: "not paired" };
  if (candidate !== "" && constantTimeEqual(policy.token, candidate)) return { deviceId: null };
  const expired = policy.earlierLaunchTokens?.has(launchTokenDigest(candidate)) === true;
  return { closeCode: 4401, reason: expired ? "expired token" : "invalid token" };
}

/** Whether a request's Host and Origin are one of the app's own pages (the WebSocket's check, for `/pair/*`). */
function fromAppPage(request: Request, policy: UpgradePolicy): boolean {
  return hostAllowed(request, policy) && originAllowed(request.headers.get("origin"), policy);
}

/** Whether a request came to the loopback address from no web page and no proxy: a program on the server's own computer. */
function fromThisComputer(request: Request, port: number): boolean {
  const local = { token: "", port };
  return (
    hostAllowed(request, local) &&
    request.headers.get("origin") === null &&
    !throughProxy(request, local)
  );
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
const STATIC_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** The lite view (#2843): the new UI's page in a shell made for another app's side panel. */
const LITE_PATH = "/lite";

/**
 * The lite view's headers: the browser extensions' and VS Code's panels and the pages `frameAncestors` names may frame
 * it, and only those (CSP, which every browser takes over `X-Frame-Options`, which names no page; it is left out so no
 * older browser refuses them). A panel is still paired, as any device.
 */
function liteHeaders(frameAncestors: readonly string[]): Readonly<Record<string, string>> {
  const { "X-Frame-Options": _refused, ...rest } = STATIC_HEADERS;
  return {
    ...rest,
    "Content-Security-Policy": `frame-ancestors ${liteFrameAncestors(frameAncestors).join(" ")}`,
  };
}

/** Where the old UI was served before it was removed: `/old` and everything under it is sent to the app's root. */
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
async function serveStatic(
  root: string,
  pathname: string,
  request: Request,
  framing: Readonly<Record<string, string>> = STATIC_HEADERS,
): Promise<Response> {
  const path = safeStaticPath(root, pathname);
  if (path === undefined) return new Response("Bad path", { status: 400, headers: framing });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404, headers: framing });
  const cache = path.endsWith("/index.html")
    ? { "Cache-Control": "no-store" }
    : /\/assets\/[^/]+$/.test(path)
      ? KEPT_FOR_GOOD
      : {};
  if (!COMPRESSIBLE.test(path)) return new Response(file, { headers: { ...framing, ...cache } });
  const headers = { ...framing, ...cache, Vary: "Accept-Encoding" };
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
  const uiRoot = options.uiRoot ?? `${process.cwd()}/apps/ui/dist`;
  const liteFramedBy = liteHeaders(options.frameAncestors ?? []);
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
  /** Whether a request came over HTTPS: at the remote address, or marked so by what serves it there. */
  const overHttps = (request: Request): boolean =>
    (options.remote !== undefined &&
      request.headers.get("host")?.toLowerCase() === options.remote.host) ||
    request.headers.get("x-forwarded-proto")?.toLowerCase() === "https";
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
    /** For a refused connection's log line: where its page was, and whether it brought a device key and a token. */
    readonly origin: string;
    readonly hadKey: boolean;
    readonly hadToken: boolean;
    session?: DispatcherSession;
  }

  let bunServer: Bun.Server<SocketData>;
  bunServer = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    // Only `/pair/*` takes a body, a few hundred bytes; files and messages go over the WebSocket.
    maxRequestBodySize: 64 * 1024,
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
          ...(options.machineOf === undefined ? {} : { machineOf: options.machineOf }),
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
        // A socket that offers protocols must offer the app's: Bun names the first one offered back by itself, which
        // for a panel's key protocol alone would be its key.
        const offered = offeredProtocols(request);
        if (offered.length > 0 && !offered.includes(SOCKET_PROTOCOL)) {
          options.logger?.warn("connection.rejected", {
            reason: "protocol",
            origin: request.headers.get("origin") ?? "none",
          });
          return new Response("Unknown WebSocket protocol", { status: 400 });
        }
        const data: SocketData = {
          id: randomId(),
          client: (request.headers.get("user-agent") ?? "none").slice(0, CLIENT_CHARACTERS),
          origin: request.headers.get("origin") ?? "none",
          hadKey:
            deviceKeyOf(request) !== undefined ||
            deviceKeyOfProtocols(request) !== undefined ||
            url.searchParams.has("device"),
          hadToken: url.searchParams.has("token"),
          ...("closeCode" in authorization
            ? { authFailure: authorization, deviceId: null }
            : { deviceId: authorization.deviceId }),
        };
        // The app's protocol is named back to a socket that offered it; one that offered none gets none (a browser fails
        // a socket whose server names a protocol it did not offer).
        const upgraded =
          offered.length > 0
            ? server.upgrade(request, {
                headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL },
                data,
              })
            : server.upgrade(request, { data });
        return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === OLD_PREFIX || url.pathname.startsWith(`${OLD_PREFIX}/`)) {
        return redirect(`/${url.search}`);
      }
      if (url.pathname === FORMER_UI_PREFIX || url.pathname.startsWith(`${FORMER_UI_PREFIX}/`)) {
        // One leading slash only: `/v2//elsewhere.example` must not become a link to another site.
        const rest = url.pathname.slice(FORMER_UI_PREFIX.length).replace(/^\/+/, "");
        return redirect(`/${rest}${url.search}`);
      }
      // The lite view: the new UI's page, which the panels and the pages `frameAncestors` names may frame.
      if (url.pathname === LITE_PATH) {
        return renewed(request, await serveStatic(uiRoot, "/index.html", request, liteFramedBy));
      }
      // The new UI's own files; one it does not have is a 404.
      const page = await serveStatic(uiRoot, url.pathname, request);
      return url.pathname === "/" || url.pathname === "/index.html" ? renewed(request, page) : page;
    },
    websocket: {
      // Pings keep a quiet link up; a link that answers nothing for this long (a phone in another app, a laptop asleep)
      // is closed, and a page that was away longer knows its link is gone without asking (`linkCheck.ts`).
      idleTimeout: LINK_SILENCE_LIMIT_SECONDS,
      sendPings: true,
      open: (socket) => {
        if (socket.data.authFailure) {
          // Who was refused and with what: a paired device refused by mistake shows here (Nov 2, an unnamed "not paired").
          options.logger?.warn("connection.rejected", {
            reason: socket.data.authFailure.reason,
            client: socket.data.client,
            origin: socket.data.origin,
            has_key: socket.data.hadKey,
            has_token: socket.data.hadToken,
          });
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
        // A frame that throws must not reach the process's last-resort handler, which ends the server.
        try {
          socket.data.session?.receive(message);
        } catch (error) {
          options.logger?.error("connection.frame_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      close: (socket, code, reason) => {
        if (socket.data.session !== undefined)
          dispatcher.close(socket.data.session, { code, reason });
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

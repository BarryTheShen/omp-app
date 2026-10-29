import type { CapabilityMap as CapabilityMapType, ServerFrame } from "@omp-app/contracts";
import {
  APP_PROTOCOL,
  CapabilityMap,
  ServerFrame as ServerFrameSchema,
  WelcomeFrame as WelcomeFrameSchema,
} from "@omp-app/contracts";

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
  readonly staticRoot?: string;
  /** The new UI's built folder, served under `/v2/` beside the old UI (default: `apps/ui/dist` in the working folder). */
  readonly uiRoot?: string;
  readonly registry?: PortRegistry;
  /** Where connections and failed calls are recorded; nothing is logged without one. */
  readonly logger?: Logger;
  /** Digests (`launchTokenDigest`) of the launch tokens earlier starts printed: a link with one of them reads as expired, not as never printed. */
  readonly earlierLaunchTokens?: ReadonlySet<string>;
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
  readonly reason: "invalid token" | "expired token" | "origin not allowed";
}

export interface UpgradePolicy {
  readonly token: string;
  readonly origins?: readonly string[];
  readonly port: number;
  readonly earlierLaunchTokens?: ReadonlySet<string>;
  /** The Tailscale address allowed besides the loopback ones. */
  readonly remote?: RemoteOrigin;
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

/** Returns an HTTP rejection for a bad Host, or a close decision after upgrade for auth failures. */
export function authorizeWebSocketUpgrade(
  request: Request,
  policy: UpgradePolicy,
): Response | UpgradeClose | undefined {
  const url = new URL(request.url);
  const candidate = url.searchParams.get("token") ?? "";
  if (!hostAllowed(request, policy)) return forbiddenUpgrade();
  if (!originAllowed(request.headers.get("origin"), policy)) {
    return { closeCode: 4403, reason: "origin not allowed" };
  }
  if (!constantTimeEqual(policy.token, candidate)) {
    const expired = policy.earlierLaunchTokens?.has(launchTokenDigest(candidate)) === true;
    return { closeCode: 4401, reason: expired ? "expired token" : "invalid token" };
  }
  return undefined;
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

/** Where the new UI is served, beside the old one at `/`. */
const UI_PREFIX = "/v2";

async function serveStatic(root: string, pathname: string): Promise<Response> {
  const path = safeStaticPath(root, pathname);
  if (path === undefined) return new Response("Bad path", { status: 400, headers: STATIC_HEADERS });
  const file = Bun.file(path);
  if (!(await file.exists()))
    return new Response("Not found", { status: 404, headers: STATIC_HEADERS });
  // index.html carries the build's asset hashes, so it must never be served from a stale cache.
  const cache = path.endsWith("/index.html") ? { "Cache-Control": "no-store" } : {};
  return new Response(file, { headers: { ...STATIC_HEADERS, ...cache } });
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

  interface SocketData {
    readonly id: string;
    readonly authFailure?: UpgradeClose;
    session?: DispatcherSession;
  }

  let bunServer: Bun.Server<SocketData>;
  bunServer = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        const authorization = authorizeWebSocketUpgrade(request, {
          token,
          origins,
          port: bunServer.port ?? port,
          earlierLaunchTokens: options.earlierLaunchTokens,
          ...(options.remote === undefined ? {} : { remote: options.remote }),
        });
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
            ...(authorization ? { authFailure: authorization } : {}),
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === UI_PREFIX) {
        return new Response(null, {
          status: 308,
          headers: { ...STATIC_HEADERS, Location: `${UI_PREFIX}/${url.search}` },
        });
      }
      if (url.pathname.startsWith(`${UI_PREFIX}/`)) {
        return serveStatic(uiRoot, url.pathname.slice(UI_PREFIX.length));
      }
      return serveStatic(staticRoot, url.pathname);
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
          send: (frame: ServerFrame) => socket.send(JSON.stringify(ServerFrameSchema.parse(frame))),
          close: (code: number, reason: string) => socket.close(code, reason),
        };
        socket.data.session = dispatcher.open(dispatcherSocket);
      },
      message: (socket, message) => {
        socket.data.session?.receive(message);
      },
      close: (socket) => {
        if (socket.data.session !== undefined) dispatcher.close(socket.data.session);
      },
    },
  });
  const actualPort = bunServer.port ?? port;
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

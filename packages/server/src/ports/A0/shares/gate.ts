import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  SHARE_COOKIE_PREFIX,
  SHARE_ENTER_PATH,
  SHARE_IDLE_MS,
  SHARE_TICKET_MS,
} from "@omp-app/contracts";
import type { Server, ServerWebSocket } from "bun";
import type { Logger } from "../../../logging";
import { typedBody } from "./sniff";

/** Where a share's requests go: a service listening on this machine, or a folder of files (a page). */
export type GateTarget =
  | { readonly kind: "service"; readonly port: number; readonly address: string }
  | {
      readonly kind: "page";
      /** The folder served, absolute. */
      readonly root: string;
      /** The page opened first, inside it. */
      readonly entry: string;
    };

export interface GateOptions {
  readonly shareId: string;
  /** The machine's address on the private network: the gate listens there only. */
  readonly address: string;
  /** The port wanted (a service's own); another free one when it is taken. */
  readonly port: number;
  readonly target: GateTarget;
  /** The names of the app's own cookies (a device's sign-in): they never reach a service, nor are set by one. */
  readonly reserved: readonly string[];
  readonly logger?: Logger;
  /** A device opened the share for the first time: the list of devices it was opened on changed. */
  readonly onOpened?: () => void;
  readonly now?: () => number;
}

/** One share's own address (#2788): only devices signed in through a ticket from the app get past it. */
export interface Gate {
  readonly port: number;
  readonly url: string;
  /** A one-time address into the share for this device: it signs the device in once, within a minute. */
  ticket(deviceId: string | null, deviceName: string): string;
  /** Ends a device's sessions: it was removed from the paired devices. */
  forget(deviceId: string): void;
  lastUsedAt(): number;
  openedBy(): readonly string[];
  stop(): void;
}

interface Signed {
  readonly deviceId: string | null;
  readonly deviceName: string;
}

interface Ticket extends Signed {
  readonly expiresAt: number;
}

interface SocketData {
  readonly path: string;
  readonly headers: Headers;
  readonly protocols: readonly string[];
  upstream: WebSocket | null;
  readonly waiting: (string | Uint8Array)[];
}

const token = (): string => randomBytes(32).toString("base64url");

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);

/** Whether a reply carries a body: not one to HEAD, and not a status that never has one. */
const carriesBody = (method: string, status: number): boolean =>
  method !== "HEAD" && status >= 200 && status !== 204 && status !== 205 && status !== 304;

/** A short page of the gate's own: what to do, never the service's content. */
function page(status: number, title: string, words: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(words)}</p></body>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

function cookiesOf(header: string | null): [string, string][] {
  if (header === null) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as [string, string];
    });
}

/**
 * Opens a share's gate (#2788) on the machine's private-network address. A device opens it with a ticket from the app,
 * which the gate swaps for a cookie good for this address only; any request without that cookie gets a page that says to
 * open it from the app. A service's requests and WebSockets pass to its one fixed local port with the app's cookies taken
 * out, and a cookie it sets under the app's or the shares' names is dropped. A page's files are served from its folder
 * only: a path leading out of it, also through a link, is refused.
 */
export async function openGate(options: GateOptions): Promise<Gate> {
  const now = options.now ?? Date.now;
  const { shareId, target } = options;
  const cookieName = `${SHARE_COOKIE_PREFIX}${shareId}`;
  const tickets = new Map<string, Ticket>();
  const sessions = new Map<string, Signed>();
  const opened = new Set<string>();
  let used = now();
  let lastRefusalLog = Number.NEGATIVE_INFINITY;
  const pageRoot = target.kind === "page" ? await realpath(target.root) : null;
  const upstreamHost =
    target.kind === "service" && target.address === "::1" ? "[::1]" : "127.0.0.1";
  const upstreamBase = target.kind === "service" ? `${upstreamHost}:${target.port}` : "";

  const refused = (reason: string): void => {
    // A browser retries assets and icons: one line a minute is enough for the log.
    if (now() - lastRefusalLog < 60_000) return;
    lastRefusalLog = now();
    options.logger?.warn("share.refused", { share: shareId, reason });
  };

  const sessionOf = (request: Request): Signed | null => {
    const value = cookiesOf(request.headers.get("cookie")).find(
      ([name]) => name === cookieName,
    )?.[1];
    return value === undefined ? null : (sessions.get(value) ?? null);
  };

  /** The request's headers as the service sees them: its own host and origin, and none of the app's cookies. */
  const forwarded = (request: Request, url: URL): Headers => {
    const headers = new Headers(request.headers);
    const kept = cookiesOf(request.headers.get("cookie")).filter(
      ([name]) => !name.startsWith(SHARE_COOKIE_PREFIX) && !options.reserved.includes(name),
    );
    if (kept.length > 0)
      headers.set("cookie", kept.map(([name, value]) => `${name}=${value}`).join("; "));
    else headers.delete("cookie");
    if (target.kind === "service") {
      headers.set("host", `localhost:${target.port}`);
      // The share's own pages are the service's own: their Origin becomes its local one, so its own checks pass. Any other
      // Origin goes on as it came, for the service to judge.
      if (headers.get("origin") === `http://${url.host}`)
        headers.set("origin", `http://localhost:${target.port}`);
    }
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "http");
    return headers;
  };

  const servePage = async (url: URL): Promise<Response> => {
    if (pageRoot === null) return page(500, "Not a page", "This share holds no files.");
    let wanted: string;
    try {
      wanted = decodeURIComponent(url.pathname);
    } catch {
      return page(400, "Not found", "That address is not a file of this page.");
    }
    const inside = (path: string): boolean => path === pageRoot || path.startsWith(pageRoot + sep);
    // A hidden file or folder (`.env`, `.git`) beside the page is not part of it.
    const shown = (path: string): boolean =>
      !relative(pageRoot, path)
        .split(sep)
        .some((part) => part.startsWith("."));
    let file: string;
    try {
      file = await realpath(resolve(pageRoot, `.${wanted}`));
      if (!inside(file) || !shown(file)) throw new Error("outside");
      if ((await stat(file)).isDirectory()) {
        file = await realpath(join(file, "index.html"));
        if (!inside(file) || !shown(file)) throw new Error("outside");
      }
    } catch {
      return page(404, "Not found", "That address is not a file of this page.");
    }
    return new Response(Bun.file(file), {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  };

  /**
   * Whether a page of another origin made the request: shares on this address differ only by port, which browsers count
   * as the same site, so one share's page would send the others' cookies along. Only a GET or HEAD navigation (a link
   * the person followed) may come from elsewhere, and a WebSocket only from this share's own pages. Fetch Metadata
   * when the browser sends it, else the Origin header.
   */
  const fromAnotherPage = (request: Request, url: URL): boolean => {
    const own = `http://${url.host}`;
    const origin = request.headers.get("origin");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
      return origin !== null && origin !== own;
    const reading = request.method === "GET" || request.method === "HEAD";
    const site = request.headers.get("sec-fetch-site");
    if (site !== null) {
      const navigation = request.headers.get("sec-fetch-mode") === "navigate" && reading;
      return site !== "same-origin" && site !== "none" && !navigation;
    }
    return origin !== null && origin !== own && !reading;
  };

  const proxy = async (request: Request, url: URL): Promise<Response> => {
    if (target.kind !== "service")
      return page(500, "Not a service", "This share holds no service.");
    let response: Response;
    try {
      response = await fetch(`http://${upstreamBase}${url.pathname}${url.search}`, {
        method: request.method,
        headers: forwarded(request, url),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        decompress: false,
      } as RequestInit);
    } catch {
      return page(
        502,
        "The service is not answering",
        `Nothing answers on port ${target.port} of the server's machine now. It may have stopped.`,
      );
    }
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    for (const cookie of response.headers.getSetCookie()) {
      const name = cookie.slice(0, cookie.indexOf("=")).trim();
      if (name.startsWith(SHARE_COOKIE_PREFIX) || options.reserved.includes(name)) {
        options.logger?.warn("share.cookie_dropped", { share: shareId, cookie: name });
        continue;
      }
      headers.append("set-cookie", cookie);
    }
    // A redirect to the service's own local address goes to the same place through the share.
    const location = headers.get("location");
    if (location !== null) {
      const local = new RegExp(
        `^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${target.port}(?=/|$)`,
        "i",
      );
      headers.set("location", location.replace(local, "") || "/");
    }
    // A reply the service sent without a type gets the one a browser would find (`sniff.ts`): Bun.serve would send it as
    // application/octet-stream, and a browser downloads such a page instead of showing it.
    let body = response.body;
    if (
      body !== null &&
      !headers.has("content-type") &&
      carriesBody(request.method, response.status)
    ) {
      try {
        const typed = await typedBody(body, request.headers.get("sec-fetch-dest"));
        headers.set("content-type", typed.type);
        body = typed.body;
      } catch {
        return page(502, "The service stopped answering", "Its reply broke off before it began.");
      }
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const handle = async (
    request: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === SHARE_ENTER_PATH) {
      const id = url.searchParams.get("ticket") ?? "";
      const ticket = tickets.get(id);
      // A ticket counts once, also when it came too late.
      tickets.delete(id);
      if (ticket === undefined || ticket.expiresAt < now()) {
        refused(ticket === undefined ? "unknown ticket" : "expired ticket");
        return page(
          403,
          "This link was used or has expired",
          "Open the share again from the app: its Ports panel, or the link in the chat.",
        );
      }
      const value = token();
      sessions.set(value, { deviceId: ticket.deviceId, deviceName: ticket.deviceName });
      const known = opened.size;
      opened.add(ticket.deviceName);
      if (opened.size > known) options.onOpened?.();
      used = now();
      options.logger?.info("share.opened", { share: shareId, device: ticket.deviceName });
      const first = target.kind === "page" ? `/${encodeURI(target.entry)}` : "/";
      return new Response(null, {
        status: 303,
        headers: {
          Location: first,
          "Set-Cookie": `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SHARE_IDLE_MS / 1000}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    if (fromAnotherPage(request, url)) {
      refused("another page");
      return page(
        403,
        "Open this from the app",
        "Another page asked for this share. Open it from the app's Ports panel, or the link in the chat.",
      );
    }
    if (sessionOf(request) === null) {
      refused("not signed in");
      return page(
        403,
        "Open this from the app",
        "This address opens only on devices paired with the app. Open it from the app's Ports panel, or the link in the chat.",
      );
    }
    used = now();
    if (target.kind === "page") return servePage(url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const headers = forwarded(request, url);
      for (const name of [
        "upgrade",
        "connection",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
      ])
        headers.delete(name);
      const data: SocketData = {
        path: `${url.pathname}${url.search}`,
        headers,
        protocols,
        upstream: null,
        waiting: [],
      };
      if (server.upgrade(request, { data })) return undefined;
      return page(
        400,
        "Not a WebSocket",
        "The request asked for a WebSocket the gate could not open.",
      );
    }
    return proxy(request, url);
  };

  const serveOn = (port: number) =>
    Bun.serve<SocketData, never>({
      hostname: options.address,
      port,
      fetch: handle,
      websocket: {
        open(socket: ServerWebSocket<SocketData>) {
          const upstream = new WebSocket(`ws://${upstreamBase}${socket.data.path}`, {
            headers: Object.fromEntries(socket.data.headers),
            protocols: [...socket.data.protocols],
          } as unknown as string[]);
          upstream.binaryType = "arraybuffer";
          socket.data.upstream = upstream;
          upstream.onopen = () => {
            for (const message of socket.data.waiting.splice(0)) upstream.send(message);
          };
          upstream.onmessage = (event) => {
            used = now();
            socket.send(
              typeof event.data === "string"
                ? event.data
                : new Uint8Array(event.data as ArrayBuffer),
            );
          };
          upstream.onclose = (event) =>
            socket.close(event.code === 1005 ? 1000 : event.code, event.reason);
          upstream.onerror = () => socket.close(1011, "The service closed the connection.");
        },
        message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
          used = now();
          const upstream = socket.data.upstream;
          const data = typeof message === "string" ? message : new Uint8Array(message);
          if (upstream !== null && upstream.readyState === WebSocket.OPEN) upstream.send(data);
          else socket.data.waiting.push(data);
        },
        close(socket: ServerWebSocket<SocketData>, code: number, reason: string) {
          socket.data.upstream?.close(code === 1005 ? 1000 : code, reason);
        },
      },
    });

  let server: Server<SocketData>;
  try {
    server = serveOn(options.port);
  } catch {
    // The wanted port is taken there (a service that listens on every network holds it too): any free one.
    server = serveOn(0);
  }
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("The share's address has no port.");
  }
  const url = `http://${options.address.includes(":") ? `[${options.address}]` : options.address}:${port}/`;
  return {
    port,
    url,
    ticket(deviceId, deviceName) {
      // The panel makes a new link every 45 seconds while it shows: the ones that ran out go.
      const at = now();
      for (const [id, kept] of tickets) if (kept.expiresAt <= at) tickets.delete(id);
      const id = token();
      tickets.set(id, { deviceId, deviceName, expiresAt: at + SHARE_TICKET_MS });
      return `${url.slice(0, -1)}${SHARE_ENTER_PATH}?ticket=${id}`;
    },
    forget(deviceId) {
      for (const [value, session] of sessions)
        if (session.deviceId === deviceId) sessions.delete(value);
      for (const [id, ticket] of tickets) if (ticket.deviceId === deviceId) tickets.delete(id);
    },
    lastUsedAt: () => used,
    openedBy: () => [...opened],
    stop() {
      sessions.clear();
      tickets.clear();
      server.stop(true);
    },
  };
}

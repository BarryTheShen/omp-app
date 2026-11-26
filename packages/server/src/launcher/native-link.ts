/**
 * The carrier's link for omp 19.1 and later (`omp-app relay`, `relay-carrier.ts`). There, the browser's extension links
 * only to omp's native host, which serves the relay on a port of its own while the browser runs and publishes it in
 * `~/.omp/browser-relay/endpoints`. This finds that relay and links it to the app as the paired device: a control link
 * (`/browser-relay?link=relay`) on which the app asks for its chats' requests to the relay (`RemoteRelay` on the app's
 * side): an HTTP request is fetched here and answered on the link, with the app's proxy as the `Host`, so the
 * relay's socket addresses name the proxy; a socket gets a channel of its own (`/browser-relay?channel=<id>`) joined to
 * a socket on the relay. No `Origin` goes to the relay: omp's relay takes its CDP clients only without one.
 */
import { discoverRelayEndpoints } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/discovery";

/** How often the published relays are read; a browser that starts is linked within this time. */
const LOOK_MS = 2_000;
/** How long the relay has to answer one request. */
const FETCH_MS = 10_000;
/** The pause before linking again after the app turned the link away or it dropped. */
const RETRY_MS = 10_000;

export interface NativeLinkOptions {
  /** The app's `/browser-relay` address, as a `ws:`/`wss:` URL. */
  readonly upstreamUrl: string;
  /** Opens a socket to the app as the paired device. */
  readonly connect: (url: string) => WebSocket;
  /** The relays published on this computer, newest first (omp's discovery unless given). */
  readonly endpoints?: () => string[];
  readonly say: (line: string) => void;
  /** The app answered 4401: this computer's device was removed. */
  readonly unpaired: () => void;
}

export interface NativeLink {
  stop(): void;
}

interface ToCarrier {
  readonly t: "http" | "open";
  readonly id: string;
  readonly method?: string;
  readonly path: string;
  readonly host: string;
}

function isToCarrier(value: unknown): value is ToCarrier {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.t === "http" || message.t === "open") &&
    typeof message.id === "string" &&
    typeof message.path === "string" &&
    message.path.startsWith("/") &&
    typeof message.host === "string"
  );
}

/** Links the newest relay published on this computer to the app while there is one, until stopped. */
export function startNativeLink(options: NativeLinkOptions): NativeLink {
  const endpoints = options.endpoints ?? discoverRelayEndpoints;
  let stopped = false;
  let linked: { readonly relay: string; readonly control: WebSocket } | null = null;
  /** The last refusal said, so a refusal repeated every look is said once. */
  let refused = "";
  /** No new link before this time (after a refusal or a drop). */
  let retryAt = 0;

  const link = (relay: string): void => {
    const control = options.connect(`${options.upstreamUrl}?link=relay`);
    const channels = new Set<WebSocket>();
    linked = { relay, control };
    control.onopen = () => {
      refused = "";
      options.say("This computer's browser is linked to the app.");
    };
    control.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isToCarrier(message)) return;
      if (message.t === "http") void answer(control, relay, message);
      else open(relay, message, channels);
    };
    control.onclose = (event) => {
      if (linked?.control === control) linked = null;
      if (event.code !== 1000) retryAt = Date.now() + RETRY_MS;
      for (const channel of channels) channel.close(1000);
      if (event.code === 4401) options.unpaired();
      else if (event.code === 4409 && event.reason !== refused) {
        refused = event.reason;
        options.say(`The app turned this computer's browser away: ${event.reason}`);
      }
    };
  };

  /** The app's socket `id` for the relay's socket at `path`: two sockets, joined. */
  const open = (relay: string, message: ToCarrier, channels: Set<WebSocket>): void => {
    const upstream = options.connect(
      `${options.upstreamUrl}?channel=${encodeURIComponent(message.id)}`,
    );
    const local = new WebSocket(`${relay.replace(/^http/, "ws")}${message.path}`);
    upstream.binaryType = "arraybuffer";
    local.binaryType = "arraybuffer";
    channels.add(upstream);
    const toLocal: (string | ArrayBuffer)[] = [];
    const toUpstream: (string | ArrayBuffer)[] = [];
    const pass = (to: WebSocket, waiting: (string | ArrayBuffer)[], data: string | ArrayBuffer) => {
      if (to.readyState === WebSocket.OPEN) to.send(data);
      else waiting.push(data);
    };
    const end = () => {
      channels.delete(upstream);
      for (const each of [upstream, local])
        if (each.readyState === WebSocket.CONNECTING || each.readyState === WebSocket.OPEN)
          each.close(1000);
    };
    upstream.onopen = () => {
      for (const data of toUpstream.splice(0)) upstream.send(data);
    };
    local.onopen = () => {
      for (const data of toLocal.splice(0)) local.send(data);
    };
    upstream.onmessage = (event) => pass(local, toLocal, event.data as string | ArrayBuffer);
    local.onmessage = (event) => pass(upstream, toUpstream, event.data as string | ArrayBuffer);
    upstream.onclose = end;
    local.onclose = end;
    upstream.onerror = end;
    local.onerror = end;
  };

  /** The relay's answer to an HTTP request, sent back on the control link. */
  const answer = async (control: WebSocket, relay: string, message: ToCarrier): Promise<void> => {
    let reply: { status: number; contentType: string; body: string };
    try {
      const response = await fetch(`${relay}${message.path}`, {
        method: message.method ?? "GET",
        headers: { host: message.host },
        signal: AbortSignal.timeout(FETCH_MS),
      });
      reply = {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "text/plain",
        body: await response.text(),
      };
    } catch (error) {
      reply = {
        status: 502,
        contentType: "text/plain",
        body: `The browser's relay did not answer: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (control.readyState === WebSocket.OPEN)
      control.send(JSON.stringify({ t: "http", id: message.id, ...reply }));
  };

  const look = (): void => {
    if (stopped) return;
    const relay = endpoints()[0] ?? null;
    // A browser that quit, or another one newer: the link follows the relay the chats here would use.
    if (linked !== null && linked.relay !== relay) {
      linked.control.close(1000);
      linked = null;
    }
    if (relay !== null && linked === null && Date.now() >= retryAt) link(relay);
  };
  look();
  const timer = setInterval(look, LOOK_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      linked?.control.close(1000);
      linked = null;
    },
  };
}

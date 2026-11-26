/**
 * A browser relay on another computer, reached through its carrier (omp 19.1 and later). There, omp's native host serves
 * the browser's relay on a port of its own while the browser runs; the extension links only to that host, never to a
 * port another program holds, so the carrier cannot bring the extension here as it did up to omp 19.0. It brings the
 * relay's other side instead: this proxy listens on 127.0.0.1 of the app's computer, where omp's chats find it
 * (`EdgeRelay` publishes it), and carries each of their requests to the relay over the carrier's control link: an HTTP
 * request as a message answered there, a WebSocket (`/cdp`) as a channel the carrier opens back to the app's
 * `/browser-relay?channel=<id>` and joins to the relay's own socket. The relay builds its socket addresses from the
 * `Host` it is given (`/json/version`'s `webSocketDebuggerUrl`), so the carrier names this proxy's address as the host
 * and nothing is rewritten. Like omp's relay, the proxy refuses anything that sends an `Origin` (a web page).
 */
import { randomBytes } from "node:crypto";
import type { Logger } from "../logging";
import type { CarriedLink, CarrierEnd } from "./edge-relay";

/** The app's messages to the carrier on the control link. */
export type ToCarrier =
  | {
      readonly t: "http";
      readonly id: string;
      readonly method: string;
      readonly path: string;
      readonly host: string;
    }
  | { readonly t: "open"; readonly id: string; readonly path: string; readonly host: string };

/** The carrier's answer to an `http` message. */
export interface HttpAnswer {
  readonly t: "http";
  readonly id: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** How long the carrier has to answer a request, or to open a socket's channel. */
const ANSWER_MS = 10_000;
/** As omp's relay: CDP messages carry screenshots. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

interface ProxySocket {
  readonly id: string;
  readonly path: string;
  /** The carrier's channel, once it opened. */
  channel: CarrierEnd | null;
  readonly waiting: (string | Uint8Array)[];
}

function isHttpAnswer(value: unknown): value is HttpAnswer {
  if (typeof value !== "object" || value === null) return false;
  const answer = value as Record<string, unknown>;
  return (
    answer.t === "http" &&
    typeof answer.id === "string" &&
    typeof answer.status === "number" &&
    typeof answer.contentType === "string" &&
    typeof answer.body === "string"
  );
}

export class RemoteRelay {
  readonly #control: CarrierEnd;
  readonly #logger: Logger | undefined;
  readonly #server: Bun.Server<ProxySocket>;
  readonly #answers = new Map<string, (answer: HttpAnswer | null) => void>();
  /** Sockets of the chats whose channel has not opened yet. */
  readonly #opening = new Map<string, Bun.ServerWebSocket<ProxySocket>>();
  readonly #sockets = new Set<Bun.ServerWebSocket<ProxySocket>>();
  #closed = false;

  constructor(control: CarrierEnd, logger?: Logger) {
    this.#control = control;
    this.#logger = logger;
    this.#server = Bun.serve<ProxySocket>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => this.#fetch(request, server),
      websocket: {
        maxPayloadLength: MAX_PAYLOAD_BYTES,
        // As omp's relay: Bun caps the idle time at 255 s, and its pings find a dead peer.
        idleTimeout: 0,
        open: (socket) => this.#opened(socket),
        message: (socket, message) => {
          const data = typeof message === "string" ? message : new Uint8Array(message);
          if (socket.data.channel !== null) socket.data.channel.send(data);
          else socket.data.waiting.push(data);
        },
        close: (socket) => {
          this.#sockets.delete(socket);
          this.#opening.delete(socket.data.id);
          socket.data.channel?.close(1000, "");
        },
      },
    });
  }

  get port(): number {
    return this.#server.port as number;
  }

  /** Where omp's chats reach the browser: this proxy. */
  address(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** A message from the carrier on the control link. */
  receive(data: string | Uint8Array): void {
    let message: unknown;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (!isHttpAnswer(message)) return;
    const answer = this.#answers.get(message.id);
    this.#answers.delete(message.id);
    answer?.(message);
  }

  /** Joins the carrier's channel `id` to the chat's socket waiting for it; why not, in plain words. */
  join(id: string, channel: CarrierEnd): CarriedLink | string {
    const socket = this.#opening.get(id);
    if (socket === undefined) return "No socket waits for this channel.";
    this.#opening.delete(id);
    socket.data.channel = channel;
    for (const data of socket.data.waiting.splice(0)) channel.send(data);
    return {
      receive: (data) => {
        socket.send(data);
      },
      close: () => socket.close(1000, "the browser's computer closed it"),
    };
  }

  /** Stops the proxy: the chats' sockets close, and requests still waiting fail. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const answer of this.#answers.values()) answer(null);
    this.#answers.clear();
    for (const socket of this.#sockets) socket.close(1001, "the browser's computer left");
    this.#server.stop(true);
  }

  #host(): string {
    return `127.0.0.1:${this.port}`;
  }

  #send(message: ToCarrier): void {
    this.#control.send(JSON.stringify(message));
  }

  async #fetch(request: Request, server: Bun.Server<ProxySocket>): Promise<Response | undefined> {
    // As omp's relay: a browser names its page as the Origin, omp's chats send none, and a web page must not reach it.
    if (request.headers.get("origin")) return new Response("Forbidden", { status: 403 });
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const data: ProxySocket = { id: newId(), path, channel: null, waiting: [] };
      return server.upgrade(request, { data })
        ? undefined
        : new Response("websocket upgrade required", { status: 426 });
    }
    const id = newId();
    const answered = new Promise<HttpAnswer | null>((resolve) => {
      this.#answers.set(id, resolve);
      setTimeout(() => {
        if (this.#answers.delete(id)) resolve(null);
      }, ANSWER_MS);
    });
    this.#send({ t: "http", id, method: request.method, path, host: this.#host() });
    const answer = await answered;
    if (answer === null)
      return new Response("The browser's computer did not answer.", { status: 504 });
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": answer.contentType },
    });
  }

  #opened(socket: Bun.ServerWebSocket<ProxySocket>): void {
    this.#sockets.add(socket);
    this.#opening.set(socket.data.id, socket);
    this.#send({ t: "open", id: socket.data.id, path: socket.data.path, host: this.#host() });
    setTimeout(() => {
      if (!this.#opening.delete(socket.data.id)) return;
      this.#logger?.warn("remote_relay.channel_timeout", { path: socket.data.path });
      socket.close(1011, "The browser's computer did not open the connection.");
    }, ANSWER_MS);
  }
}

function newId(): string {
  return randomBytes(12).toString("base64url");
}

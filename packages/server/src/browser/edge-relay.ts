import {
  discoverRelayEndpoints,
  publishRelayEndpoint,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/discovery";
import {
  type RelayServer,
  startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type { Logger } from "../logging";
import { RemoteRelay } from "./remote-relay";

/** The port omp's relay extension connects to unless its options say another, and where omp's chats look for it. */
export const EDGE_RELAY_PORT = 9224;

/** A tab of the user's browser, as the relay lists it. */
export interface EdgeTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface EdgeRelayState {
  /** A relay answers on the port: the app's own, or the one omp's chats started (one per machine, shared). */
  readonly running: boolean;
  /** The extension is connected: chats can drive the browser now. */
  readonly connected: boolean;
  /** The browser's own name and version, as the extension says. */
  readonly browser: string | null;
  readonly tabs: readonly EdgeTab[];
  /** Why no relay could be started, in plain words; null when all is well. */
  readonly problem: string | null;
  /** A carrier (`omp-app relay`, the desktop app) brings the browser from its computer now. */
  readonly carried: boolean;
}

/** The far end of a carried connection: the carrier's socket on the app's server. */
export interface CarrierEnd {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/** A carried connection as the server's socket sees it: what the carrier sent goes on to the relay. */
export interface CarriedLink {
  receive(data: string | Uint8Array): void;
  close(): void;
}

/**
 * What a carrier's socket brings (`/browser-relay`): its browser's extension (an extension that connects to
 * 127.0.0.1:9224 itself, up to omp 19.0); the control link of the relay omp's native host serves on its computer (omp
 * 19.1 and later, `?link=relay`); or a channel it opened for one of that relay's sockets (`?channel=<id>`). `device` is
 * the paired device the socket signed in as.
 */
export type CarryLink =
  | { readonly kind: "extension" }
  | { readonly kind: "relay"; readonly device: string | null }
  | { readonly kind: "channel"; readonly id: string; readonly device: string | null };

/** What the Browser port needs of the relay; `EdgeRelay` is the real one. */
export interface RelayHost {
  ensure(): Promise<void>;
  stop(): void;
  refresh(): Promise<EdgeRelayState>;
  state(): EdgeRelayState;
  /**
   * Joins a carrier's socket to what it brings (`CarryLink`); why not, in plain words, while "Your own browser" is not
   * chosen.
   */
  carry(end: CarrierEnd, link: CarryLink): CarriedLink | string;
}

const IDLE: EdgeRelayState = {
  running: false,
  connected: false,
  browser: null,
  tabs: [],
  problem: null,
  carried: false,
};
/** How long one look at the relay may take. */
const LOOK_MS = 1_500;

/** Where omp's chats find local relays (`relay/discovery.ts`, files under `~/.omp/browser-relay/endpoints`). */
export interface RelayDiscovery {
  /** Lists `port` for the chats until the returned function runs. */
  publish(port: number): Promise<() => Promise<void>>;
  /** The relays published now, as `http://127.0.0.1:<port>`, the newest first. */
  endpoints(): string[];
}

const OMP_DISCOVERY: RelayDiscovery = {
  publish: publishRelayEndpoint,
  endpoints: discoverRelayEndpoints,
};

/**
 * omp's browser relay for the user's own browser (omp's `browser.relay`), as omp 19.1 runs it: on the browser's own
 * computer, omp's native host serves a relay for as long as the browser runs, on a port of its own, and publishes it so
 * omp's chats find it (`relay/discovery.ts`). A browser on another computer reaches the app through a carrier
 * (`omp-app relay`, the desktop app), which brings its extension's connection here over the app's own address as a
 * paired device; the app's own relay, on its usual port, takes it (`carry`), and is published for the chats only while
 * a carrier is joined, so on a computer with its own browser the chats keep using that browser's relay. The relay
 * listens on 127.0.0.1 only, and its CDP side takes any program of this computer's user, as omp's own does. Its state is
 * read over HTTP from the relay the chats would use (`/json/version`: 503 until the extension connects; `/json/list`).
 */
export class EdgeRelay implements RelayHost {
  readonly #port: number;
  readonly #logger: Logger | undefined;
  #own: RelayServer | null = null;
  readonly #discovery: RelayDiscovery;
  /** Takes the app's relay out of omp's discovery again; set while a carrier is joined. */
  #unpublish: (() => Promise<void>) | null = null;
  /** The relay of a browser on another computer, through its carrier's control link (omp 19.1 and later). */
  #remote: {
    readonly relay: RemoteRelay;
    readonly device: string | null;
    readonly control: CarrierEnd;
    unpublish: (() => Promise<void>) | null;
  } | null = null;
  /** "Your own browser" is chosen: `ensure` ran and `stop` has not. */
  #wanted = false;
  #carriers = 0;
  #problem: string | null = null;
  #state: EdgeRelayState = IDLE;

  constructor(options: {
    readonly port: number;
    readonly logger?: Logger;
    /** omp's own unless given (tests). */
    readonly discovery?: RelayDiscovery;
  }) {
    this.#port = options.port;
    this.#logger = options.logger;
    this.#discovery = options.discovery ?? OMP_DISCOVERY;
  }

  /** The app's own relay answers on its port when this returns: started now, or already there. */
  async ensure(): Promise<void> {
    this.#wanted = true;
    const own = this.#ownAddress();
    if (this.#own !== null || (await this.#look(own)).running) return;
    try {
      this.#own = startRelayServer({
        port: this.#port,
        log: (message, data) => this.#logger?.info("edge_relay.log", { message, ...flatten(data) }),
      });
      this.#problem = null;
      this.#logger?.info("edge_relay.started", { port: this.#port });
    } catch (error) {
      // Another app's relay may have started between the look and the start: that one serves as well.
      if ((await this.#look(own)).running) return;
      this.#problem = `No relay could listen on port ${this.#port}: another program holds it.`;
      this.#logger?.warn("edge_relay.start_failed", {
        port: this.#port,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(this.#problem);
    } finally {
      await this.refresh();
    }
  }

  carry(carrier: CarrierEnd, link: CarryLink): CarriedLink | string {
    if (!this.#wanted) return "Your own browser is not chosen in the Browser panel.";
    if (link.kind === "relay") return this.#carryRelay(carrier, link.device);
    if (link.kind === "channel") {
      const remote = this.#remote;
      if (remote === null || remote.device !== link.device)
        return "No browser of that computer is joined.";
      return remote.relay.join(link.id, carrier);
    }
    const relay = new WebSocket(`ws://127.0.0.1:${this.#port}/ext`);
    relay.binaryType = "arraybuffer";
    const waiting: (string | Uint8Array)[] = [];
    let ended = false;
    this.#carriers += 1;
    this.#state = { ...this.#state, carried: true };
    if (this.#carriers === 1) this.#publish();
    const finish = (code: number, reason: string): void => {
      if (ended) return;
      ended = true;
      this.#carriers -= 1;
      this.#state = { ...this.#state, carried: this.#isCarried() };
      if (this.#carriers === 0) this.#withdraw();
      carrier.close(code, reason);
      if (relay.readyState === WebSocket.CONNECTING || relay.readyState === WebSocket.OPEN)
        relay.close(1000);
    };
    relay.onopen = () => {
      for (const data of waiting.splice(0)) relay.send(data);
    };
    relay.onmessage = (event) =>
      carrier.send(
        typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
      );
    relay.onclose = (event) =>
      finish(event.code === 1005 || event.code < 1000 ? 1000 : event.code, event.reason);
    relay.onerror = () => finish(1011, "The relay closed the connection.");
    this.#logger?.info("edge_relay.carried", { carriers: this.#carriers });
    return {
      receive: (data) => {
        if (ended) return;
        if (relay.readyState === WebSocket.OPEN) relay.send(data);
        else waiting.push(data);
      },
      close: () => finish(1000, ""),
    };
  }

  /** Stops the app's own relay; another app's is theirs to stop. Carried connections end either way. */
  stop(): void {
    this.#wanted = false;
    this.#withdraw();
    this.#endRemote("Your own browser is no longer chosen in the Browser panel.");
    if (this.#own === null) return;
    this.#own.stop();
    this.#own = null;
    this.#state = { ...IDLE, problem: this.#problem };
    this.#logger?.info("edge_relay.stopped", { port: this.#port });
  }

  /** Looks at the relay the chats would use: whether one answers, the browser connected to it, its tabs. */
  async refresh(): Promise<EdgeRelayState> {
    const own = this.#ownAddress();
    // A browser on another computer is on the proxy of its relay, or, up to omp 19.0, on the app's relay; otherwise a
    // browser on this computer is on the relay its native host published, the newest first, as omp's chats pick it.
    const address =
      this.#remote !== null
        ? this.#remote.relay.address()
        : this.#carriers > 0
          ? own
          : (this.#discovery.endpoints().find((published) => published !== own) ?? own);
    this.#state = await this.#look(address);
    return this.#state;
  }

  state(): EdgeRelayState {
    return this.#state;
  }

  #ownAddress(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async #look(base: string): Promise<EdgeRelayState> {
    const look = (path: string) =>
      fetch(`${base}${path}`, { signal: AbortSignal.timeout(LOOK_MS) });
    const carried = this.#isCarried();
    try {
      const version = await look("/json/version");
      if (!version.ok) {
        // 503: running, no browser connected yet.
        await version.body?.cancel();
        return { ...IDLE, running: true, problem: this.#problem, carried };
      }
      const info = (await version.json()) as { Browser?: unknown };
      const list = await look("/json/list");
      const targets = list.ok ? ((await list.json()) as readonly Record<string, unknown>[]) : [];
      return {
        running: true,
        connected: true,
        browser: typeof info.Browser === "string" ? info.Browser : null,
        tabs: targets
          .filter((target) => target.type === "page")
          .map((target) => ({
            id: String(target.id ?? ""),
            url: String(target.url ?? ""),
            title: String(target.title ?? ""),
            active: target.active === "true",
          })),
        problem: null,
        carried,
      };
    } catch {
      return { ...IDLE, problem: this.#problem, carried };
    }
  }

  /** Puts the app's relay into omp's discovery, so the chats drive the carried browser. */
  #publish(): void {
    void this.#discovery.publish(this.#port).then(
      (unpublish) => {
        // The last carrier may have left while the file was written.
        if (this.#carriers > 0 && this.#unpublish === null) this.#unpublish = unpublish;
        else void unpublish();
      },
      (error: unknown) =>
        this.#logger?.warn("edge_relay.publish_failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  #withdraw(): void {
    const unpublish = this.#unpublish;
    this.#unpublish = null;
    void unpublish?.();
  }

  #isCarried(): boolean {
    return this.#carriers > 0 || this.#remote !== null;
  }

  /**
   * The control link of the relay omp's native host serves on the carrier's computer: a proxy for it here, published
   * for the chats while the link lasts. One computer's browser at a time.
   */
  #carryRelay(control: CarrierEnd, device: string | null): CarriedLink | string {
    if (this.#remote !== null) return "Another computer's browser is joined already.";
    const relay = new RemoteRelay(control, this.#logger);
    const remote = { relay, device, control, unpublish: null as (() => Promise<void>) | null };
    this.#remote = remote;
    this.#state = { ...this.#state, carried: true };
    void this.#discovery.publish(relay.port).then(
      (unpublish) => {
        // The link may have ended while the file was written.
        if (this.#remote === remote) remote.unpublish = unpublish;
        else void unpublish();
      },
      (error: unknown) =>
        this.#logger?.warn("edge_relay.publish_failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    this.#logger?.info("edge_relay.remote_joined", { port: relay.port });
    return {
      receive: (data) => relay.receive(data),
      close: () => {
        if (this.#remote !== remote) return;
        this.#remote = null;
        relay.close();
        void remote.unpublish?.();
        this.#state = { ...this.#state, carried: this.#isCarried() };
        this.#logger?.info("edge_relay.remote_left", {});
      },
    };
  }

  /** Ends the remote relay's link from this side, and with it the proxy. */
  #endRemote(reason: string): void {
    const remote = this.#remote;
    if (remote === null) return;
    this.#remote = null;
    remote.relay.close();
    void remote.unpublish?.();
    remote.control.close(4409, reason.slice(0, 120));
  }
}

/** A log line's data as the app's logger takes it: plain values only. */
function flatten(data: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data ?? {}))
    out[key] = typeof value === "number" ? value : String(value);
  return out;
}

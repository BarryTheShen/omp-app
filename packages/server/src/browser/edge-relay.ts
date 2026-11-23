import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type RelayServer,
  startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type { Logger } from "../logging";

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
  /** A carrier (`omp-app relay`, the desktop app) brings the extension's connection from the browser's computer now. */
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

/** What the Browser port needs of the relay; `EdgeRelay` is the real one. */
export interface RelayHost {
  ensure(): Promise<void>;
  stop(): void;
  refresh(): Promise<EdgeRelayState>;
  state(): EdgeRelayState;
  /**
   * Joins a carrier's connection to the relay's extension endpoint, as if the extension had connected on this
   * computer; why not, in plain words, while "Your own browser" is not chosen.
   */
  carry(end: CarrierEnd): CarriedLink | string;
  /** The token an extension on the relay's own computer gives in its options; null while the relay is not the app's. */
  extensionToken(): string | null;
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

/**
 * omp's browser relay for the user's own browser (omp's `browser.relay`): the relay extension in that browser connects
 * to its port, and omp's browser tool drives the tabs through it. omp keeps one relay per machine, which its chats start
 * when they need it and share; so the app starts its own only when none answers, and otherwise uses the one there. The
 * app's own relay takes the extension only with a token that never leaves this process, so no other program on this
 * computer can attach as the browser; the extension's connection reaches it through a carrier (`carry`), the app's
 * server checking the carrier is a paired device. Its state is read the same way for either relay, over its HTTP
 * (`/json/version`: 503 until the extension connects; `/json/list`).
 */
export class EdgeRelay implements RelayHost {
  readonly #port: number;
  readonly #logger: Logger | undefined;
  #own: RelayServer | null = null;
  /**
   * The extension's token for the app's own relay, kept in the app's data folder (owner-only) so an extension on this
   * computer is set up once; a carrier never needs it, the server adds it.
   */
  readonly #tokenFile: string | undefined;
  #token = "";
  /** "Your own browser" is chosen: `ensure` ran and `stop` has not. */
  #wanted = false;
  #carriers = 0;
  #problem: string | null = null;
  #state: EdgeRelayState = IDLE;

  constructor(options: {
    readonly port: number;
    /** Where the token is kept; without one (tests), a new token each start. */
    readonly tokenFile?: string;
    readonly logger?: Logger;
  }) {
    this.#port = options.port;
    this.#tokenFile = options.tokenFile;
    this.#logger = options.logger;
  }

  /** The token, read from its file or made and kept there. */
  async #keptToken(): Promise<string> {
    const file = this.#tokenFile;
    if (file === undefined) return randomBytes(24).toString("base64url");
    const kept = (await readFile(file, "utf8").catch(() => "")).trim();
    if (/^[A-Za-z0-9_-]{32}$/.test(kept)) return kept;
    const made = randomBytes(24).toString("base64url");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${made}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return made;
  }

  /** The token an extension on this computer gives in its options; null while the relay running is not the app's. */
  extensionToken(): string | null {
    return this.#own === null ? null : this.#token;
  }

  /** A relay answers on the port when this returns: the app's own, started now, or one already there. */
  async ensure(): Promise<void> {
    this.#wanted = true;
    if (this.#own !== null || (await this.refresh()).running) return;
    try {
      this.#token = await this.#keptToken();
      this.#own = startRelayServer({
        port: this.#port,
        token: this.#token,
        log: (message, data) => this.#logger?.info("edge_relay.log", { message, ...flatten(data) }),
      });
      this.#problem = null;
      this.#logger?.info("edge_relay.started", { port: this.#port });
    } catch (error) {
      // omp's chats may have started theirs between the look and the start: that one serves as well.
      if ((await this.refresh()).running) return;
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

  carry(carrier: CarrierEnd): CarriedLink | string {
    if (!this.#wanted) return "Your own browser is not chosen in the Browser panel.";
    // The token goes only to the app's own relay; one omp's chats started takes the extension without one.
    const query = this.#own === null ? "" : `?token=${encodeURIComponent(this.#token)}`;
    const relay = new WebSocket(`ws://127.0.0.1:${this.#port}/ext${query}`);
    relay.binaryType = "arraybuffer";
    const waiting: (string | Uint8Array)[] = [];
    let ended = false;
    this.#carriers += 1;
    this.#state = { ...this.#state, carried: true };
    const finish = (code: number, reason: string): void => {
      if (ended) return;
      ended = true;
      this.#carriers -= 1;
      this.#state = { ...this.#state, carried: this.#carriers > 0 };
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

  /** Stops the app's own relay; one omp's chats started is theirs to stop. Carried connections end either way. */
  stop(): void {
    this.#wanted = false;
    if (this.#own === null) return;
    this.#own.stop();
    this.#own = null;
    this.#token = "";
    this.#state = { ...IDLE, problem: this.#problem };
    this.#logger?.info("edge_relay.stopped", { port: this.#port });
  }

  /** Looks at the relay on the port: whether one answers, the browser connected to it, its tabs. */
  async refresh(): Promise<EdgeRelayState> {
    const base = `http://127.0.0.1:${this.#port}`;
    const look = (path: string) =>
      fetch(`${base}${path}`, { signal: AbortSignal.timeout(LOOK_MS) });
    try {
      const version = await look("/json/version");
      if (!version.ok) {
        // 503: running, no browser connected yet.
        await version.body?.cancel();
        this.#state = {
          ...IDLE,
          running: true,
          problem: this.#problem,
          carried: this.#carriers > 0,
        };
        return this.#state;
      }
      const info = (await version.json()) as { Browser?: unknown };
      const list = await look("/json/list");
      const targets = list.ok ? ((await list.json()) as readonly Record<string, unknown>[]) : [];
      this.#state = {
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
        carried: this.#carriers > 0,
      };
    } catch {
      this.#state = { ...IDLE, problem: this.#problem, carried: this.#carriers > 0 };
    }
    return this.#state;
  }

  state(): EdgeRelayState {
    return this.#state;
  }
}

/** A log line's data as the app's logger takes it: plain values only. */
function flatten(data: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data ?? {}))
    out[key] = typeof value === "number" ? value : String(value);
  return out;
}

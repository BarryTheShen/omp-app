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
}

/** What the Browser port needs of the relay; `EdgeRelay` is the real one. */
export interface RelayHost {
  ensure(): Promise<void>;
  stop(): void;
  refresh(): Promise<EdgeRelayState>;
  state(): EdgeRelayState;
}

const IDLE: EdgeRelayState = {
  running: false,
  connected: false,
  browser: null,
  tabs: [],
  problem: null,
};
/** How long one look at the relay may take. */
const LOOK_MS = 1_500;

/**
 * omp's browser relay for the user's own browser (omp's `browser.relay`): the relay extension in that browser connects
 * to its port, and omp's browser tool drives the tabs through it. omp keeps one relay per machine, which its chats start
 * when they need it and share; so the app starts its own only when none answers, and otherwise uses the one there. It
 * listens on 127.0.0.1 only; anything on this machine can drive the connected browser while it runs. Its state is read
 * the same way for either, over its HTTP (`/json/version`: 503 until the extension connects; `/json/list`).
 */
export class EdgeRelay implements RelayHost {
  readonly #port: number;
  readonly #logger: Logger | undefined;
  #own: RelayServer | null = null;
  #problem: string | null = null;
  #state: EdgeRelayState = IDLE;

  constructor(options: { readonly port: number; readonly logger?: Logger }) {
    this.#port = options.port;
    this.#logger = options.logger;
  }

  /** A relay answers on the port when this returns: the app's own, started now, or one already there. */
  async ensure(): Promise<void> {
    if (this.#own !== null || (await this.refresh()).running) return;
    try {
      this.#own = startRelayServer({
        port: this.#port,
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

  /** Stops the app's own relay; one omp's chats started is theirs to stop. */
  stop(): void {
    if (this.#own === null) return;
    this.#own.stop();
    this.#own = null;
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
        this.#state = { ...IDLE, running: true, problem: this.#problem };
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
      };
    } catch {
      this.#state = { ...IDLE, problem: this.#problem };
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

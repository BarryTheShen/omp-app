import type { Logger } from "../../../logging/logger";

/** How long omp's stats page may take to start listening: its first start builds its page. */
export const STATS_START_MS = 120_000;

/** The line `omp stats` prints once its page listens, `Dashboard available at: http://127.0.0.1:43123`: its port. */
const READY = /Dashboard available at:\s*https?:\/\/[^\s/:]+:(\d+)/;

export interface OmpStatsOptions {
  /** How the server starts omp (`omp`, or the bundled one). */
  readonly command: readonly string[];
  readonly env: Record<string, string>;
  readonly logger?: Logger;
  readonly startMs?: number;
}

/**
 * omp's statistics page (#2836 D6): `omp stats` on a port of the system's choosing at 127.0.0.1, started when first asked
 * and kept while the server runs, so the shares can open it on the paired devices. omp opens the page in a browser
 * after it starts; `BROWSER=true` makes that a no-op on a server, where no one sits at the screen.
 */
export class OmpStats {
  readonly #options: OmpStatsOptions;
  #child: Bun.Subprocess<"ignore", "pipe", "ignore"> | null = null;
  #port: number | null = null;
  #starting: Promise<number> | null = null;

  constructor(options: OmpStatsOptions) {
    this.#options = options;
  }

  /** The page's port, once it listens; started first if it does not run. */
  start(): Promise<number> {
    if (this.#port !== null && this.#child !== null && this.#child.exitCode === null)
      return Promise.resolve(this.#port);
    this.#starting ??= this.#spawn().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** Stops the page with its process group. */
  stop(): void {
    const child = this.#child;
    this.#child = null;
    this.#port = null;
    if (child === null || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }

  async #spawn(): Promise<number> {
    this.stop();
    const child = Bun.spawn(
      [...this.#options.command, "stats", "--port", "0", "--host", "127.0.0.1"],
      {
        env: { ...this.#options.env, BROWSER: "true" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        // Its own process group, so that its own children stop with it.
        detached: true,
      },
    );
    this.#child = child;
    const port = await this.#ready(child);
    if (port === null) {
      this.stop();
      throw new Error("omp's statistics page did not start.");
    }
    this.#port = port;
    this.#options.logger?.info("stats.started", { port, pid: child.pid });
    void child.exited.then((code) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#port = null;
      this.#options.logger?.info("stats.ended", { code });
    });
    return port;
  }

  /**
   * Reads omp's output until it names the page's address; null when it ends or takes too long first. The output is read
   * on to its end after that and dropped, so omp's later lines never meet a closed pipe (EPIPE would stop it).
   */
  async #ready(child: Bun.Subprocess<"ignore", "pipe", "ignore">): Promise<number | null> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let found: (port: number | null) => void = () => undefined;
    const ready = new Promise<number | null>((resolve) => {
      found = resolve;
    });
    void (async () => {
      let named = false;
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        if (named) continue;
        text += decoder.decode(value, { stream: true });
        const port = Number(READY.exec(text)?.[1] ?? Number.NaN);
        if (Number.isNaN(port)) continue;
        named = true;
        text = "";
        found(Number.isInteger(port) && port > 0 && port < 65_536 ? port : null);
      }
      found(null);
    })();
    const timer = setTimeout(() => found(null), this.#options.startMs ?? STATS_START_MS);
    try {
      return await ready;
    } finally {
      clearTimeout(timer);
    }
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageHistoryResult, UsageLimitsResult, UsagePaceResult } from "@omp-app/contracts";
import { type WindowReading, windowPace } from "./pace";

/** How long readings are kept: a day, past any 5-hour window, enough for a day's pattern. */
export const READINGS_KEEP_MS = 24 * 60 * 60_000;

interface Logger {
  warn(event: string, fields: Record<string, string | number>): void;
}

/** The file: `{ "version": 1, "windows": { "<provider>\u0000<label>": [[at, usedPercent, resetsAt], …] } }`. */
interface ReadingsFile {
  readonly version: 1;
  readonly windows: Record<string, readonly (readonly [number, number, string | null])[]>;
}

const keyOf = (providerId: string, label: string): string => `${providerId}\u0000${label}`;

/**
 * Each usage window's readings over the last day (#2836), from every fresh read of the usage limits (the server's own,
 * every 5 minutes or every minute near a limit, and the pages'), kept on disk so a restart keeps the trend; and from
 * them each window's pace (`windowPace`).
 */
export class UsageReadings {
  readonly #windows = new Map<string, WindowReading[]>();
  readonly #path: string;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  #saving: Promise<void> = Promise.resolve();

  private constructor(path: string, now: () => number, logger: Logger | undefined) {
    this.#path = path;
    this.#now = now;
    this.#logger = logger;
  }

  /** The readings kept in `path` (none when it is missing or unreadable). */
  static async open(
    path: string,
    options: { readonly now?: () => number; readonly logger?: Logger } = {},
  ): Promise<UsageReadings> {
    const readings = new UsageReadings(path, options.now ?? Date.now, options.logger);
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT")
        options.logger?.warn("usage_readings.load_failed", { error: String(failure) });
    }
    if (text !== null) {
      try {
        const saved = JSON.parse(text) as Partial<ReadingsFile>;
        for (const [key, rows] of Object.entries(saved.windows ?? {}))
          readings.#windows.set(
            key,
            rows.flatMap(([at, usedPercent, resetsAt]) =>
              typeof at === "number" && typeof usedPercent === "number"
                ? [{ at, usedPercent, resetsAt: typeof resetsAt === "string" ? resetsAt : null }]
                : [],
            ),
          );
      } catch (failure) {
        options.logger?.warn("usage_readings.load_failed", { error: String(failure) });
      }
    }
    readings.#trim();
    return readings;
  }

  /** One read of the usage limits: each window's reading, then the day's kept on disk. */
  add(result: UsageLimitsResult): void {
    if (result.state !== "ready") return;
    const fetched = Date.parse(result.fetchedAt);
    const at = Number.isNaN(fetched) ? this.#now() : fetched;
    for (const provider of result.providers)
      for (const window of provider.windows) {
        const key = keyOf(provider.providerId, window.label);
        const rows = this.#windows.get(key) ?? [];
        // A cached read handed out again is the same reading.
        if (rows.at(-1)?.at === at) continue;
        rows.push({ at, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
        this.#windows.set(key, rows);
      }
    this.#trim();
    this.#keep();
  }

  /** Each window's readings over the last day, oldest first, for its graph (#15). */
  history(): UsageHistoryResult {
    this.#trim();
    return {
      windows: [...this.#windows].map(([key, rows]) => {
        const [providerId = "", label = ""] = key.split("\u0000");
        return {
          providerId,
          label,
          readings: rows
            .slice(-5_000)
            .map((reading) => [Math.round(reading.at), reading.usedPercent] as [number, number]),
        };
      }),
    };
  }

  /** Each window's pace from its readings, and how many readings it has. */
  pace(): UsagePaceResult {
    const now = this.#now();
    return {
      windows: [...this.#windows].map(([key, rows]) => {
        const [providerId = "", label = ""] = key.split("\u0000");
        const pace = windowPace(rows, now);
        return {
          providerId,
          label,
          perHour: pace.perHour,
          fullAt: pace.fullAt === null ? null : new Date(pace.fullAt).toISOString(),
          atReset: pace.atReset,
          readings: rows.length,
        };
      }),
    };
  }

  #trim(): void {
    const oldest = this.#now() - READINGS_KEEP_MS;
    for (const [key, rows] of this.#windows) {
      const kept = rows.filter((reading) => reading.at >= oldest);
      if (kept.length === 0) this.#windows.delete(key);
      else this.#windows.set(key, kept);
    }
  }

  /** Writes the readings after the writes before it, so the file holds the last ones. */
  #keep(): void {
    const file: ReadingsFile = {
      version: 1,
      windows: Object.fromEntries(
        [...this.#windows].map(([key, rows]) => [
          key,
          rows.map((reading) => [reading.at, reading.usedPercent, reading.resetsAt] as const),
        ]),
      ),
    };
    this.#saving = this.#saving
      .then(async () => {
        await mkdir(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.tmp`;
        await writeFile(temporary, `${JSON.stringify(file)}\n`);
        await rename(temporary, this.#path);
      })
      .catch((failure: unknown) => {
        this.#logger?.warn("usage_readings.save_failed", { error: String(failure) });
      });
  }

  /** The last write's end (tests). */
  saved(): Promise<void> {
    return this.#saving;
  }
}

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { logPath, readLogTail } from "./files";
import { scrubText, truncate } from "./scrub";

/** Both files together stay under this: the current one and the one before it. */
export const DEFAULT_MAX_LOG_BYTES = 15 * 1024 * 1024;

type FieldValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type LogFields = Readonly<Record<string, FieldValue>>;
type Level = "INFO" | "WARN" | "ERROR";

export interface Logger {
  /** The current log file (older lines are in the same name with `.1`). */
  readonly path: string;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Exact secret values (this launch's token) that must never be written, whatever the text. */
  addSecret(value: string): void;
  /** The last `lines` lines, oldest first, across the current and the previous file. */
  tail(lines: number): string;
}

export interface LoggerOptions {
  readonly dir: string;
  /** Total size of the two files; default 15 MiB. */
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

/** Most values are cut at this; a stack trace is worth more room. */
const FIELD_VALUE_MAX = 300;
const STACK_VALUE_MAX = 2_000;

function formatValue(key: string, value: FieldValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = Array.isArray(value) ? value.join(",") : String(value);
  const short = truncate(text, key === "stack" ? STACK_VALUE_MAX : FIELD_VALUE_MAX);
  // A value with spaces, quotes or line breaks is JSON-quoted (which escapes the line breaks), so
  // one event is always one line.
  return /^[\w./:@+,-]+$/.test(short) ? short : JSON.stringify(short);
}

class FileLogger implements Logger {
  readonly path: string;
  readonly #previous: string;
  readonly #halfMax: number;
  readonly #now: () => Date;
  readonly #secrets: string[] = [];
  #bytes = 0;

  constructor(options: LoggerOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.path = logPath(options.dir);
    this.#previous = `${this.path}.1`;
    this.#halfMax = Math.floor((options.maxBytes ?? DEFAULT_MAX_LOG_BYTES) / 2);
    this.#now = options.now ?? (() => new Date());
    this.#bytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (this.#bytes >= this.#halfMax) this.#rotate();
  }

  info(event: string, fields?: LogFields): void {
    this.#write("INFO", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.#write("WARN", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.#write("ERROR", event, fields);
  }

  addSecret(value: string): void {
    if (value.length >= 6) this.#secrets.push(value);
  }

  tail(lines: number): string {
    return readLogTail(dirname(this.path), lines);
  }

  #write(level: Level, event: string, fields: LogFields | undefined): void {
    const parts = [this.#now().toISOString(), level.padEnd(5), event];
    for (const [key, value] of Object.entries(fields ?? {})) {
      const formatted = formatValue(key, value);
      if (formatted !== undefined) parts.push(`${key}=${formatted}`);
    }
    const line = `${scrubText(parts.join(" "), this.#secrets)}\n`;
    try {
      appendFileSync(this.path, line, { mode: 0o600 });
      this.#bytes += Buffer.byteLength(line);
      if (this.#bytes >= this.#halfMax) this.#rotate();
    } catch {
      // A log that can't be written must never take the app down with it.
    }
  }

  #rotate(): void {
    try {
      renameSync(this.path, this.#previous);
      this.#bytes = 0;
      chmodSync(this.#previous, 0o600);
    } catch {
      // Keep appending to the current file if the rename is refused.
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new FileLogger(options);
}

/** For tests and embeddings that don't log: every call is a no-op and the tail is empty. */
export function createNullLogger(): Logger {
  return {
    path: "",
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    addSecret: () => undefined,
    tail: () => "",
  };
}

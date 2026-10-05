/**
 * Wraps a live {@link RpcDuplex} and captures every line crossing it as a C0 fixture, redacted as
 * it is captured. The recorder taps raw bytes before any JSONL/v2-chunk reassembly, so a fixture
 * preserves exactly what a real omp process wrote (`rpc_chunk` sequences included), the same bytes
 * the wrapped session keeps receiving unmodified.
 */
import type { Fixture, FixtureFrame, FixturePlaceholder } from "@omp-app/contracts";
import { serializeFixture } from "@omp-app/contracts";
import type { RpcDuplex } from "../session";
import {
  addCounts,
  createRedactionCounts,
  type PathSubstitution,
  type RedactionCounts,
  redactLine,
} from "./redaction";

export interface FixtureRecorderOptions {
  /** Absolute throwaway directories this recording used, each mapped to its placeholder. */
  readonly paths: readonly PathSubstitution[];
  /** Monotonic milliseconds clock; overridable so a test can drive it deterministically. */
  readonly now?: () => number;
}

/** The slice of the global `TextDecoder` this module needs, declared structurally so the package
 * stays free of DOM/Bun ambient types. */
interface Utf8StreamDecoder {
  decode(input: Uint8Array, options?: { stream?: boolean }): string;
}

interface RecorderRuntime {
  TextDecoder?: new () => Utf8StreamDecoder;
  performance?: { now(): number };
  Date?: { now(): number };
}

function runtime(): RecorderRuntime {
  return globalThis as unknown as RecorderRuntime;
}

function createUtf8StreamDecoder(): Utf8StreamDecoder {
  const ctor = runtime().TextDecoder;
  if (ctor === undefined) throw new Error("This runtime has no TextDecoder");
  return new ctor();
}

function monotonicNow(): number {
  return runtime().performance?.now() ?? runtime().Date?.now() ?? 0;
}

function splitUtf8Lines(
  decoder: Utf8StreamDecoder,
  buffer: { text: string },
  chunk: Uint8Array,
): string[] {
  buffer.text += decoder.decode(chunk, { stream: true });
  const lines: string[] = [];
  let index = buffer.text.indexOf("\n");
  while (index >= 0) {
    lines.push(buffer.text.slice(0, index));
    buffer.text = buffer.text.slice(index + 1);
    index = buffer.text.indexOf("\n");
  }
  return lines;
}

/** Records a fixture while transparently forwarding the wrapped duplex's traffic. */
export class FixtureRecorder implements RpcDuplex {
  readonly #duplex: RpcDuplex;
  readonly #paths: readonly PathSubstitution[];
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #frames: FixtureFrame[] = [];
  readonly #counts: RedactionCounts = createRedactionCounts();
  readonly #placeholdersUsed = new Set<FixturePlaceholder>();
  readonly #stdoutDecoder = createUtf8StreamDecoder();
  readonly #stdoutBuffer = { text: "" };
  #lastT = 0;

  constructor(duplex: RpcDuplex, options: FixtureRecorderOptions) {
    this.#duplex = duplex;
    this.#paths = options.paths;
    this.#now = options.now ?? monotonicNow;
    this.#startedAt = this.#now();
  }

  get frames(): readonly FixtureFrame[] {
    return this.#frames;
  }

  get redactionCounts(): RedactionCounts {
    return { ...this.#counts };
  }

  get placeholdersUsed(): FixturePlaceholder[] {
    return [...this.#placeholdersUsed].sort();
  }

  writeLine(line: string): void | PromiseLike<void> {
    this.#record("stdin", line.endsWith("\n") ? line.slice(0, -1) : line);
    return this.#duplex.writeLine(line);
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    return this.#duplex.onChunk((chunk) => {
      for (const rawLine of splitUtf8Lines(this.#stdoutDecoder, this.#stdoutBuffer, chunk)) {
        this.#record("stdout", rawLine);
      }
      listener(chunk);
    });
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    return this.#duplex.onClose(listener);
  }

  close(): void | PromiseLike<void> {
    return this.#duplex.close?.();
  }

  /** Builds the finished fixture; throws via `serializeFixture` if anything was not scrubbed. */
  toFixture(
    header: Omit<Fixture["header"], "placeholders" | "redactions">,
    declaredPlaceholders: readonly FixturePlaceholder[] = [],
  ): Fixture {
    const placeholders = [...new Set([...this.placeholdersUsed, ...declaredPlaceholders])];
    const fixture: Fixture = {
      header: {
        ...header,
        placeholders,
        redactions: { ...this.#counts },
      },
      frames: this.#frames,
    };
    serializeFixture(fixture);
    return fixture;
  }

  #record(dir: "stdin" | "stdout", rawLine: string): void {
    if (rawLine.length === 0) return;
    const { text, counts } = redactLine(rawLine, this.#paths);
    addCounts(this.#counts, counts);
    for (const substitution of this.#paths) {
      if (text.includes(substitution.placeholder))
        this.#placeholdersUsed.add(substitution.placeholder);
    }
    const t = Math.max(0, Math.round(this.#now() - this.#startedAt));
    this.#lastT = Math.max(t, this.#lastT);
    this.#frames.push({ t: this.#lastT, dir, line: text });
  }
}

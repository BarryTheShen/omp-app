/**
 * Replays a C0 fixture deterministically. `FixtureSession` is itself an {@link RpcDuplex}, so a
 * real `RpcSession` drives it exactly as it would a live omp process: it writes command/response
 * lines, and the fixture answers with the frames recorded for that scenario.
 *
 * Id rewriting is scoped to what a replayed command/response pair needs: the fixture remembers,
 * per matched stdin line, the id the recorded command used and the id the replaying caller
 * actually wrote, and substitutes the latter into any later `response` or `prompt_result` frame
 * that names the former. Every other id in a frame (`extension_ui_request.id`, `messageId`,
 * `toolCallId`, …) originates on omp's side and is replayed byte for byte. A `response` or
 * `prompt_result` large enough to need its own `rpc_chunk` sequence replays with its originally
 * recorded id unchanged; none of the C0 fixtures this package records put a command id inside a
 * chunked frame.
 */
import type { Fixture, FixtureFrame } from "@omp-app/contracts";
import type { RpcDuplex } from "../session";

export interface FixtureSessionTimer {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FixtureSessionOptions {
  readonly fixture: Fixture;
  /** Space stdout frames by their recorded `t` deltas instead of replaying as fast as possible. */
  readonly realtime?: boolean;
  readonly timer?: FixtureSessionTimer;
}
interface SessionRuntime {
  setTimeout?: (handler: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  TextEncoder?: new () => { encode(input: string): Uint8Array };
}

function runtime(): SessionRuntime {
  return globalThis as unknown as SessionRuntime;
}

function defaultTimer(): FixtureSessionTimer {
  return {
    setTimeout: (handler, delayMs) => runtime().setTimeout?.(handler, delayMs),
    clearTimeout: (handle) => runtime().clearTimeout?.(handle),
  };
}

function createEncoder(): { encode(input: string): Uint8Array } {
  const ctor = runtime().TextEncoder;
  if (ctor === undefined) throw new Error("This runtime has no TextEncoder");
  return new ctor();
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) =>
        Object.hasOwn(b as Record<string, unknown>, key) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function withoutId(value: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = value;
  return rest;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const ID_CORRELATED_TYPES: Record<string, true> = { response: true, prompt_result: true };

/** A duplex that deterministically replays one recorded C0 fixture scenario. */
export class FixtureSession implements RpcDuplex {
  readonly #frames: readonly FixtureFrame[];
  readonly #realtime: boolean;
  readonly #timer: FixtureSessionTimer;
  readonly #idMap = new Map<string, string>();
  readonly #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(cause?: unknown) => void>();
  #cursor = 0;
  #closed = false;
  #started = false;
  #emitTail: Promise<void> = Promise.resolve();
  #pendingTimers = new Set<unknown>();
  readonly #encoder = createEncoder();

  constructor(options: FixtureSessionOptions) {
    this.#frames = options.fixture.frames;
    this.#realtime = options.realtime ?? false;
    this.#timer = options.timer ?? defaultTimer();
  }

  /** The recorded frame a matching `writeLine` must come next, or `undefined` past the end. */
  get nextExpectedFrame(): FixtureFrame | undefined {
    return this.#frames[this.#cursor];
  }

  writeLine(line: string): void {
    if (this.#closed) return;
    const expected = this.#frames[this.#cursor];
    if (expected === undefined || expected.dir !== "stdin") {
      this.#fail(
        `Fixture replay mismatch: no recorded stdin frame left to match ${JSON.stringify(line)}`,
      );
      return;
    }
    const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
    const actual = parseLine(trimmed);
    const recorded = parseLine(expected.line);
    const matches =
      actual !== undefined && recorded !== undefined
        ? deepEqual(withoutId(actual), withoutId(recorded))
        : trimmed === expected.line;
    if (!matches) {
      this.#fail(
        `Fixture replay mismatch at frame ${this.#cursor}: expected ${expected.line}, got ${trimmed}`,
      );
      return;
    }
    const recordedId = typeof recorded?.id === "string" ? recorded.id : undefined;
    const actualId = typeof actual?.id === "string" ? actual.id : undefined;
    if (recordedId !== undefined && actualId !== undefined) this.#idMap.set(recordedId, actualId);
    this.#cursor += 1;
    this.#advance();
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    if (!this.#started) {
      this.#started = true;
      this.#advance();
    }
    return () => this.#chunkListeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handle of this.#pendingTimers) this.#timer.clearTimeout(handle);
    this.#pendingTimers.clear();
    for (const listener of [...this.#closeListeners]) listener();
  }

  #fail(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handle of this.#pendingTimers) this.#timer.clearTimeout(handle);
    this.#pendingTimers.clear();
    const cause = new Error(message);
    for (const listener of [...this.#closeListeners]) listener(cause);
  }

  /** Emits every consecutive recorded stdout frame starting at the cursor, stopping at a stdin frame. */
  #advance(): void {
    while (this.#frames[this.#cursor]?.dir === "stdout") {
      const index = this.#cursor;
      this.#cursor += 1;
      this.#schedule(index);
    }
  }

  #schedule(index: number): void {
    const frame = this.#frames[index];
    if (frame === undefined) return;
    const previous = this.#frames[index - 1];
    const delay = this.#realtime ? Math.max(0, frame.t - (previous?.t ?? 0)) : 0;
    this.#emitTail = this.#emitTail.then(
      () =>
        new Promise<void>((resolve) => {
          const handle = this.#timer.setTimeout(() => {
            this.#pendingTimers.delete(handle);
            this.#emit(frame);
            resolve();
          }, delay);
          this.#pendingTimers.add(handle);
        }),
    );
  }

  #emit(frame: FixtureFrame): void {
    if (this.#closed) return;
    const line = this.#rewriteId(frame.line);
    const bytes = this.#encoder.encode(`${line}\n`);
    for (const listener of [...this.#chunkListeners]) listener(bytes);
  }

  #rewriteId(line: string): string {
    if (this.#idMap.size === 0) return line;
    const parsed = parseLine(line);
    if (parsed === undefined) return line;
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    if (type === undefined || ID_CORRELATED_TYPES[type] !== true) return line;
    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    if (id === undefined) return line;
    const replacement = this.#idMap.get(id);
    if (replacement === undefined) return line;
    return JSON.stringify({ ...parsed, id: replacement });
  }
}

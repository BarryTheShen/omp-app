import { describe, expect, test } from "bun:test";
import { type AppError, AppFailure } from "@omp-app/contracts";
import { type RpcDuplex, RpcSession, type RpcSessionTimer } from "../src/session";

/*
 * Issue #980 and the text half of #1716. The failures the package creates with code omp_exited reach a chat's banner,
 * and a run notice, as written, so their words must be plain: no "RPC" and no "transport". The first three tests drive
 * each path that makes one. The last reads the package's source, so an omp_exited site added later cannot carry words
 * the three tests do not reach.
 */

const INTERNAL_WORDS = /\bRPC\b|transport/i;
const encoder = new TextEncoder();

/** A transport the test drives: it records the lines written, emits stdout frames, and fails writes or closes on demand. */
class ScriptedDuplex implements RpcDuplex {
  readonly writes: string[] = [];
  failWrites = false;
  readonly #chunkListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(cause?: unknown) => void>();

  writeLine(line: string): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error("write EPIPE"));
    this.writes.push(line);
    return Promise.resolve();
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#chunkListeners.add(listener);
    return () => this.#chunkListeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  emit(frame: Record<string, unknown>): void {
    const bytes = encoder.encode(`${JSON.stringify(frame)}\n`);
    for (const listener of [...this.#chunkListeners]) listener(bytes);
  }

  closeFromPeer(cause?: unknown): void {
    for (const listener of [...this.#closeListeners]) listener(cause);
  }
}

/** A timer that never fires, so no command times out during these tests. */
const neverFires: RpcSessionTimer = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
};

async function readySession(duplex: ScriptedDuplex): Promise<RpcSession> {
  const session = new RpcSession(duplex, { timer: neverFires });
  const started = session.start();
  duplex.emit({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1],
    maxFrameBytes: 1024 * 1024,
    maxReassembledFrameBytes: 64 * 1024 * 1024,
  });
  await started;
  return session;
}

/** The app error a call fails with; fails the test when the call succeeds. */
async function failureOf(call: PromiseLike<unknown>): Promise<AppError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof AppFailure) return error.appError;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("omp_exited failures the package creates are said in plain words", () => {
  test("omp stops after it is ready: a command still waiting fails, and the message has no internal word", async () => {
    const duplex = new ScriptedDuplex();
    const session = await readySession(duplex);
    const waiting = failureOf(session.send({ type: "get_state" }));
    duplex.closeFromPeer(new Error("stream ended"));

    const appError = await waiting;
    expect(appError).toMatchObject({ code: "omp_exited", retryable: true });
    expect(appError.message).not.toMatch(INTERNAL_WORDS);
  });

  test("omp stops while it is starting: the start fails, and the message has no internal word", async () => {
    const duplex = new ScriptedDuplex();
    const session = new RpcSession(duplex, { timer: neverFires });
    const starting = failureOf(session.start());
    duplex.closeFromPeer();

    const appError = await starting;
    expect(appError).toMatchObject({ code: "omp_exited", retryable: true });
    expect(appError.message).not.toMatch(INTERNAL_WORDS);
  });

  test("a command that cannot be written fails, and the message has no internal word", async () => {
    const duplex = new ScriptedDuplex();
    const session = await readySession(duplex);
    duplex.failWrites = true;

    const appError = await failureOf(session.send({ type: "get_state" }));
    expect(appError).toMatchObject({ code: "omp_exited", retryable: true });
    expect(appError.message).not.toMatch(INTERNAL_WORDS);
  });

  test("every omp_exited in the package's source has a literal message, and none has an internal word", async () => {
    const files = Array.from(
      new Bun.Glob("**/*.ts").scanSync({ cwd: `${import.meta.dir}/../src`, absolute: true }),
    ).filter((file) => !file.endsWith(".test.ts"));
    let sites = 0;
    const messages: string[] = [];
    for (const file of files) {
      const text = await Bun.file(file).text();
      sites += text.match(/"omp_exited"/g)?.length ?? 0;
      for (const match of text.matchAll(/createFailure\(\s*"omp_exited",\s*"((?:[^"\\]|\\.)*)"/g)) {
        messages.push(match[1] ?? "");
      }
    }

    expect(messages.length).toBeGreaterThan(0);
    expect(messages).toHaveLength(sites);
    expect(messages.filter((message) => INTERNAL_WORDS.test(message))).toEqual([]);
  });
});

/**
 * The chat host's input: the server's lines from stdin, and the order prompts are admitted in. Kept free of omp's
 * modules, so it can be tested without omp's process handlers.
 */

/** What `linesOf` reads: stdin's reader, or a test's stand-in. */
export interface ByteReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
}

/** The server's lines, decoded; a line or a character split across reads is joined first. */
export async function* linesOf(reader: ByteReader): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk: Awaited<ReturnType<ByteReader["read"]>>;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done || chunk.value === undefined) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/**
 * Orders user input. Each prompt and abort gets a number when it is read; an abort invalidates every prompt read before
 * it. Prompts are admitted one at a time in the order read, and the next starts once the previous one was admitted, not
 * when its reply ends. (omp's `RpcUserInputGate`, 18.12.6 `modes/rpc/rpc-mode.ts:522-565`; session changes join in
 * H5.2.)
 */
export class InputGate {
  #tail: Promise<unknown> = Promise.resolve();
  #sequence = 0;
  #validFrom = 0;

  /** Numbers a request when it is read. */
  accept(kind: "input" | "abort"): number {
    const sequence = ++this.#sequence;
    if (kind === "abort") this.#validFrom = sequence;
    return sequence;
  }

  /** False once an abort read after this input invalidated it. */
  isCurrent(sequence: number): boolean {
    return sequence >= this.#validFrom;
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

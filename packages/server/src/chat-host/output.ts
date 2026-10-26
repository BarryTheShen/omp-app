/**
 * The chat host's stdout, the protocol's only channel. One writer owns it, so lines stay whole and in order. Anything
 * else in the process that writes to stdout (an extension's `console.log`, a stray `process.stdout.write`) goes to stderr
 * instead, where the server keeps the tail. (omp's own RPC mode only turns terminal notifications off,
 * `PI_NOTIFICATIONS`, and there a stray line breaks the reader.)
 */

/** The part of a writable stream the writer uses: `process.stdout`, or a test's stand-in. */
export interface LineSink {
  write(text: string, callback: (error?: Error | null) => void): boolean;
  on(event: "drain", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface LineWriter {
  /** Queues one line, without its newline. Lines are written in call order; nothing is written after a failure. */
  write(line: string): void;
  /** Resolves once every queued line was handed to the pipe; rejects with the failure if the pipe failed. */
  flush(): Promise<void>;
}

/**
 * Writes lines while the sink accepts them and queues the rest until it drains. A failed write or a closed sink fails
 * the writer once: `onFailure` is told, and later lines are dropped.
 */
export function createLineWriter(sink: LineSink, onFailure: (error: Error) => void): LineWriter {
  const queue: string[] = [];
  let head = 0;
  let blocked = false;
  let inFlight = 0;
  let failure: Error | undefined;
  const waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  const settle = (): void => {
    if (failure !== undefined || inFlight > 0 || head < queue.length) return;
    for (const waiter of waiters.splice(0)) waiter.resolve();
  };
  const fail = (cause: unknown): void => {
    if (failure !== undefined) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    queue.length = 0;
    head = 0;
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
    onFailure(failure);
  };
  const send = (text: string): void => {
    inFlight++;
    let accepted: boolean;
    try {
      accepted = sink.write(text, (error) => {
        inFlight--;
        if (error) fail(error);
        else settle();
      });
    } catch (error) {
      inFlight--;
      fail(error);
      return;
    }
    if (!accepted) blocked = true;
  };
  const pump = (): void => {
    while (!blocked && failure === undefined && head < queue.length) {
      const text = queue[head++] as string;
      send(text);
    }
    if (head === queue.length) {
      queue.length = 0;
      head = 0;
    }
    settle();
  };

  sink.on("drain", () => {
    blocked = false;
    pump();
  });
  sink.on("error", fail);
  sink.on("close", () => fail(new Error("stdout closed before every line was written")));

  return {
    write(line) {
      if (failure !== undefined) return;
      const text = `${line}\n`;
      if (blocked || head < queue.length) queue.push(text);
      else send(text);
    },
    flush() {
      if (failure !== undefined) return Promise.reject(failure);
      if (inFlight === 0 && head === queue.length) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

/**
 * Takes stdout for the protocol: returns its writer, and sends every other stdout write in the process to stderr. Call
 * once, before anything else in the process can write.
 */
export function takeOverStdout(onFailure: (error: Error) => void): LineWriter {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  const sink: LineSink = {
    write: (text, callback) => write(text, callback),
    on: (event: "drain" | "error" | "close", listener: (error: Error) => void) =>
      stdout.on(event, listener),
  };
  const toStderr = (chunk: string | Uint8Array, ...rest: unknown[]): boolean =>
    Boolean(Reflect.apply(process.stderr.write, process.stderr, [chunk, ...rest]));
  // The same call shapes as stdout's overloaded `write`, forwarded as they come.
  stdout.write = toStderr as unknown as typeof stdout.write;
  const log = (...values: unknown[]): void => console.error(...values);
  console.log = log;
  console.info = log;
  console.debug = log;
  console.dir = log;
  console.table = log;
  return createLineWriter(sink, onFailure);
}

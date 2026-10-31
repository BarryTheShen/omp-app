/**
 * The chat host's link to the server over a Unix socket (D2, `D2-step1-plan.md`), in place of stdin and stdout: the
 * server can go and come back, and the host keeps its chat meanwhile.
 *
 * - One server at a time: a second connection is closed at once.
 * - The server's lines keep coming across connections; a line cut off by a connection that ended is dropped.
 * - Lines written while no server is connected are dropped: nothing could take them before a server attaches again.
 * - The socket's folder is the user's alone (0700) and the socket too (0600).
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { LineWriter } from "./output";

export interface HostSocket {
  /** The server's lines, across its connections, until `close`. */
  readonly lines: AsyncIterable<string>;
  /** Writes protocol lines to the connected server. */
  readonly writer: LineWriter;
  /** Resolves when a server first connects. */
  readonly firstConnection: Promise<void>;
  connected(): boolean;
  /** Told when a server connects (true) or goes (false). */
  onConnection(listener: (connected: boolean) => void): () => void;
  /** Ends `lines`, closes the connection and the socket, and removes its file. */
  close(): Promise<void>;
}

export async function openHostSocket(path: string): Promise<HostSocket> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { force: true });

  let current: Bun.Socket<undefined> | null = null;
  const listeners = new Set<(connected: boolean) => void>();
  const first = Promise.withResolvers<void>();

  // The server's lines.
  const received: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let decoder = new TextDecoder();
  let partial = "";

  // Lines for the server: bytes not yet taken by the connection, and those waiting for them to be taken.
  const encoder = new TextEncoder();
  let outgoing: Uint8Array[] = [];
  const flushed: (() => void)[] = [];

  const settle = (): void => {
    if (outgoing.length === 0) for (const resolve of flushed.splice(0)) resolve();
  };
  const send = (): void => {
    const socket = current;
    if (socket === null) {
      outgoing = [];
      settle();
      return;
    }
    while (outgoing.length > 0) {
      const chunk = outgoing[0] as Uint8Array;
      const written = socket.write(chunk);
      if (written < 0) break;
      if (written < chunk.length) {
        // The rest goes when the connection drains.
        outgoing[0] = chunk.subarray(written);
        break;
      }
      outgoing.shift();
    }
    settle();
  };
  const wakeReader = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        if (current !== null || closed) {
          socket.end();
          return;
        }
        current = socket;
        decoder = new TextDecoder();
        partial = "";
        first.resolve();
        for (const listener of listeners) listener(true);
      },
      data(socket, data) {
        if (socket !== current) return;
        partial += decoder.decode(data, { stream: true });
        let newline = partial.indexOf("\n");
        while (newline !== -1) {
          received.push(partial.slice(0, newline));
          partial = partial.slice(newline + 1);
          newline = partial.indexOf("\n");
        }
        wakeReader();
      },
      drain(socket) {
        if (socket === current) send();
      },
      close(socket) {
        if (socket !== current) return;
        current = null;
        partial = "";
        outgoing = [];
        settle();
        for (const listener of listeners) listener(false);
      },
      error() {
        // A failed connection closes; `close` above handles it.
      },
    },
  });
  await chmod(path, 0o600);

  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      const line = received.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    lines: lines(),
    writer: {
      write(line) {
        if (current === null) return;
        outgoing.push(encoder.encode(`${line}\n`));
        if (outgoing.length === 1) send();
      },
      flush() {
        if (outgoing.length === 0) return Promise.resolve();
        return new Promise((resolve) => flushed.push(resolve));
      },
    },
    firstConnection: first.promise,
    connected: () => current !== null,
    onConnection(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      wakeReader();
      current?.end();
      server.stop(true);
      await rm(path, { force: true });
    },
  };
}

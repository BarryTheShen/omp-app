/**
 * The Unix socket the agents' `ssh` reaches a machine through (#20): `ProxyCommand omp-app device-ssh <alias>` connects
 * here, says which machine and which chat process it runs in, and then carries the SSH bytes. The socket is in the
 * server's owner-only runtime folder, so only the server's own account can connect.
 *
 * Protocol: the client sends one line, `{"alias":"laptop","scope":"<id>"|null}`; the server answers one line once the
 * machine opened the session (`ok`) or did not (`refused <reason>`); then raw bytes both ways.
 */
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "../../logging";
import type { AccessHub } from "./hub";
import type { StreamHandle } from "./link";

const Hello = z.strictObject({
  alias: z.string().max(40),
  scope: z
    .string()
    .regex(/^[0-9a-f-]{36}$/)
    .nullable(),
});
/** The longest first line the client may send. */
const HELLO_MAX = 512;

/**
 * Whether a server listens at `path` now: one that answers is another omp-app server's (two servers of one account
 * share the runtime folder: a second one started from a checkout, say), which must keep it.
 */
export async function socketAnswers(path: string): Promise<boolean> {
  try {
    const socket = await Promise.race([
      Bun.connect({ unix: path, socket: { data() {} } }),
      Bun.sleep(1_000).then(() => null),
    ]);
    socket?.end();
    return socket !== null;
  } catch {
    return false;
  }
}

interface ProxyData {
  head: Uint8Array;
  handle: StreamHandle | null;
  /** Bytes for the client the socket has not taken yet, each with what to call once it has. */
  queue: { bytes: Uint8Array; done: () => void }[];
  closed: boolean;
  /** Ends once the queue for the client has drained. */
  ending: boolean;
  /** Bytes from `ssh` that came while the session was being opened: forwarded once it is. */
  early: Uint8Array[] | null;
}

/** Listens at `path` (any stale socket there is replaced); returns what stops it. */
export async function listenAccessProxy(
  path: string,
  hub: AccessHub,
  logger?: Logger,
): Promise<() => void> {
  await rm(path, { force: true });
  const listener = Bun.listen<ProxyData>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = {
          head: new Uint8Array(0),
          handle: null,
          queue: [],
          closed: false,
          ending: false,
          early: null,
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.closed) return;
        if (state.handle !== null) return forward(socket, state.handle, chunk);
        if (state.early !== null) {
          state.early.push(chunk.slice());
          return;
        }
        const head = new Uint8Array(state.head.length + chunk.length);
        head.set(state.head);
        head.set(chunk, state.head.length);
        const newline = head.indexOf(10);
        if (newline === -1) {
          if (head.length > HELLO_MAX) return refuse(socket, "the first line is too long");
          state.head = head;
          return;
        }
        let hello: z.infer<typeof Hello>;
        try {
          hello = Hello.parse(JSON.parse(new TextDecoder().decode(head.subarray(0, newline))));
        } catch {
          return refuse(socket, "the first line is not one this server takes");
        }
        const rest = head.subarray(newline + 1);
        state.head = new Uint8Array(0);
        // While the session opens (the chat's name is looked up), what else comes waits here.
        state.early = rest.length > 0 ? [rest.slice()] : [];
        socket.pause();
        let answered = false;
        void hub
          .openStream(hello.alias, hello.scope, {
            opened: () => {
              answered = true;
              send(socket, new TextEncoder().encode("ok\n"));
            },
            data: (bytes) => send(socket, bytes),
            close: (reason) => {
              if (!answered) {
                answered = true;
                return refuse(socket, reason);
              }
              end(socket);
            },
          })
          .then((opened) => {
            if (typeof opened === "string") return refuse(socket, opened);
            if (state.closed) return opened.close();
            state.handle = opened;
            logger?.info("device_access.session", {
              machine: hello.alias,
              chat_process: hello.scope !== null,
            });
            const early = state.early ?? [];
            state.early = null;
            const waiting = early.reduce((sum, each) => sum + each.length, 0);
            if (waiting === 0) return socket.resume();
            const bytes = new Uint8Array(waiting);
            let at = 0;
            for (const each of early) {
              bytes.set(each, at);
              at += each.length;
            }
            forward(socket, opened, bytes);
          });
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.handle?.close();
        for (const each of socket.data.queue) each.done();
        socket.data.queue = [];
      },
      error(socket) {
        socket.data.handle?.close();
      },
    },
  });
  await chmod(path, 0o600);
  return () => listener.stop(true);
}

/** Bytes from `ssh` go to the machine; reading pauses until the machine's window has taken them. */
function forward(socket: Bun.Socket<ProxyData>, handle: StreamHandle, bytes: Uint8Array): void {
  socket.pause();
  handle.write(bytes.slice()).then(
    () => {
      if (!socket.data.closed) socket.resume();
    },
    () => end(socket),
  );
}

/** Bytes for `ssh`; resolves once the socket has taken them, so the machine's window opens only as `ssh` reads. */
function send(socket: Bun.Socket<ProxyData>, bytes: Uint8Array): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (socket.data.closed) {
    resolve();
    return promise;
  }
  socket.data.queue.push({ bytes, done: resolve });
  flush(socket);
  return promise;
}

function flush(socket: Bun.Socket<ProxyData>): void {
  const queue = socket.data.queue;
  while (queue.length > 0) {
    const head = queue[0];
    if (head === undefined) break;
    const written = socket.write(head.bytes);
    if (written < head.bytes.length) {
      head.bytes = head.bytes.subarray(Math.max(0, written));
      return;
    }
    queue.shift();
    head.done();
  }
  if (socket.data.ending) end(socket);
}

function refuse(socket: Bun.Socket<ProxyData>, reason: string): void {
  socket.write(`refused ${reason.replace(/\s+/g, " ").slice(0, 200)}\n`);
  end(socket);
}

/** Ends the session; bytes still queued for `ssh` (the session's last output) go first. */
function end(socket: Bun.Socket<ProxyData>): void {
  if (socket.data.closed) return;
  if (socket.data.queue.length > 0) {
    socket.data.ending = true;
    return;
  }
  socket.data.closed = true;
  socket.data.handle?.close();
  socket.end();
}

/** The person's agent talking to the guard's control socket (#20): one request per connection, or a watch, or a stream. */

/** How long a request may take: a password asked by the guard waits for a person; anything else is quick. */
export const GUARD_WAIT_MS = 10_000;
export const PASSWORD_WAIT_MS = 5 * 60_000;

/** A server's host (and port) as the guard takes it in a request, to name it in its password dialog: host letters only. */
export const SERVER_NAME = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+)(:[0-9]{1,5})?$/;

/** A one-line answer: `ok [json]` or `error <reason>`; no answer within `timeoutMs` is an error too. */
export async function guardRequest(
  socketPath: string,
  request: object,
  timeoutMs = GUARD_WAIT_MS,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  let text = "";
  let socket: Bun.Socket | null = null;
  try {
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, chunk) {
          text += new TextDecoder().decode(chunk);
        },
        close() {
          resolve(text);
        },
        error() {
          resolve(text);
        },
      },
    });
    socket.write(`${JSON.stringify(request)}\n`);
  } catch {
    return { ok: false, reason: "the guard is not running" };
  }
  const timer = setTimeout(() => resolve(null), timeoutMs);
  const answer = await promise;
  clearTimeout(timer);
  if (answer === null) {
    socket.end();
    return { ok: false, reason: "the guard did not answer in time" };
  }
  const line = answer.split("\n")[0] ?? "";
  if (line === "ok") return { ok: true, body: null };
  if (line.startsWith("ok ")) return { ok: true, body: JSON.parse(line.slice(3)) as unknown };
  return { ok: false, reason: line.replace(/^error /, "") || "the guard did not answer" };
}

/** Everything the guard tells (`watch`), one JSON value per call; returns what stops watching. */
export async function guardWatch(
  socketPath: string,
  onEvent: (event: unknown) => void,
  onEnd: () => void,
): Promise<() => void> {
  let buffer = "";
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.write(`${JSON.stringify({ op: "watch" })}\n`);
      },
      data(_socket, chunk) {
        buffer += new TextDecoder().decode(chunk);
        for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          try {
            onEvent(JSON.parse(line));
          } catch {
            // A torn line is skipped.
          }
        }
      },
      close() {
        onEnd();
      },
    },
  });
  return () => socket.end();
}

/** A session stream through the guard: its sshd's bytes. */
export interface GuardStream {
  write(bytes: Uint8Array): Promise<void>;
  pause(): void;
  resume(): void;
  end(): void;
}

/** Opens stream `stream` on the guard; the guard's `ok` comes before any byte. */
export async function guardOpen(
  socketPath: string,
  stream: number,
  handlers: { data(bytes: Uint8Array): void; close(reason: string): void },
): Promise<GuardStream | string> {
  const answered = Promise.withResolvers<string | null>();
  let open = false;
  let head = "";
  let drained: (() => void) | null = null;
  let socket: Awaited<ReturnType<typeof Bun.connect>>;
  try {
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, chunk) {
          if (open) return handlers.data(chunk);
          head += new TextDecoder("latin1").decode(chunk);
          const newline = head.indexOf("\n");
          if (newline === -1) return;
          const line = head.slice(0, newline);
          if (line !== "ok") return answered.resolve(line.replace(/^error /, ""));
          open = true;
          answered.resolve(null);
          const rest = Buffer.from(head.slice(newline + 1), "latin1");
          if (rest.length > 0) handlers.data(rest);
        },
        drain() {
          drained?.();
          drained = null;
        },
        close() {
          if (!open) answered.resolve("the guard closed the stream");
          else handlers.close("closed");
        },
      },
    });
  } catch {
    return "the guard is not running";
  }
  socket.write(`${JSON.stringify({ op: "open", stream })}\n`);
  const refused = await answered.promise;
  if (refused !== null) return refused;
  return {
    async write(bytes) {
      let rest = bytes;
      while (rest.length > 0) {
        const written = socket.write(rest);
        rest = rest.subarray(Math.max(0, written));
        if (rest.length > 0) await new Promise<void>((resolve) => (drained = resolve));
      }
    },
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    end: () => socket.end(),
  };
}

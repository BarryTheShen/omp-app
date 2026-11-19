/**
 * `omp-app device-ssh <alias>` (#20): the ProxyCommand the agents' ssh runs for a machine. It connects to the server's
 * proxy socket, says the machine and the chat process it runs in, waits for the machine to open the session, then
 * carries ssh's bytes: its stdin to the machine, the machine's bytes to its stdout.
 */
import { readFileSync } from "node:fs";
import { chatScopeOf } from "./paths";

/** The exit code ssh shows for a session that could not be opened (as its own connection failures). */
export const DEVICE_SSH_FAILED = 255;

export async function runDeviceSsh(options: {
  readonly alias: string;
  readonly socketPath: string;
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => void | Promise<void>;
  readonly stderr: (text: string) => void;
  readonly cgroup?: string;
}): Promise<number> {
  const cgroup = options.cgroup ?? readCgroup();
  const done = Promise.withResolvers<number>();
  let answered = false;
  let head = new Uint8Array(0);
  let drained = Promise.withResolvers<void>();
  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  // ssh's bytes to the machine, once it opened the session, waiting while the socket's buffer is full. When ssh's side
  // ends, the session goes on until the machine closes it: ssh ends its ProxyCommand itself once it is done, and a
  // half-closed socket would end the session before the machine's last bytes came back.
  const pump = async (): Promise<void> => {
    const reader = options.stdin.getReader();
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended || socket === null) return;
      let rest = value;
      while (rest.length > 0) {
        const written = socket.write(rest);
        rest = rest.subarray(Math.max(0, written));
        if (rest.length > 0) {
          await drained.promise;
          drained = Promise.withResolvers<void>();
        }
      }
    }
  };
  try {
    socket = await Bun.connect({
      unix: options.socketPath,
      socket: {
        data(_socket, chunk) {
          if (answered) {
            void options.stdout(chunk);
            return;
          }
          const joined = new Uint8Array(head.length + chunk.length);
          joined.set(head);
          joined.set(chunk, head.length);
          const newline = joined.indexOf(10);
          if (newline === -1) {
            head = joined;
            return;
          }
          const line = new TextDecoder().decode(joined.subarray(0, newline));
          answered = true;
          if (line !== "ok") {
            options.stderr(`${line.replace(/^refused /, "")}\n`);
            done.resolve(DEVICE_SSH_FAILED);
            return;
          }
          const rest = joined.subarray(newline + 1);
          if (rest.length > 0) void options.stdout(rest);
          void pump();
        },
        drain() {
          drained.resolve();
        },
        close() {
          done.resolve(answered ? 0 : DEVICE_SSH_FAILED);
        },
        error(_socket, error) {
          options.stderr(`${options.alias}: ${error.message}\n`);
          done.resolve(DEVICE_SSH_FAILED);
        },
      },
    });
  } catch {
    options.stderr(
      `${options.alias}: the omp app is not running, or agent access is not set up on it\n`,
    );
    return DEVICE_SSH_FAILED;
  }
  socket.write(`${JSON.stringify({ alias: options.alias, scope: chatScopeOf(cgroup) })}\n`);
  return done.promise;
}

function readCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

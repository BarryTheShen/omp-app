/**
 * One chat in this process (SDK plan H5.1): the chat host's `__omp_app_chat` path.
 *
 * In order:
 * 1. the link to the server is taken before anything else can use it: stdin and stdout (omp claims stdin the same way
 *    before its extensions load, `main.ts:1835`; stdout goes to the protocol, `output.ts`), or with
 *    `OMP_APP_HOST_SOCKET` a Unix socket the server connects to (D2, `socket.ts`), so the chat can outlive the server;
 * 2. the session is built from the chat's launch flags (`session-factory.ts`); a chat that cannot start exits 1 with the
 *    reason on stderr, which the server shows;
 * 3. the loop runs (`loop.ts`) until the server closes stdin, or an extension shuts the chat down; on a socket, until the
 *    chat is handed back (`handback.ts`) when the server has been gone for a while;
 * 4. the session is disposed, the last lines are written, and the process exits 0.
 *
 * A signal (SIGTERM from the server's stop, SIGINT, SIGHUP) ends the process the way omp's own RPC mode does: omp's
 * cleanup runs (`postmortem`: each session records its exit, servers and storage close) and the session is not disposed.
 * Disposing would abort a worker still running, and the app would list it as Cancelled, as if the person had stopped it;
 * left alone it records no end, and the app lists it as Stopped (#1337, #781).
 */
import { SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { startHandback } from "./handback";
import { linesOf } from "./input";
import { runChatLoop } from "./loop";
import { type LineWriter, takeOverStdout } from "./output";
import { createChatSession } from "./session-factory";
import { isSessionSettled } from "./settle";
import { type HostSocket, openHostSocket } from "./socket";

/** How long a host on a socket waits for its server's first connection before it gives up. */
const FIRST_CONNECTION_MS = 60_000;

/**
 * `OMP_APP_HANDBACK_MS`: how long a host on a socket waits for its server to come back before it hands the chat back.
 * Tests set it; otherwise two minutes (`handback.ts`).
 */
function handbackWait(): { readonly waitMs?: number } {
  const value = Number(process.env.OMP_APP_HANDBACK_MS);
  return Number.isFinite(value) && value > 0 ? { waitMs: value } : {};
}

/** The host's link to the server: the server's lines, the writer for the protocol, and how to end the lines. */
interface Transport {
  readonly lines: AsyncIterable<string>;
  readonly writer: LineWriter;
  readonly stop: () => void;
  /** The socket, when the host is on one. */
  readonly socket?: HostSocket;
}

export async function runChat(args: readonly string[]): Promise<never> {
  const socketPath = process.env.OMP_APP_HOST_SOCKET;
  const transport =
    socketPath === undefined || socketPath === "" ? stdio() : await socket(socketPath);
  if (transport === null) return exit(1);
  // A terminal notification writes a bell or an escape sequence to stdout, inside the protocol.
  process.env.PI_NOTIFICATIONS = "off";

  let chat: Awaited<ReturnType<typeof createChatSession>>;
  try {
    chat = await createChatSession(args, (message) => process.stderr.write(`${message}\n`));
  } catch (error) {
    process.stderr.write(`${startFailure(error)}\n`);
    return exit(1);
  }

  const link = transport.socket;
  const stopHandback =
    link === undefined
      ? () => undefined
      : startHandback({
          link,
          settled: () => isSessionSettled(chat.session),
          handBack: () => {
            process.stderr.write("chat host: its server has been gone; handing the chat back\n");
            transport.stop();
          },
          ...handbackWait(),
        });

  let code = 0;
  try {
    await runChatLoop({
      chat,
      lines: transport.lines,
      writer: transport.writer,
      ompVersion: VERSION,
      log: (message) => process.stderr.write(`${message}\n`),
      stopInput: transport.stop,
      // The loop starts once the first server is connected: every later connection is a server attaching (D2).
      ...(link === undefined
        ? {}
        : {
            onServerAttached: (listener: () => void) =>
              link.onConnection((connected) => {
                if (connected) listener();
              }),
          }),
    });
  } catch (error) {
    process.stderr.write(`chat host: the chat stopped: ${errorText(error)}\n`);
    code = 1;
  }
  stopHandback();
  try {
    await chat.session.dispose();
  } catch (error) {
    process.stderr.write(`chat host: the chat could not be closed cleanly: ${errorText(error)}\n`);
    code = 1;
  }
  try {
    await transport.writer.flush();
  } catch {
    code = 1;
  }
  await link?.close();
  return exit(code);
}

/** stdin and stdout, claimed first. */
function stdio(): Transport {
  const input = Bun.stdin.stream().getReader();
  const writer = takeOverStdout((error) => {
    process.stderr.write(`chat host: stdout failed (${error.message}); ending the chat\n`);
    void postmortem.quit(1);
  });
  return {
    lines: linesOf(input),
    writer,
    stop: () => void input.cancel().catch(() => undefined),
  };
}

/** The socket at `path`, once the server has connected; null when none did in time. */
async function socket(path: string): Promise<Transport | null> {
  const link = await openHostSocket(path);
  const connected = await Promise.race([
    link.firstConnection.then(() => true),
    Bun.sleep(FIRST_CONNECTION_MS).then(() => false),
  ]);
  if (!connected) {
    process.stderr.write("chat host: no server connected to the chat's socket; ending\n");
    await link.close();
    return null;
  }
  return { lines: link.lines, writer: link.writer, stop: () => void link.close(), socket: link };
}

/** omp's wording for a launch that cannot start (`exitForSessionResolutionError`, `main.ts:866`): the reason, then a hint. */
function startFailure(error: unknown): string {
  if (error instanceof SessionResolutionError) {
    return error.hint ? `Error: ${error.message}\n${error.hint}` : `Error: ${error.message}`;
  }
  return `Error: ${errorText(error)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exits through omp's cleanup, so its registered handlers (session writes, the settings watcher) run first. */
async function exit(code: number): Promise<never> {
  await postmortem.quit(code);
  return process.exit(code);
}

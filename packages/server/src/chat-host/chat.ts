/**
 * One chat in this process (SDK plan H5.1): the chat host's `__omp_app_chat` path.
 *
 * In order:
 * 1. stdin is claimed before anything else can read it (omp claims it the same way before its extensions load,
 *    `main.ts:1835`), and stdout is taken for the protocol (`output.ts`);
 * 2. the session is built from the chat's launch flags (`session-factory.ts`); a chat that cannot start exits 1 with the
 *    reason on stderr, which the server shows;
 * 3. the loop runs (`loop.ts`) until the server closes stdin, or an extension shuts the chat down;
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
import { linesOf } from "./input";
import { runChatLoop } from "./loop";
import { takeOverStdout } from "./output";
import { createChatSession } from "./session-factory";

export async function runChat(args: readonly string[]): Promise<never> {
  const input = Bun.stdin.stream().getReader();
  const writer = takeOverStdout((error) => {
    process.stderr.write(`chat host: stdout failed (${error.message}); ending the chat\n`);
    void postmortem.quit(1);
  });
  // A terminal notification writes a bell or an escape sequence to stdout, inside the protocol.
  process.env.PI_NOTIFICATIONS = "off";

  let chat: Awaited<ReturnType<typeof createChatSession>>;
  try {
    chat = await createChatSession(args, (message) => process.stderr.write(`${message}\n`));
  } catch (error) {
    process.stderr.write(`${startFailure(error)}\n`);
    return exit(1);
  }

  let code = 0;
  try {
    await runChatLoop({
      chat,
      lines: linesOf(input),
      writer,
      ompVersion: VERSION,
      log: (message) => process.stderr.write(`${message}\n`),
      stopInput: () => void input.cancel().catch(() => undefined),
    });
  } catch (error) {
    process.stderr.write(`chat host: the chat stopped: ${errorText(error)}\n`);
    code = 1;
  }
  try {
    await chat.session.dispose();
  } catch (error) {
    process.stderr.write(`chat host: the chat could not be closed cleanly: ${errorText(error)}\n`);
    code = 1;
  }
  try {
    await writer.flush();
  } catch {
    code = 1;
  }
  return exit(code);
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

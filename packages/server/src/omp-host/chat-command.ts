export interface OmpCommandOptions {
  /**
   * The chat host compiled to one program (`scripts/build-chat-host.ts`), on the Bun omp's release is built with. The
   * packages install it beside the app's command, and the live tests build it (`apps/web/e2e/global-setup.ts`).
   * Without it, a source checkout runs omp's command line from the pinned package on the Bun that runs the server: for
   * development only, because that is not the program that ships (on the test machine it was slower to answer a chat's first message
   * and missed a settings change while running, #2687).
   */
  readonly binary?: string | undefined;
}

export interface ChatCommandOptions extends OmpCommandOptions {
  /**
   * Test seam: a program each chat runs through, given the chat's whole command as its arguments. A wrapper does what
   * its test needs (waits, adds arguments, filters frames) and ends with `exec "$@"`.
   */
  readonly wrapper?: string | undefined;
}

/**
 * omp's own command line, from the omp package the app pins (#2586, SDK plan): the program and leading arguments, before
 * omp's own arguments. The compiled chat host hands them to omp's command line (`src/chat-host/main.ts`). It answers
 * omp's commands (`--version`, `models`, `usage`, `config`) and runs chats (`chatCommand`).
 */
export function ompCommand(options: OmpCommandOptions = {}): readonly string[] {
  return options.binary === undefined ? [process.execPath, ompCommandLine()] : [options.binary];
}

/**
 * The program and leading arguments that start one chat: omp's command line in `--mode rpc-ui`, the only mode that
 * forwards extension and tool UI requests. The chat's own arguments follow.
 */
export function chatCommand(options: ChatCommandOptions = {}): readonly string[] {
  const command = [...ompCommand(options), "--mode", "rpc-ui"];
  return options.wrapper === undefined ? command : [options.wrapper, ...command];
}

/** omp's command-line entry (`src/cli.ts`) in the pinned package, as a source checkout has it. */
function ompCommandLine(): string {
  try {
    return Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli", import.meta.dir);
  } catch {
    // A compiled server holds no packages; the packages give it the compiled chat host instead.
    throw new Error(
      "omp's command line was not found: a compiled server needs the compiled chat host (`binary`), which the packages install beside the app's command.",
    );
  }
}

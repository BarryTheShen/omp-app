/**
 * The chat host program (SDK plan H5.1): the app's own entry. `scripts/build-chat-host.ts` compiles it with omp's build
 * settings; from source it runs as `bun packages/server/src/chat-host/main.ts`.
 *
 * - `__omp_app_chat [omp's launch flags]` runs one chat on omp's SDK, speaking the app's protocol on stdin and stdout
 *   (`chat.ts`).
 * - Every other argument list goes to omp's own command line, unchanged. omp's worker threads and worker subprocesses
 *   re-enter this program with their selectors (`Bun.main`; omp 18.12.6 `subprocess/worker-client.ts:169-178`), and
 *   `--version`, `--smoke-test`, `models`, `usage`, `config`, a bare start (omp's terminal UI) and `--mode rpc-ui` run as
 *   in omp's own binary.
 *
 * omp's `cli.ts` runs itself when it is loaded in a compiled program (`PI_COMPILED`) or in a worker thread
 * (`cli.ts:583-601`), and declares the program as its worker host there (`cli.ts:497`). From source on the main thread it
 * does neither, so this entry does both, as `cli.ts` does when it is the entry itself.
 *
 * `cli.ts` is loaded synchronously (`require`, through `omp-cli.ts`), inside this module's own evaluation, as when it is
 * the entry: a worker thread's first messages are delivered once its entry module has evaluated, and omp installs their
 * buffer in that synchronous step (`cli.ts:197-219`, `:499-503`); a dynamic `import()` would let them through first.
 * Worker subprocesses likewise get their message handler before anything awaits (`cli.ts:244-259`).
 *
 * No top-level await: omp's bytecode builds fail on it (`cli.ts:572-573`).
 */

import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { CHAT_HOST_CHAT_ARG } from "@omp-app/contracts/chat-host/args";

const argv = process.argv.slice(2);

if (Bun.isMainThread && argv[0] === CHAT_HOST_CHAT_ARG) {
  // omp's workers (eval, browser tabs, stats) re-enter this program; without a declared host they run inline, and each
  // chat would launch its own browser instead of the shared one (`tools/browser/registry.ts:222-230`).
  declareWorkerHostEntry();
  void import("./chat").then(({ runChat }) => runChat(argv.slice(1)));
} else if (process.env.PI_COMPILED === "true" || !Bun.isMainThread) {
  require("./omp-cli");
} else {
  declareWorkerHostEntry();
  runOmpFromSource(argv);
}

/** omp's command line from source on the main thread: what `cli.ts:583-601` does when it is the process entry. */
function runOmpFromSource(args: readonly string[]): void {
  const postmortem: typeof import("@oh-my-pi/pi-utils/postmortem") = require("@oh-my-pi/pi-utils/postmortem.js");
  postmortem.registerStdioDisconnectHandling();
  const { runCli }: typeof import("./omp-cli") = require("./omp-cli");
  const entry = runCli([...args]);
  postmortem.reportUnsettledEntry(entry, () => args[0]);
  entry.catch((error: unknown) => postmortem.fatal(error));
}

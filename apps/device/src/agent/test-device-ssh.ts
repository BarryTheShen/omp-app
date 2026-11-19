/**
 * For the chain test only: `omp-app device-ssh <alias>` as the server's ssh config runs it, with the proxy socket given
 * in `OMP_ACCESS_TEST_PROXY` (the real CLI finds it in the runtime folder).
 */
import { runDeviceSsh } from "../../../../packages/server/src/devices/access/device-ssh";

process.exit(
  await runDeviceSsh({
    alias: process.argv[2] ?? "",
    socketPath: process.env.OMP_ACCESS_TEST_PROXY ?? "",
    stdin: Bun.stdin.stream(),
    stdout: (bytes) => {
      process.stdout.write(bytes);
    },
    stderr: (text) => process.stderr.write(text),
  }),
);

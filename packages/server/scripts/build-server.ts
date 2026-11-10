/**
 * Compiles the app's command (`scripts/omp-app.ts`), on the Bun that runs this script: the server the packages install
 * as `omp-app` and the one the desktop app bundles. omp's native addon is embedded (`native-addon.ts`): the browser
 * relay's server (omp's `tools/browser/relay/server`, `src/browser/edge-relay.ts`) loads it as it is imported since
 * omp 18.18, and a compiled program finds it only embedded.
 *
 *   bun packages/server/scripts/build-server.ts <version> <outfile>
 */
import { dirname, join, resolve } from "node:path";
import { embeddedNativeAddon } from "./native-addon";

const [version, outfile] = process.argv.slice(2);
if (version === undefined || outfile === undefined) {
  console.error("usage: bun packages/server/scripts/build-server.ts <version> <outfile>");
  process.exit(2);
}

// omp's package folder (its exports map only `./src/*`, so it is found from one of them): it resolves the pi-natives the
// bundle does.
const packageDir = dirname(
  dirname(Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli", import.meta.dir)),
);
const output = await Bun.build({
  entrypoints: [join(import.meta.dir, "omp-app.ts")],
  target: "bun",
  minify: true,
  define: { OMP_APP_VERSION: JSON.stringify(version) },
  files: await embeddedNativeAddon(packageDir),
  compile: { target: "bun-linux-x64", outfile: resolve(outfile) },
});
if (!output.success) {
  for (const log of output.logs) console.error(log);
  process.exit(1);
}

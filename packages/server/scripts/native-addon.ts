/**
 * omp's native addon (`@oh-my-pi/pi-natives`) for the app's compiled programs: the chat host (`build-chat-host.ts`) and
 * the app's command (`build-server.ts`, whose browser relay server, omp's `tools/browser/relay/server`, loads the addon
 * as it is imported since omp 18.18). Each build writes the addon files next to the program it compiles, once per CPU
 * variant (`pi_natives.linux-x64-modern.node`, `-baseline.node`): a compiled program that embeds no addon loads it from
 * its own folder (pi-natives' `loader-state.js`, `resolveLoaderCandidates`: `execDir`, the folder of
 * `process.execPath`, which Bun gives symlink-resolved), the modern build first and the baseline one on CPUs without its
 * instructions. Until 2026-11-20 both programs embedded both variants (zstd, 44 MB each), four copies in the desktop
 * package (177 MB of its 359 MB), and each extracted its copy into `~/.omp/natives/<version>/` on first load.
 */
import { copyFile, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The platform a build is for: the one it runs on (each OS's packages are built on that OS), as omp's native packages
 * name it: `linux-x64`, `darwin-arm64`, `win32-x64`.
 */
export const PLATFORM_TAG = `${process.platform}-${process.arch}`;

/** Bun's compile target for `PLATFORM_TAG`: `bun-linux-x64`, `bun-darwin-arm64`, `bun-windows-x64`. */
export const COMPILE_TARGET =
  `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as Bun.Build.CompileTarget;

/**
 * Copies the addon variants of the `@oh-my-pi/pi-natives` that `fromDir` resolves into `outDir` (the compiled program's
 * folder), each checked to carry that package's version stamp. Returns the files written.
 */
export async function installNativeAddons(fromDir: string, outDir: string): Promise<string[]> {
  const nativeDir = await realpath(dirname(Bun.resolveSync("@oh-my-pi/pi-natives", fromDir)));
  const { version } = JSON.parse(await readFile(join(nativeDir, "../package.json"), "utf8")) as {
    version: string;
  };
  const sentinel = (await import(join(nativeDir, "version-sentinel.js"))) as {
    containsVersionStamp: (bytes: Uint8Array, version: string) => boolean;
    containsLegacyVersionSentinel: (bytes: Uint8Array, version: string) => boolean;
  };
  const addonDir = dirname(
    Bun.resolveSync(`@oh-my-pi/pi-natives-${PLATFORM_TAG}/package.json`, nativeDir),
  );
  const present = new Set(await readdir(addonDir));
  // x64 builds come as a modern and a baseline variant (CPUs without the modern one's instructions); others as one file.
  const filenames = [
    `pi_natives.${PLATFORM_TAG}-modern.node`,
    `pi_natives.${PLATFORM_TAG}-baseline.node`,
    `pi_natives.${PLATFORM_TAG}.node`,
  ].filter((filename) => present.has(filename));
  if (filenames.length === 0) throw new Error(`No native addon for ${PLATFORM_TAG} in ${addonDir}`);
  const written: string[] = [];
  for (const filename of filenames) {
    const from = join(addonDir, filename);
    const bytes = new Uint8Array(await readFile(from));
    if (
      !sentinel.containsVersionStamp(bytes, version) &&
      !sentinel.containsLegacyVersionSentinel(bytes, version)
    ) {
      throw new Error(`${from} is not stamped @oh-my-pi/pi-natives@${version}`);
    }
    const to = join(outDir, filename);
    await copyFile(from, to);
    written.push(to);
  }
  return written;
}

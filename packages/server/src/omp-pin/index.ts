import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logging/logger";
import pin from "./pin.json";

/** One release asset of omp: its file name and the SHA-256 its release lists. */
export interface OmpBinaryAsset {
  readonly asset: string;
  readonly sha256: string;
}

/** The omp release the app runs every chat on. */
export interface OmpPin {
  readonly version: string;
  /** By `<platform>-<arch>` as Node names them (`linux-x64`). */
  readonly binaries: Readonly<Record<string, OmpBinaryAsset>>;
}

/**
 * The omp the app ships, from `pin.json`: every chat and every omp command the server runs uses this release, never
 * an omp installed on the computer, so the app and its omp always match. The checksums are the release's
 * `SHA256SUMS.txt` (https://github.com/can1357/oh-my-pi/releases). To move to another release, change the version and
 * the checksums together. The e2e harness reads the version from the same file.
 */
export const OMP_PIN: OmpPin = pin;

export interface PinnedOmpOptions {
  /** The folder that holds the app's omp binaries, one file per version (`omp-18.12.6`). */
  readonly dir: string;
  readonly logger?: Logger;
  /**
   * Delete older releases' binaries from `dir` after an install (default true): right for the app's own folder, wrong
   * for one that apps or checkouts of other versions share, such as `OMP_APP_OMP_DIR` on the test machine, where another job may
   * be about to start the older release.
   */
  readonly removeOlder?: boolean;
  /** Test seams: the release, the platform and the download. */
  readonly pin?: OmpPin;
  readonly platform?: string;
  readonly arch?: string;
  readonly fetch?: (url: string) => Promise<Response>;
}

/** Where the pinned omp lives in `dir`, whether or not it is there yet. */
export function pinnedOmpPath(dir: string, pin: OmpPin = OMP_PIN): string {
  return join(dir, `omp-${pin.version}`);
}

/**
 * The path of the pinned omp, downloading it into `dir` first when it is not there. A download is checked against the
 * release's checksum before it is moved into place, so a file at the path is always a whole, verified binary. Rejects
 * with a plain reason when this computer has no build of the pinned omp, or the download fails or does not match.
 */
export async function ensurePinnedOmp(options: PinnedOmpOptions): Promise<string> {
  const pin = options.pin ?? OMP_PIN;
  const target = pinnedOmpPath(options.dir, pin);
  if (await isFile(target)) return target;
  const key = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  const binary = pin.binaries[key];
  if (binary === undefined) {
    throw new Error(`omp ${pin.version} has no build for ${key} that this app can use.`);
  }
  const url = `https://github.com/can1357/oh-my-pi/releases/download/v${pin.version}/${binary.asset}`;
  await mkdir(options.dir, { recursive: true });
  await removeAbandonedDownloads(options.dir);
  const partial = `${target}.${process.pid}.${crypto.randomUUID()}.part`;
  const started = performance.now();
  options.logger?.info("omp.download", { version: pin.version, url });
  try {
    const response = await (options.fetch ?? fetch)(url);
    if (!response.ok || response.body === null) {
      throw new Error(`the download of omp ${pin.version} failed (HTTP ${response.status}).`);
    }
    const hash = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(partial).writer();
    for await (const chunk of response.body) {
      hash.update(chunk);
      writer.write(chunk);
    }
    await writer.end();
    if (hash.digest("hex") !== binary.sha256) {
      throw new Error(`the download of omp ${pin.version} does not match its release's checksum.`);
    }
    await chmod(partial, 0o755);
    // A rename is atomic: a concurrent start sees no file or the whole binary, never part of one.
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  options.logger?.info("omp.downloaded", {
    version: pin.version,
    ms: Math.round(performance.now() - started),
  });
  if (options.removeOlder !== false) await removeOlderReleases(options.dir, pin.version);
  return target;
}

/**
 * Deletes the binaries of omp releases older than `version` from `dir`, once the new one is in place: each is about
 * 250 MB, and an app that moved its pin never runs them again. A chat still running on one keeps running (the file
 * stays open until it ends). Newer releases are kept, for an app of a newer version that shares the folder.
 */
async function removeOlderReleases(dir: string, version: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const other = /^omp-(\d+\.\d+\.\d+)$/.exec(name)?.[1];
    if (other !== undefined && compareVersions(other, version) < 0) {
      await rm(join(dir, name), { force: true });
    }
  }
}

/** Compares two `major.minor.patch` versions: negative when `left` is older. */
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Deletes the partial downloads (`omp-<version>.<pid>.<id>.part`) whose process is gone: a start that was stopped
 * mid-download (Ctrl+C, a window that gave up waiting) leaves one, up to the binary's whole size. A partial download
 * whose process still runs is left alone.
 */
async function removeAbandonedDownloads(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const owner = /^omp-.+\.(\d+)\.[0-9a-f-]+\.part$/.exec(name)?.[1];
    if (owner === undefined || isRunning(Number(owner))) continue;
    await rm(join(dir, name), { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

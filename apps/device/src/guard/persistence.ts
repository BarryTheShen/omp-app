/**
 * The places a session could use to keep a way in after access turns off (#20): the agent account's shell startup
 * files, its ssh folder, autostart entries, user systemd units, its crontab and `at` jobs, and its linger flag. The guard
 * takes a fingerprint of each when access turns on; one that changed blocks new sessions while on, and every off removes
 * them all (`account.ts`). The guard reads them as root from a tree the agent account controls, so a file is opened
 * without following a link and without blocking (a FIFO swapped in), and only a regular file is read.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/** A regular file's bytes, read without following a link or blocking; null for anything else. */
async function regularFileBytes(path: string): Promise<Buffer | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (file === null) return null;
  try {
    const info = await file.stat();
    return info.isFile() ? await file.readFile() : null;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** The agent account's startup files and folders, relative to its home: watched while on, removed at every off. */
export const HOME_STARTUP_PATHS: readonly string[] = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".pam_environment",
  ".ssh",
  ".config/autostart",
  ".config/systemd/user",
  ".config/environment.d",
  ".config/fish",
  ".local/share/systemd",
];

/** Every path watched for an account whose home is `home`. */
export function persistencePaths(account: string, home: string): string[] {
  const inHome = HOME_STARTUP_PATHS.map((path) => join(home, path));
  return [
    ...inHome,
    join("/var/spool/cron/crontabs", account),
    "/var/spool/cron/atjobs",
    join("/var/lib/systemd/linger", account),
  ];
}

/** A path's fingerprint: its type, mode and content (a folder: every entry under it, in order); "absent" when missing. */
async function fingerprint(path: string, depth = 0): Promise<string> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return "absent";
  }
  const hash = createHash("sha256").update(`${info.mode}:${info.uid}`);
  if (info.isSymbolicLink()) {
    hash.update(`link:${await readlink(path).catch(() => "")}`);
  } else if (info.isDirectory()) {
    if (depth > 6) return hash.update("too-deep").digest("hex");
    const names = (await readdir(path).catch(() => [])).sort();
    for (const name of names)
      hash.update(`${name}=${await fingerprint(join(path, name), depth + 1)}\n`);
  } else if (info.isFile()) {
    // A file larger than this is fingerprinted by its size and time, not read whole.
    if (info.size > 4 * 1024 * 1024) hash.update(`big:${info.size}:${info.mtimeMs}`);
    else hash.update((await regularFileBytes(path)) ?? Buffer.from("not-a-regular-file"));
  } else {
    hash.update("other");
  }
  return hash.digest("hex");
}

export type Snapshot = ReadonlyMap<string, string>;

export async function snapshot(paths: readonly string[]): Promise<Snapshot> {
  const taken = new Map<string, string>();
  for (const path of paths) taken.set(path, await fingerprint(path));
  return taken;
}

/** The paths whose fingerprint differs now from `before`. */
export async function changedSince(before: Snapshot): Promise<string[]> {
  const changed: string[] = [];
  for (const [path, was] of before) if ((await fingerprint(path)) !== was) changed.push(path);
  return changed;
}

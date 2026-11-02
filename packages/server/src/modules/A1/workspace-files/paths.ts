import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { AppFailure } from "@omp-app/contracts";

/**
 * The Files panel's path rules (#2782): every path stays inside its folder. The folder is taken at its real location; a
 * path's directories are resolved through their symlinks and must stay inside; its last part is followed only by the
 * calls that read (`list`, `stat`, `read`), and only to a target inside. Writes, moves and trash act on a link itself,
 * never on its target, and never under a `.git` directory.
 */

/** A path resolved inside its folder. */
export interface ResolvedPath {
  /** The folder's real location. */
  readonly root: string;
  /** The path itself, under the real location of its directory: a symlink here is the link. */
  readonly target: string;
  /** What is at `target` (`lstat`), or null when nothing is. */
  readonly found: Stats | null;
}

/** A followed path: what a symlink inside the folder points to, or the path itself. */
export interface FollowedPath extends ResolvedPath {
  /** The real location read from. */
  readonly real: string;
  readonly info: Stats;
}

export function permissionFailure(message: string): AppFailure {
  return new AppFailure({ code: "permission", message, retryable: false });
}

export function notFoundFailure(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}

export function invalidFailure(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

export function conflictFailure(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: false });
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Whether `path` is `root` or under it. */
export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The folder's real location; it must be a directory. */
export async function folderRoot(folder: string): Promise<string> {
  if (!isAbsolute(folder)) throw invalidFailure("The folder must be an absolute path.");
  let real: string;
  try {
    real = await realpath(folder);
  } catch (error) {
    if (missing(error)) throw notFoundFailure("The folder is not there.");
    throw error;
  }
  if (!(await stat(real)).isDirectory()) throw invalidFailure("The folder is not a directory.");
  return real;
}

/**
 * `path` under `root`: its directory taken at its real location, which must stay inside the folder, and its last part
 * as it is (a symlink stays the link). Nothing need be there; its directory must be.
 */
export async function resolveInside(root: string, path: string): Promise<ResolvedPath> {
  let parent: string;
  try {
    parent = await realpath(dirname(join(root, path)));
  } catch (error) {
    if (missing(error)) throw notFoundFailure(`${dirname(path)} is not there.`);
    throw error;
  }
  if (!isInside(root, parent)) throw permissionFailure(`${path} is outside the folder.`);
  const target = join(parent, basename(path));
  let found: Stats | null = null;
  try {
    found = await lstat(target);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return { root, target, found };
}

/** Where a symlink points, when its target is inside the folder; null when it leads out or nowhere. */
export async function linkTargetInside(root: string, link: string): Promise<string | null> {
  try {
    const real = await realpath(link);
    return isInside(root, real) ? real : null;
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException | null)?.code === "ELOOP") return null;
    throw error;
  }
}

/** `path` for a call that reads: it must be there, and a symlink is followed only to a target inside the folder. */
export async function followInside(root: string, path: string): Promise<FollowedPath> {
  const resolved = await resolveInside(root, path);
  if (resolved.found === null) throw notFoundFailure(`${path} is not there.`);
  if (!resolved.found.isSymbolicLink()) {
    return { ...resolved, real: resolved.target, info: resolved.found };
  }
  const real = await linkTargetInside(root, resolved.target);
  if (real === null) throw permissionFailure(`${path} leads outside the folder.`);
  return { ...resolved, real, info: await stat(real) };
}

/** The folder itself as a followed path, for a call on the folder (`list` with no path). */
export async function folderItself(root: string): Promise<FollowedPath> {
  const info = await stat(root);
  return { root, target: root, found: info, real: root, info };
}

/** Writes, moves, trash and new folders are refused anywhere under a `.git` directory, by name or by location. */
export function assertNotInGit(root: string, path: string, resolved: ResolvedPath): void {
  const named = path.split(/[\\/]/).includes(".git");
  const located = relative(root, resolved.target).split(sep).includes(".git");
  if (named || located) throw permissionFailure("Files under .git are not changed here.");
}

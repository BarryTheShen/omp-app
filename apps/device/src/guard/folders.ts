/**
 * Folders of the person's that agents may ask for (#20, PLAN §7d): an agent asks for a folder from its session, the
 * person allows it with their password, and while access is on the guard mounts it into the agent account's home. This
 * module decides which folders may be shared at all, from the guard (root): only a directory of the person's, inside
 * their home, that is neither the home itself nor holds or lies inside one of the places their secrets are kept.
 */

import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Where the person's secrets are kept, relative to their home: keys, keyrings, password stores, the app's and omp's own
 * settings (with their logins), and browser profiles (sessions, cookies). A folder that is one of them, lies inside one,
 * or holds one is never shared.
 */
export const SECRET_PLACES: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".pki",
  ".password-store",
  ".local/share/keyrings",
  ".omp",
  ".config/omp-app",
  ".config/omp-app-desktop",
  ".mozilla",
  ".zen",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  ".var/app",
  ".docker",
  ".kube",
  ".aws",
  ".config/gh",
];

/** What the checks need of the machine: a seam for tests. */
export interface FolderFacts {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean; uid: number }>;
}

const SYSTEM: FolderFacts = { realpath, stat };

/** A folder that may be shared, as its real path and its place below the home, or why not (said to the agent). */
export type FolderCheck =
  | { readonly path: string; readonly place: string }
  | { readonly problem: string };

/** Whether `inner` is `outer` or lies inside it (both real, absolute paths). */
const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

/**
 * Whether the folder an agent asked for may be shared: `asked` absolute; its real path (links resolved, so a link
 * inside the home cannot lead out of it or into a secret) a directory owned by the person, inside their home, not the
 * home itself, and clear of every secret place.
 */
export async function checkFolder(
  asked: string,
  person: { readonly home: string; readonly uid: number },
  facts: FolderFacts = SYSTEM,
): Promise<FolderCheck> {
  const inHome = asked === "~" || asked.startsWith("~/");
  if (!asked.startsWith("/") && !inHome)
    return { problem: "Give the folder as a full path, or as ~/… for one in the person's home." };
  const home = await facts.realpath(person.home).catch(() => null);
  if (home === null) return { problem: "The person's home folder could not be read." };
  const absolute = inHome ? join(person.home, asked.slice(2)) : asked;
  const path = await facts.realpath(absolute).catch(() => null);
  if (path === null) return { problem: `${asked} does not exist.` };
  if (!within(path, home))
    return {
      problem: `${asked} is not inside ${person.home}: only the person's own folders are shared.`,
    };
  if (path === home)
    return {
      problem: `The whole home folder is never shared: ask for the folder inside it that the work needs.`,
    };
  const info = await facts.stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) return { problem: `${asked} is not a folder.` };
  if (info.uid !== person.uid) return { problem: `${asked} does not belong to the person.` };
  const place = relative(home, path);
  for (const secret of SECRET_PLACES) {
    const secretPath = `${home}${sep}${secret}`;
    if (within(path, secretPath))
      return { problem: `${asked} is where the person keeps secrets (~/${secret}): never shared.` };
    if (within(secretPath, path))
      return {
        problem: `${asked} holds ~/${secret}, where the person keeps secrets: ask for a folder inside ~/${place} that does not hold it.`,
      };
  }
  return { path, place };
}

/**
 * Where a shared folder is reached: its place below the person's home, under the guard's `root` for shared folders
 * (root's, in its run folder: never in the agent account's home, where a session could swap a folder on the way for a
 * link and have the guard mount elsewhere).
 */
export function sharedAt(place: string, root: string): string {
  return `${root}${sep}${place}`;
}

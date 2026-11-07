/**
 * Where a server's chat hosts keep their sockets (D2): one folder per app data folder, so each server (the app's, or a
 * test's) attaches only to its own hosts. It is under the user's runtime folder (`XDG_RUNTIME_DIR`, the user's alone),
 * else the system's temporary folder, with a name short enough for a socket's path (108 bytes). Every use checks that
 * the folder is this user's alone (`hostsFolderIsPrivate`): one another user made first in a shared folder is refused,
 * never trusted. `omp-app tui` finds the same folder to take chats back from hosts no server holds.
 */
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** The app's data folder as the server resolves it when nothing overrides it: `OMP_APP_DATA_DIR`, else omp's agent folder's `app`. */
export function appDataFolder(env: Env, homeDir: string): string {
  const agentDir = resolve(env.PI_CODING_AGENT_DIR ?? join(homeDir, ".omp", "agent"));
  return resolve(env.OMP_APP_DATA_DIR ?? join(agentDir, "app"));
}

/** The folder of the host sockets of the server whose data folder is `appDataDir`. */
export function hostsFolder(appDataDir: string, env: Env): string {
  const id = new Bun.CryptoHasher("sha256").update(appDataDir).digest("hex").slice(0, 12);
  return join(env.XDG_RUNTIME_DIR ?? tmpdir(), `omp-app-hosts-${id}`);
}

/**
 * Whether a hosts folder is this user's alone: a real folder (no link), owned by this user, that no one else may enter.
 * A folder another user made, or opened, could hold a socket that is not a host of this server's.
 */
export function hostsFolderIsPrivate(folder: string): boolean {
  try {
    const found = lstatSync(folder);
    return found.isDirectory() && found.uid === process.getuid?.() && (found.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

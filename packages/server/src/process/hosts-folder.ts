/**
 * Where a server's chat hosts keep their sockets (D2): one folder per app data folder, so each server (the app's, or a
 * test's) attaches only to its own hosts. It is under the user's runtime folder, with a name short enough for a socket's
 * path. `omp-app tui` finds the same folder to take chats back from hosts no server holds.
 */
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

/**
 * Where agent access keeps its files (#20). The ssh files and the proxy socket are in the user's runtime folder (in
 * memory, owner-only; gone at a reboot, and the server writes them again at its start), so the turn-on's session key
 * never reaches a disk. The machines and their history are in the app's data folder.
 */
import { join } from "node:path";

/** The runtime folder: `$XDG_RUNTIME_DIR/omp-app-access`, or under the app's data folder when there is none. */
export function accessRuntimeFolder(
  env: Record<string, string | undefined>,
  appDataDir: string,
): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && runtime !== ""
    ? join(runtime, "omp-app-access")
    : join(appDataDir, "device-access", "run");
}

export const accessDataFolder = (appDataDir: string): string => join(appDataDir, "device-access");

export const accessProxySocket = (runtimeFolder: string): string =>
  join(runtimeFolder, "proxy.sock");

/** The chat process an `ssh` runs in, from its own cgroup (`omp-app-chat-<id>.scope`); null outside one. */
export function chatScopeOf(cgroupText: string): string | null {
  const match =
    /omp-app-chat-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.scope/.exec(
      cgroupText,
    );
  return match?.[1] ?? null;
}

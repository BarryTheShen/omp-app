import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Whether a live omp holds a chat's ownership lease. omp takes the lease when it first writes a chat
 * and keeps it until it exits. A second omp that writes the same file forks the chat into a copy, so
 * the app looks at the lease before its own write. `unsupported` off Linux: omp's lock there is a file
 * lock the app cannot probe without omp's own code.
 */
export type SessionLease = "held" | "free" | "unknown" | "unsupported";

/**
 * Mirrors omp v18.6.1: `getSessionOwnersDir()` (dirs.ts:1103-1104: the base config root plus
 * `run/session-owners`, XDG state applied as omp applies it). It takes the child's environment, which
 * is what omp sees: the A1 helper reads the server's own environment and ignores PI_CONFIG_DIR.
 */
export function ompSessionOwnersDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const xdgState = env.XDG_STATE_HOME;
  if ((process.platform === "linux" || process.platform === "darwin") && xdgState) {
    const xdgRoot = join(resolve(xdgState), "omp");
    if (existsSync(xdgRoot)) return join(xdgRoot, "run", "session-owners");
  }
  return join(resolve(home), env.PI_CONFIG_DIR || ".omp", "run", "session-owners");
}

// The seeds of pi-natives' `memory_lock_name` (file-lock, linux.rs): two xxh64 hashes of the lock path.
const HIGH_SEED = 0x4f4d502d4c4f434bn;
const LOW_SEED = 0x5049_2d46_494c_454cn;
const PLAIN_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The abstract socket name omp's Linux lease for one session is bound to (session-storage.ts:529-561
 * names the lock file `<ownersDir>/<session id>`, and the native lock names the socket after its path).
 */
export function leaseSocketName(sessionId: string, ownersDir: string): string {
  const name = PLAIN_SESSION_ID.test(sessionId)
    ? sessionId
    : `h-${Bun.hash.wyhash(sessionId).toString(16).padStart(16, "0")}`;
  const lockPath = `${resolve(join(ownersDir, name))}.lock`;
  const high = Bun.hash.xxHash64(lockPath, HIGH_SEED).toString(16).padStart(16, "0");
  const low = Bun.hash.xxHash64(lockPath, LOW_SEED).toString(16).padStart(16, "0");
  return `omp-file-lock-${high}${low}`;
}

/**
 * The named datagram sockets in `/proc/net/unix`. Column 5 is the socket type (`0002` is a datagram),
 * column 8 the name, `@`-prefixed when it is an abstract name. omp's lease is a datagram.
 */
export function unixDatagramNames(procNetUnix: string): Set<string> {
  const names = new Set<string>();
  for (const line of procNetUnix.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    const name = columns[7];
    if (columns[4] === "0002" && name !== undefined) names.add(name);
  }
  return names;
}

/** The kernel's list of unix sockets (Linux). */
function readProcNetUnix(): Promise<string> {
  return readFile("/proc/net/unix", "utf8");
}

export interface SessionLeaseOptions {
  readonly sessionId: string;
  readonly ownersDir: string;
  /** Defaults to this process's platform; the lease is only probed on Linux. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to reading `/proc/net/unix`; injected by tests. */
  readonly readUnixSockets?: () => Promise<string>;
}

/**
 * Probes omp's lease without taking it: a live omp that has written the chat holds the socket, and a
 * probe never creates one. `unknown` when `/proc/net/unix` cannot be read.
 */
export async function probeSessionLease(options: SessionLeaseOptions): Promise<SessionLease> {
  if ((options.platform ?? process.platform) !== "linux") return "unsupported";
  let procNetUnix: string;
  try {
    procNetUnix = await (options.readUnixSockets ?? readProcNetUnix)();
  } catch {
    return "unknown";
  }
  const name = `@${leaseSocketName(options.sessionId, options.ownersDir)}`;
  // A free chat's name is not in the table at all, so the rows are parsed only when the name is there.
  if (!procNetUnix.includes(name)) return "free";
  return unixDatagramNames(procNetUnix).has(name) ? "held" : "free";
}

/** Callable server lease bridge for one session's owner lock. */
export type SessionLeaseProbeFunction = ((
  sessionId: string,
) => Promise<"active" | "inactive" | "unknown">) & {
  forListing?: () => SessionLeaseProbeFunction;
};
/**
 * Creates the lease probe the session store takes (`leaseProbe`): `active` while another omp holds the chat, so a delete
 * refuses it and a listing shows it held; `inactive` when none does. `unknown` off Linux and when the socket table
 * cannot be read: the store does not refuse those. The base probe reads the table on every call; `forListing()` creates
 * a fresh probe that reads it once for all chats in that listing.
 */
export function sessionLeaseProbe(
  options: Omit<SessionLeaseOptions, "sessionId" | "ownersDir"> & {
    readonly ownersDir: () => string;
  },
): SessionLeaseProbeFunction {
  const readUnixSockets = options.readUnixSockets ?? readProcNetUnix;
  const create = (cacheRead: boolean): SessionLeaseProbeFunction => {
    let table: Promise<string> | undefined;
    const probe: SessionLeaseProbeFunction = async (sessionId) => {
      const readTable = (): Promise<string> => {
        if (!cacheRead) return readUnixSockets();
        if (table === undefined) table = readUnixSockets();
        return table;
      };
      const lease = await probeSessionLease({
        ...options,
        readUnixSockets: readTable,
        ownersDir: options.ownersDir(),
        sessionId,
      });
      if (lease === "held") return "active";
      if (lease === "free") return "inactive";
      return "unknown";
    };
    return probe;
  };
  const probe = create(false);
  probe.forListing = () => create(true);
  return probe;
}

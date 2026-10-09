import { basename } from "node:path";
import { probeSessionLease, type SessionLeaseOptions } from "./session-lease";

/**
 * Whether another omp is writing a chat: `running` when a live omp holds the chat's lease or names its
 * file in the process list, `none` when neither shows one, `unknown` when the app cannot tell.
 */
export type ExternalOmpState = "none" | "running" | "unknown";

const OMP_COMMAND = /^omp(\.[cm]?[jt]s)?$/;
const PROCESS_LIST_TIMEOUT_MS = 5_000;

/**
 * Reads `ps -eo pid=,args=` output: a running omp whose command line names the chat, by its file (as a
 * whole argument or inside one) or by its id (as a whole argument), other than `ignorePid` (the rename
 * host this server started). Other processes that merely mention the file, such as an editor, do not
 * count. An interactive omp started without the file shows as the bare word `omp`, so this check
 * cannot see it: the lease does.
 */
export function matchExternalOmp(
  psOutput: string,
  sessionId: string,
  sessionFile: string,
  ignorePid?: number,
): "none" | "running" {
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (Number.parseInt(trimmed, 10) === ignorePid) continue;
    const command = trimmed.replace(/^\d+\s+/, "");
    const tokens = command.split(/\s+/);
    const isOmp = tokens.some((token) => OMP_COMMAND.test(basename(token)));
    if (!isOmp) continue;
    if (command.includes(sessionFile) || tokens.includes(sessionId)) return "running";
  }
  return "none";
}

function spawnQuietly(command: readonly string[]) {
  try {
    return Bun.spawn([...command], { stdout: "pipe", stderr: "ignore" });
  } catch {
    return undefined;
  }
}

/**
 * The process list, or undefined when it cannot be read: the command cannot start, exits non-zero, or
 * runs past `timeoutMs` (it is killed then).
 */
export async function readProcessTable(
  command: readonly string[] = ["ps", "-eo", "pid=,args="],
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
): Promise<string | undefined> {
  const child = spawnQuietly(command);
  if (child === undefined) return undefined;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const output = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? output : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface ExternalOmpOptions extends SessionLeaseOptions {
  readonly sessionFile: string;
  /** The pid of the rename host this server started; it is not another omp. */
  readonly ownPid?: number;
  /** Defaults to `readProcessTable()`; injected by tests. */
  readonly readTable?: () => Promise<string | undefined>;
}

/**
 * Whether another omp is writing the chat. The lease decides: an omp that has written the chat holds
 * it. The process list is a second look, for an omp that names the file. Without the process list the
 * answer is `unknown`, and without the lease (off Linux) an empty process list means `none`.
 */
export async function findExternalOmp(options: ExternalOmpOptions): Promise<ExternalOmpState> {
  const lease = await probeSessionLease(options);
  if (lease === "held") return "running";
  const table = await (options.readTable ?? readProcessTable)();
  if (table === undefined) return "unknown";
  if (
    matchExternalOmp(table, options.sessionId, options.sessionFile, options.ownPid) === "running"
  ) {
    return "running";
  }
  return lease === "free" || lease === "unsupported" ? "none" : "unknown";
}

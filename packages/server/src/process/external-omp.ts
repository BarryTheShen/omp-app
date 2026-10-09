import { basename } from "node:path";

/**
 * Whether an omp this server did not start is running for one chat. omp writes a chat to a copy when
 * another live process holds its file, so a rename of a chat nobody has open must not start while
 * one does. `unknown` when the process table cannot be read: the rename then waits, it does not guess.
 */
export type ExternalOmpState = "none" | "running" | "unknown";

const OMP_COMMAND = /^omp(\.[cm]?[jt]s)?$/;

/**
 * Reads `ps -eo pid=,args=` output: a running omp whose command line names the chat, by its file
 * (as a whole argument or inside one) or by its id (as a whole argument). Other processes that
 * merely mention the file, such as an editor, do not count.
 */
export function matchExternalOmp(
  psOutput: string,
  sessionId: string,
  sessionFile: string,
): "none" | "running" {
  for (const line of psOutput.split("\n")) {
    const command = line.trim().replace(/^\d+\s+/, "");
    if (command.length === 0) continue;
    const tokens = command.split(/\s+/);
    const isOmp = tokens.some((token) => OMP_COMMAND.test(basename(token)));
    if (!isOmp) continue;
    if (command.includes(sessionFile) || tokens.includes(sessionId)) return "running";
  }
  return "none";
}

/** Whether another omp, one this server did not start, is running for the chat (`ps` lists it). */
export async function findExternalOmp(
  sessionId: string,
  sessionFile: string,
): Promise<ExternalOmpState> {
  let output: string;
  try {
    const child = Bun.spawn(["ps", "-eo", "pid=,args="], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 5_000);
    try {
      output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) return "unknown";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "unknown";
  }
  return matchExternalOmp(output, sessionId, sessionFile);
}

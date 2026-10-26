import { arch, platform, release } from "node:os";
import { basename } from "node:path";
import { readLogTail } from "./files";
import { scrubText, truncate } from "./scrub";

export interface DebugReportOptions {
  /** The folder holding the log files. */
  readonly directory: string;
  readonly version: string;
  readonly now?: Date;
  readonly omp?: { readonly path: string | null; readonly version: string | null };
  /** The omp and omp-app processes right now (see `listProcesses`). */
  readonly processes?: string;
  /** Log lines to include; default 2,000. */
  readonly lines?: number;
  /** Exact secrets (this launch's token) on top of the patterns every line is scrubbed with. */
  readonly secrets?: readonly string[];
}

export const REPORT_LOG_LINES = 2_000;

/** `omp-app-debug-20261007-064912.log`: sorts by time, safe in any file system. */
export function debugReportFileName(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.\d+Z$/, "");
  return `omp-app-debug-${stamp}.log`;
}

/**
 * One text file to drag into a bug report: what is running, the last lines of the log, and the omp
 * processes. Every line is scrubbed again here, even though the log is scrubbed as it is written.
 */
export function buildDebugReport(options: DebugReportOptions): string {
  const now = options.now ?? new Date();
  const secrets = options.secrets ?? [];
  const lines = options.lines ?? REPORT_LOG_LINES;
  const sections = [
    [
      "omp app debug report",
      `generated: ${now.toISOString()}`,
      `app version: ${options.version}`,
      `system: ${platform()} ${release()} ${arch()}`,
      `bun: ${process.versions.bun ?? "unknown"}`,
      `omp: ${options.omp?.version ?? "unknown"} at ${options.omp?.path ?? "unknown"}`,
      `log files: ${options.directory}`,
      "",
      "This report holds the app's own log (no prompts, file contents, tokens or keys are written to",
      "it) and the list of omp processes. File paths and error messages can appear in it.",
    ].join("\n"),
    `--- last ${lines} log lines ---\n${readLogTail(options.directory, lines)}`,
    `--- omp processes ---\n${options.processes ?? "(not collected)"}`,
  ];
  return `${scrubText(sections.join("\n\n"), secrets)}\n`;
}

/** A command word that names omp: `omp`, or the same with a script extension (`omp.js`, `omp.ts`). */
const OMP_COMMAND = /^omp(\.[cm]?[jt]s)?$/;

/** Whether a command runs omp's RPC mode: every chat does, whichever program runs it. */
function runsRpcMode(command: readonly string[]): boolean {
  return command.some((token, index) => token === "--mode" && command[index + 1] === "rpc-ui");
}

/**
 * The omp processes that `ownerPid` started, from `ps -eo pid,ppid,rss,etime,args` output: the header, then each
 * process whose parent is `ownerPid` and whose command names omp or runs omp's RPC mode (the app's chat host, or omp's
 * command line from source). Other processes are left out, including those that only mention omp or omp-app in their
 * arguments, and omp processes that other programs started.
 */
export function ompProcessLines(psOutput: string, ownerPid: number): string[] {
  const [header = "", ...rows] = psOutput.split("\n");
  const owned = rows.filter((line) => {
    const [, parent, , , ...command] = line.trim().split(/\s+/);
    return (
      Number(parent) === ownerPid &&
      (command.some((token) => OMP_COMMAND.test(basename(token))) || runsRpcMode(command))
    );
  });
  return [header, ...owned];
}

/**
 * The omp processes that `ownerPid` started (see `ompProcessLines`), or why they could not be listed. `ownerPid` is
 * the omp-app server's pid, and undefined when no server is running.
 */
export async function listProcesses(ownerPid: number | undefined): Promise<string> {
  if (ownerPid === undefined) return "(no omp-app server is running, so no omp process is listed)";
  try {
    const child = Bun.spawn(["ps", "-eo", "pid,ppid,rss,etime,args"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 5_000);
    const output = await new Response(child.stdout).text();
    clearTimeout(timer);
    const lines = ompProcessLines(output, ownerPid).map((line) => truncate(line, 240));
    return lines.length > 1 ? lines.join("\n") : `(process ${ownerPid} has no omp process)`;
  } catch (error) {
    return `(could not list processes: ${error instanceof Error ? error.message : String(error)})`;
  }
}

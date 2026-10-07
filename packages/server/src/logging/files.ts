import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LOG_FILE_NAME = "omp-app.log";

/** `$XDG_STATE_HOME/omp-app` (an absolute path), else `~/.local/state/omp-app`. */
export function stateDirectory(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const state = env.XDG_STATE_HOME?.startsWith("/")
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
  return join(state, "omp-app");
}

export function logPath(directory: string): string {
  return join(directory, LOG_FILE_NAME);
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Last `count` lines of a file's text; empty text has none. */
export function lastLines(text: string, count: number): string[] {
  if (count <= 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
}

/** The last `count` lines of the log in `directory`, oldest first, across the current and previous file. */
export function readLogTail(directory: string, count: number): string {
  const current = lastLines(readOrEmpty(logPath(directory)), count);
  const missing = count - current.length;
  const older = missing > 0 ? lastLines(readOrEmpty(`${logPath(directory)}.1`), missing) : [];
  return [...older, ...current].join("\n");
}

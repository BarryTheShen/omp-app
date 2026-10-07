/**
 * The pieces of the installed app's command (`omp-app`) that are worth testing on their own: the
 * command line, the one-instance-per-user record, and the search path that lets a desktop launch
 * find omp. `scripts/omp-app.ts` wires them to the server.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_PORT = 4317;

export const USAGE = `Usage: omp-app [folder] [options]

Starts the omp app and opens it in your browser. omp must be installed.

  folder         the folder to work in (default: the current folder)
  --port <n>     port to listen on (default: ${DEFAULT_PORT}, or a free port if that one is taken)
  --no-open      do not open the browser
  -v, --version  print the version
  -h, --help     print this help
`;

export type LauncherArgs = {
  readonly command: "run" | "help" | "version";
  readonly folder: string | undefined;
  readonly port: number | undefined;
  readonly open: boolean;
};

export type ParsedArgs =
  | { readonly ok: true; readonly args: LauncherArgs }
  | { readonly ok: false; readonly message: string };

function parsePort(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65_535 ? port : undefined;
}

export function parseLauncherArgs(argv: readonly string[]): ParsedArgs {
  let command: LauncherArgs["command"] = "run";
  let folder: string | undefined;
  let port: number | undefined;
  let open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "-h" || arg === "--help") command = "help";
    else if (arg === "-v" || arg === "--version") command = "version";
    else if (arg === "--no-open") open = false;
    else if (arg === "--port" || arg.startsWith("--port=")) {
      let text = arg.slice("--port=".length);
      if (arg === "--port") {
        index += 1;
        text = argv[index] ?? "";
      }
      port = parsePort(text);
      if (port === undefined) {
        return { ok: false, message: `--port needs a number from 0 to 65535, not "${text}".` };
      }
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `Unknown option ${arg}.` };
    } else if (folder === undefined) folder = arg;
    else return { ok: false, message: "Only one folder can be given." };
  }
  return { ok: true, args: { command, folder, port, open } };
}

const InstanceSchema = z.object({
  pid: z.number().int().positive(),
  url: z.string().min(1),
  version: z.string(),
});
export type RunningInstance = z.infer<typeof InstanceSchema>;

/** Where the running instance is recorded: `$XDG_STATE_HOME/omp-app/instance.json`. */
export function instanceFile(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const state = env.XDG_STATE_HOME?.startsWith("/")
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
  return join(state, "omp-app", "instance.json");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseInstance(text: string): RunningInstance | null {
  try {
    const parsed = InstanceSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export interface InstanceChecks {
  readonly alive: (pid: number) => boolean;
  readonly responds: (url: string) => Promise<boolean>;
}

/**
 * The instance recorded on disk, if it is really running: its process is alive and its address
 * answers. A missing, corrupt or stale record means nothing is running.
 */
export async function readRunningInstance(
  path: string,
  checks: InstanceChecks,
): Promise<RunningInstance | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const instance = parseInstance(text);
  if (instance === null || !checks.alive(instance.pid)) return null;
  return (await checks.responds(instance.url)) ? instance : null;
}

export async function recordInstance(path: string, instance: RunningInstance): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The address includes the session token: keep it readable by the user only.
  await writeFile(path, JSON.stringify(instance), { mode: 0o600 });
}

/** Removes the record only if it is ours: a newer instance may have replaced it. */
export async function clearInstance(path: string, pid: number): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (parseInstance(text)?.pid === pid) await rm(path, { force: true });
}

/**
 * The search path omp is started with. A launch from the desktop doesn't read the shell's
 * start-up files, so the folders where `bun` and `omp` usually live are added when they exist.
 */
export function ompSearchPath(
  home: string,
  currentPath: string | undefined,
  exists: (path: string) => boolean,
): string {
  const parts = (currentPath ?? "").split(":").filter((part) => part !== "");
  const extra = [join(home, ".bun", "bin"), join(home, ".local", "bin")].filter(
    (dir) => exists(dir) && !parts.includes(dir),
  );
  return [...parts, ...extra].join(":");
}

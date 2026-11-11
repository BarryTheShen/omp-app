/**
 * The pieces of the installed app's command (`omp-app`) that are worth testing on their own: the
 * command line, the one-instance-per-user record, the search path the chats' omp runs with, the
 * check that the port is free, and the start that attaches to an instance that took the port first.
 * `scripts/omp-app.ts` wires them to the server.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { SecretName } from "@omp-app/contracts";
import { z } from "zod";
import { stateDirectory } from "../logging";
import type { SecretCommand } from "./secrets-cli";

export const DEFAULT_PORT = 4317;

export const USAGE = `Usage: omp-app [folder] [options]
       omp-app tui [folder] [-- omp's options]
       omp-app pair
       omp-app devices [remove <device>]
       omp-app secret [add <name> | remove <name>]
       omp-app logs [--lines <n>]
       omp-app debug-report

Starts the omp app and opens it in your browser. The app runs the omp release it is built for,
which its package holds.

  folder         the folder to work in (default: the current folder)
  --port <n>     port to listen on (default: ${DEFAULT_PORT}, or a free port if that one is taken)
  --no-open      do not open the browser
  -v, --version  print the version
  -h, --help     print this help

omp in the terminal, on the same chats:
  tui            opens omp's own terminal app in the folder, in a tmux session that keeps running
                 when you leave it (Ctrl+B, then D) or lose the connection; run it again to go back.
                 omp's own options go after --, for example: omp-app tui -- --resume <chat id>

Each device that opens the app pairs once, and stays paired until it is removed:
  pair           print a one-time code for a new device: open the app's address on it and enter
                 the code (it works once, for 10 minutes). A device already paired can also allow
                 a new one, or make a code in Settings → App → Devices.
  devices        list the paired devices; devices remove <device> removes one, by its id (or the
                 start of it) or its name: its key stops working and its open windows close

The app's link (the address with #token=) opens it on this computer only, and stays the same when
the app restarts. Every other device pairs.

Secrets for omp's Hide Secrets, which a chat's AI sees only as placeholders (also in the app:
Settings → Providers → Secrets):
  secret         list the saved secrets: each name and the placeholder a chat's AI sees
  secret add <name>
                 save what comes in (a pipe, or typed into the terminal: it is not shown) as a
                 secret, and turn Hide Secrets on. A command a chat runs with its placeholder gets
                 the value. For example: openssl rand -hex 32 | omp-app secret add API_KEY
  secret remove <name>
                 remove a saved secret

Problems? The app keeps a log of what it does (never your prompts, files or keys):
  logs           print where the log is and its last lines (--lines sets how many, default 100)
  debug-report   write omp-app-debug-<time>.log in this folder, ready to attach to a GitHub issue
                 (to work in a folder that is really named logs, write ./logs)
`;

export type LauncherArgs = {
  readonly command:
    | "run"
    | "help"
    | "version"
    | "tui"
    | "pair"
    | "devices"
    | "secret"
    | "logs"
    | "debug-report";
  readonly folder: string | undefined;
  readonly port: number | undefined;
  readonly open: boolean;
  /** For `logs`: how many lines to print. */
  readonly lines: number | undefined;
  /** For `tui`: omp's own options, everything after `--`. */
  readonly ompArgs: readonly string[];
  /** For `devices remove <device>`: the device, by its id, the start of its id, or its name. */
  readonly removeDevice: string | undefined;
  /** For `secret`: list, or add or remove one secret, by its name. */
  readonly secret?: SecretCommand;
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
  // `pair` and `devices` take nothing else: `devices remove <device>` names one device.
  if (argv[0] === "pair") {
    return argv.length === 1
      ? { ok: true, args: { ...NO_ARGS, command: "pair" } }
      : { ok: false, message: "The pair command takes no folder or options." };
  }
  if (argv[0] === "devices") {
    if (argv.length === 1) return { ok: true, args: { ...NO_ARGS, command: "devices" } };
    const device = argv[2] ?? "";
    return argv[1] === "remove" && argv.length === 3 && device !== ""
      ? { ok: true, args: { ...NO_ARGS, command: "devices", removeDevice: device } }
      : { ok: false, message: "Use omp-app devices, or omp-app devices remove <device>." };
  }
  if (argv[0] === "secret") {
    const [, action = "list", name = "", ...rest] = argv;
    if (action === "list" && argv.length <= 2) {
      return { ok: true, args: { ...NO_ARGS, command: "secret", secret: { action: "list" } } };
    }
    if ((action === "add" || action === "remove") && name !== "" && rest.length === 0) {
      if (!SecretName.safeParse(name).success) {
        return {
          ok: false,
          message: `"${name}" cannot name a secret: use letters, digits, '_', '.' and '-', starting with a letter or digit.`,
        };
      }
      return { ok: true, args: { ...NO_ARGS, command: "secret", secret: { action, name } } };
    }
    return {
      ok: false,
      message: "Use omp-app secret, omp-app secret add <name>, or omp-app secret remove <name>.",
    };
  }
  let command: LauncherArgs["command"] = "run";
  let folder: string | undefined;
  let port: number | undefined;
  let open = true;
  let lines: number | undefined;
  let ompArgs: readonly string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      if (command !== "tui") {
        return { ok: false, message: "Only the tui command takes omp's options after --." };
      }
      ompArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "-h" || arg === "--help") command = "help";
    else if (arg === "-v" || arg === "--version") command = "version";
    else if (arg === "--no-open") open = false;
    else if (arg === "--lines" || arg.startsWith("--lines=")) {
      let text = arg.slice("--lines=".length);
      if (arg === "--lines") {
        index += 1;
        text = argv[index] ?? "";
      }
      lines = /^[0-9]{1,6}$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
      if (lines === undefined) {
        return { ok: false, message: `--lines needs a number above 0, not "${text}".` };
      }
    } else if (arg === "--port" || arg.startsWith("--port=")) {
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
    } else if (index === 0 && (arg === "tui" || arg === "logs" || arg === "debug-report")) {
      command = arg;
    } else if (folder === undefined) folder = arg;
    else return { ok: false, message: "Only one folder can be given." };
  }
  if (command === "tui" && (port !== undefined || !open || lines !== undefined)) {
    return {
      ok: false,
      message: "The tui command takes a folder, then omp's own options after --.",
    };
  }
  return {
    ok: true,
    args: { command, folder, port, open, lines, ompArgs, removeDevice: undefined },
  };
}

/** The arguments of a command that takes none. */
const NO_ARGS: Omit<LauncherArgs, "command"> = {
  folder: undefined,
  port: undefined,
  open: true,
  lines: undefined,
  ompArgs: [],
  removeDevice: undefined,
};

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
  return join(stateDirectory(env, home), "instance.json");
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
 * The address that opens a running app: its launch link (`…/#token=…`), with the folder to open it on (an absolute
 * path) added to the fragment when there is one. The page reads the folder once when it loads (`launch/token.ts`).
 */
export function launchAddress(link: string, folder: string | undefined): string {
  return folder === undefined ? link : `${link}&folder=${encodeURIComponent(folder)}`;
}

/**
 * The search path the chats' omp runs with, so its tools find the user's programs. A launch from the
 * desktop doesn't read the shell's start-up files, so the folders where `bun` and other user tools
 * usually live are added when they exist.
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

/**
 * Whether nothing is listening on the port now. The check binds `probe` to the loopback address and
 * closes it again at once. A connection that arrives while it listens is dropped, never waited for.
 */
export function portIsFree(port: number, probe: Server = createServer()): Promise<boolean> {
  const { promise, resolve: done } = Promise.withResolvers<boolean>();
  // close() calls back only when every accepted socket has ended, so each one is dropped at once:
  // the check never waits on a client that holds its socket open.
  probe.on("connection", (socket) => socket.destroy());
  probe.once("error", () => done(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  return promise;
}

/** Bun's error for a port that something else listens on: "Failed to start server. Is port N in use?", code EADDRINUSE. */
export function isPortTaken(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

/** The server's start failed on a taken port and no instance of the app appeared in time: nothing to attach to. */
export class PortTakenError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} was taken while omp app was starting. Start it again.`);
    this.name = "PortTakenError";
  }
}

/** What a start came to: the server this process started, or the instance that was already running. */
export type StartResult<S> = { readonly server: S } | { readonly running: RunningInstance };

/** Time for `startOrAttach`'s wait; a test passes its own so the wait costs nothing. */
export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
};

/** How often, and for how long, a start that lost the port looks for the winner's record. */
export const ATTACH_POLL_MS = 100;
export const ATTACH_WAIT_MS = 3_000;

/**
 * Starts the server. The server downloads the pinned omp before it listens and is recorded only after it listens,
 * so a second start in that time sees neither a record nor a taken port, and its bind then fails. When the bind
 * fails because the port is taken, the winner writes its record right after it binds, so the record is read every
 * `ATTACH_POLL_MS` for up to `ATTACH_WAIT_MS`: the first running instance it names is returned for the caller to
 * attach to; with none by then, `PortTakenError`. Any other failure to start is thrown unchanged.
 */
export async function startOrAttach<S>(options: {
  readonly port: number;
  readonly start: () => Promise<S>;
  readonly readRunning: () => Promise<RunningInstance | null>;
  readonly clock?: Clock;
}): Promise<StartResult<S>> {
  try {
    return { server: await options.start() };
  } catch (error) {
    if (!isPortTaken(error)) throw error;
    const clock = options.clock ?? REAL_CLOCK;
    const deadline = clock.now() + ATTACH_WAIT_MS;
    for (;;) {
      const running = await options.readRunning();
      if (running !== null) return { running };
      if (clock.now() >= deadline) throw new PortTakenError(options.port);
      await clock.sleep(ATTACH_POLL_MS);
    }
  }
}

/**
 * One chat's bug must not end every open chat: an unhandled promise rejection otherwise ends the
 * server process (a crash in the gateway did exactly that). The error is logged in full, never
 * hidden, and the server keeps running. Returns a function that removes the handler.
 */
export function installUnhandledRejectionLogger(log: (message: string) => void): () => void {
  const handler = (reason: unknown) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`omp-app: an unexpected error was caught and the app keeps running.\n${detail}`);
  };
  process.on("unhandledRejection", handler);
  return () => {
    process.off("unhandledRejection", handler);
  };
}

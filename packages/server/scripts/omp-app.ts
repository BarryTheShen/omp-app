#!/usr/bin/env bun
/**
 * The installed app's command (`omp-app`): starts the composed server (`dev.ts`), opens the browser
 * at its address, and keeps one instance per user. `packaging/build-deb.sh` compiles this file into
 * the .deb; from a source checkout, run `bun run build && bun packages/server/scripts/omp-app.ts`.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { probeOmp } from "../src/capabilities/omp-version";
import {
  clearInstance,
  DEFAULT_PORT,
  installUnhandledRejectionLogger,
  instanceFile,
  launchAddress,
  ompSearchPath,
  PortTakenError,
  parseLauncherArgs,
  portIsFree,
  type RunningInstance,
  readRunningInstance,
  recordInstance,
  type StartResult,
  startOrAttach,
  USAGE,
} from "../src/launcher/launcher";
import {
  buildDebugReport,
  createLogger,
  debugReportFileName,
  listProcesses,
  logPath,
  readLogTail,
  stateDirectory,
} from "../src/logging";
import { ompCommand } from "../src/omp-host/chat-command";
import { parseRemoteOrigin, REMOTE_ORIGIN_ENV } from "../src/remote-origin";
import { type CompositionServer, createCompositionServer } from "./dev";

/** Replaced with the release version when `packaging/build-deb.sh` compiles this file. */
declare const OMP_APP_VERSION: string | undefined;
const version = typeof OMP_APP_VERSION === "string" ? OMP_APP_VERSION : "dev";

function fail(message: string): never {
  console.error(`omp-app: ${message}`);
  process.exit(1);
}

/** The built web app: next to the installed command, or in a source checkout. */
function webRoot(): string {
  const candidates = [
    Bun.env.OMP_APP_WEB_ROOT,
    resolve(dirname(process.execPath), "../share/omp-app/web"),
    resolve(import.meta.dir, "../../../apps/web/dist"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(resolve(candidate, "index.html"))) return resolve(candidate);
  }
  return fail(
    "the app's web files were not found. Reinstall the package, or run `bun run build` in a source checkout.",
  );
}

/** The chat host the packages install beside the command: omp's own command line, built by the app (#2586). */
const INSTALLED_CHAT_HOST = resolve(dirname(process.execPath), "../lib/omp-app/chat-host");
/** A compiled command holds its sources in Bun's in-memory folder, where they cannot run as omp. */
const COMPILED = import.meta.dir.startsWith("/$bunfs/");

/**
 * The chat host that runs omp's commands and every chat: `OMP_APP_CHAT_HOST_BIN`, else the installed one. A source
 * checkout without either runs omp's command line from the pinned package on Bun instead.
 */
function chatHostBinary(): string | undefined {
  if (Bun.env.OMP_APP_CHAT_HOST_BIN) return Bun.env.OMP_APP_CHAT_HOST_BIN;
  return COMPILED || existsSync(INSTALLED_CHAT_HOST) ? INSTALLED_CHAT_HOST : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function responds(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/", url), { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    // No answer is the point of this check: nothing is listening there.
    return false;
  }
}

function openBrowser(address: string): void {
  try {
    Bun.spawn(["xdg-open", address], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    console.log("Could not open a browser by itself. Open the address above in your browser.");
  }
}

/** The folder a path names, resolved from the current folder; ends the command when it is not a folder. */
function existingFolder(path: string): string {
  const folder = resolve(path);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) fail(`"${folder}" is not a folder.`);
  return folder;
}

const parsed = parseLauncherArgs(process.argv.slice(2));
if (!parsed.ok) fail(`${parsed.message}\n\n${USAGE}`);
const { args } = parsed;
if (args.command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (args.command === "version") {
  console.log(version);
  process.exit(0);
}

const home = homedir();
const logDir = stateDirectory(Bun.env, home);
const chatHost = chatHostBinary();

if (args.command === "logs") {
  const tail = readLogTail(logDir, args.lines ?? 100);
  console.log(`Log file: ${logPath(logDir)}\n`);
  console.log(tail.length > 0 ? tail : "(the log is empty: start the app once first)");
  process.exit(0);
}
if (args.command === "debug-report") {
  const searchPath = ompSearchPath(home, Bun.env.PATH, existsSync);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env))
    if (value !== undefined) environment[key] = value;
  const omp = ompCommand({ binary: chatHost });
  const probe = await probeOmp(omp, { ...environment, PATH: searchPath }, process.cwd());
  const now = new Date();
  const target = resolve(process.cwd(), debugReportFileName(now));
  // The omp processes listed are the running server's: this command starts none of its own.
  const running = await readRunningInstance(instanceFile(Bun.env, home), {
    alive: isAlive,
    responds,
  });
  writeFileSync(
    target,
    buildDebugReport({
      directory: logDir,
      version,
      now,
      omp: { path: omp.join(" "), version: probe.version },
      processes: await listProcesses(running?.pid),
    }),
    { mode: 0o600 },
  );
  console.log(`Wrote ${target}\n\nAttach this file to your GitHub issue.`);
  process.exit(0);
}

const logger = createLogger({ dir: logDir });
// A crash leaves its stack in the log: both the caught rejections and the exception that ends the app.
installUnhandledRejectionLogger((message) => {
  console.error(message);
  logger.error("unhandled_rejection", { stack: message });
});
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { message: error.message, stack: error.stack });
  console.error(error);
  process.exit(1);
});

const record = instanceFile(Bun.env, home);
const readRunning = () => readRunningInstance(record, { alive: isAlive, responds });

/** What a launch does when the app already runs: shows its link, opens it, and ends the command. */
function attachToRunning(running: RunningInstance): never {
  // A folder on the command line opens the running app on that folder: the page reads it from the address.
  const address = launchAddress(
    running.url,
    args.folder === undefined ? undefined : existingFolder(args.folder),
  );
  console.log(`omp app ${running.version} is already running.\n\n  ${address}\n`);
  if (args.open) openBrowser(address);
  process.exit(0);
}

const running = await readRunning();
if (running) attachToRunning(running);

const folder = existingFolder(args.folder ?? process.cwd());
const searchPath = ompSearchPath(home, Bun.env.PATH, existsSync);
try {
  parseRemoteOrigin(Bun.env[REMOTE_ORIGIN_ENV]);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const envPort = Number(Bun.env.OMP_APP_PORT ?? DEFAULT_PORT);
let port = args.port ?? (Number.isInteger(envPort) ? envPort : DEFAULT_PORT);
if (port !== 0 && !(await portIsFree(port))) {
  if (args.port !== undefined) fail(`port ${port} is in use. Pick another with --port.`);
  console.log(`Port ${port} is in use; using a free one.`);
  port = 0;
}

if (chatHost !== undefined && !existsSync(chatHost)) {
  fail(`the app's chat host is missing (${chatHost}). Reinstall the package.`);
}
let started: StartResult<CompositionServer>;
try {
  started = await startOrAttach({
    port,
    start: () =>
      createCompositionServer({
        port,
        staticRoot: webRoot(),
        chatHostBinary: chatHost,
        cwd: folder,
        env: { PATH: searchPath },
        serverVersion: version,
        logger,
      }),
    readRunning,
  });
} catch (error) {
  if (error instanceof PortTakenError) fail(error.message);
  throw error;
}
// Another start took the port first, while this one was starting: this command is that one's "already running".
if ("running" in started) attachToRunning(started.running);
const { server } = started;
const address = `${server.url}/#token=${encodeURIComponent(server.token)}`;
await recordInstance(record, { pid: process.pid, url: address, version });
console.log(`omp app ${version}\n\n  ${address}\n\nPress Ctrl+C or close this window to quit.`);
if (server.remoteUrl !== undefined) {
  console.log(
    `\nFrom another device on your tailnet:\n\n  ${server.remoteUrl}/#token=${encodeURIComponent(server.token)}\n\nThis computer must serve it: tailscale serve --bg localhost:${server.port}`,
  );
}
if (server.health.status !== "ok") {
  console.warn(
    `\nWarning: ${server.health.detail ?? "omp is not working."} The app opens, but chats cannot start. Run \`omp-app debug-report\` and attach the file to an issue.`,
  );
}
if (args.open) openBrowser(address);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
  } finally {
    await clearInstance(record, process.pid);
  }
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    stop().catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
  });
}

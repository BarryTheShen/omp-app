#!/usr/bin/env bun
/**
 * The installed app's command (`omp-app`): starts the composed server (`dev.ts`), opens the browser
 * at its address, and keeps one instance per user. `packaging/build-deb.sh` compiles this file into
 * the .deb; from a source checkout, run `bun run build && bun packages/server/scripts/omp-app.ts`.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  clearInstance,
  DEFAULT_PORT,
  installUnhandledRejectionLogger,
  instanceFile,
  ompSearchPath,
  parseLauncherArgs,
  readRunningInstance,
  recordInstance,
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
import { createCompositionServer, probeOmp } from "./dev";

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

function portIsFree(port: number): Promise<boolean> {
  const { promise, resolve: done } = Promise.withResolvers<boolean>();
  const probe = createServer();
  probe.once("error", () => done(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  return promise;
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

if (args.command === "logs") {
  const tail = readLogTail(logDir, args.lines ?? 100);
  console.log(`Log file: ${logPath(logDir)}\n`);
  console.log(tail.length > 0 ? tail : "(the log is empty: start the app once first)");
  process.exit(0);
}
if (args.command === "debug-report") {
  const searchPath = ompSearchPath(home, Bun.env.PATH, existsSync);
  const ompBin = Bun.env.OMP_BIN ?? Bun.which("omp", { PATH: searchPath }) ?? "omp";
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env))
    if (value !== undefined) environment[key] = value;
  const probe = await probeOmp(ompBin, { ...environment, PATH: searchPath }, process.cwd());
  const now = new Date();
  const target = resolve(process.cwd(), debugReportFileName(now));
  writeFileSync(
    target,
    buildDebugReport({
      directory: logDir,
      version,
      now,
      omp: { path: ompBin, version: probe.version },
      processes: await listProcesses(),
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
const running = await readRunningInstance(record, { alive: isAlive, responds });
if (running) {
  console.log(`omp app ${running.version} is already running.\n\n  ${running.url}\n`);
  if (args.open) openBrowser(running.url);
  process.exit(0);
}

const folder = resolve(args.folder ?? process.cwd());
if (!existsSync(folder) || !statSync(folder).isDirectory()) fail(`"${folder}" is not a folder.`);
const searchPath = ompSearchPath(home, Bun.env.PATH, existsSync);
const ompBin = Bun.env.OMP_BIN ?? Bun.which("omp", { PATH: searchPath }) ?? "omp";

const envPort = Number(Bun.env.OMP_APP_PORT ?? DEFAULT_PORT);
let port = args.port ?? (Number.isInteger(envPort) ? envPort : DEFAULT_PORT);
if (port !== 0 && !(await portIsFree(port))) {
  if (args.port !== undefined) fail(`port ${port} is in use. Pick another with --port.`);
  console.log(`Port ${port} is in use; using a free one.`);
  port = 0;
}

const server = await createCompositionServer({
  port,
  staticRoot: webRoot(),
  cwd: folder,
  ompBin,
  env: { PATH: searchPath },
  serverVersion: version,
  logger,
});
const address = `${server.url}/#token=${encodeURIComponent(server.token)}`;
await recordInstance(record, { pid: process.pid, url: address, version });
console.log(`omp app ${version}\n\n  ${address}\n\nPress Ctrl+C or close this window to quit.`);
if (server.health.status !== "ok") {
  console.warn(
    `\nWarning: omp is not working (${server.health.detail ?? "unknown problem"}). Install omp and check that \`omp --version\` works, then start the app again. The app opens, but chats cannot start.`,
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

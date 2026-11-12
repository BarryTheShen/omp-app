#!/usr/bin/env bun
/**
 * The installed app's command (`omp-app`): starts the composed server (`dev.ts`), opens the browser
 * at its address, and keeps one instance per user. `packaging/build-deb.sh` compiles this file into
 * the .deb; from a source checkout, run `bun run build && bun packages/server/scripts/omp-app.ts`.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppFailure, DeviceList, PAIRING_PATHS, PairingCode } from "@omp-app/contracts";
import { probeOmp } from "../src/capabilities/omp-version";
import { FRAME_ANCESTORS_ENV, parseFrameAncestors } from "../src/frame-ancestors";
import { keepLaunchToken, launchTokenFile } from "../src/launch-token";
import {
  callPairing,
  devicesText,
  findDevice,
  pairingCodeText,
  serverLink,
} from "../src/launcher/devices-cli";
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
import { readSecretValue, runSecretCommand } from "../src/launcher/secrets-cli";
import {
  TUI_SETTINGS,
  tuiCommands,
  tuiEnvironment,
  tuiSessionName,
  tuiSettingsFile,
} from "../src/launcher/tui";
import {
  buildDebugReport,
  createLogger,
  debugReportFileName,
  listProcesses,
  logPath,
  readLogTail,
  stateDirectory,
} from "../src/logging";
import { createConfigStore } from "../src/modules/A1/config";
import { hideSecretsThrough, SecretStoreService } from "../src/modules/A1/secrets";
import { ompCommand } from "../src/omp-host/chat-command";
import { appDataFolder, handBackHosts, hostsFolder } from "../src/process";
import { parseRemoteOrigin, REMOTE_ORIGIN_ENV } from "../src/remote-origin";
import { type CompositionServer, createCompositionServer } from "./dev";

/** Replaced with the release version when `packaging/build-deb.sh` compiles this file. */
declare const OMP_APP_VERSION: string | undefined;
const version = typeof OMP_APP_VERSION === "string" ? OMP_APP_VERSION : "dev";

function fail(message: string): never {
  console.error(`omp-app: ${message}`);
  process.exit(1);
}

/** The built web app (served at the root): next to the installed command, or in a source checkout. */
function uiRoot(): string {
  const candidates = [
    Bun.env.OMP_APP_UI_ROOT,
    resolve(dirname(process.execPath), "../share/omp-app/ui"),
    resolve(import.meta.dir, "../../../apps/ui/dist"),
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

if (args.command === "secret" && args.secret !== undefined) {
  // omp's agent folder as the server finds it: inside a chat this is the chat's own, so a secret a command saves is
  // in the file every chat reads.
  const agentDir = resolve(Bun.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent"));
  const config = createConfigStore({ env: Bun.env, homeDir: home, agentDir });
  const store = new SecretStoreService({ agentDir, hideSecrets: hideSecretsThrough(config) });
  const command = args.secret;
  try {
    console.log(
      await runSecretCommand(command, store, () =>
        readSecretValue(
          process.stdin,
          command.action === "list" ? "" : command.name,
          () => Bun.stdin.text(),
          (text) => process.stderr.write(text),
        ),
      ),
    );
  } catch (error) {
    fail(error instanceof AppFailure ? error.appError.message : String(error));
  } finally {
    store.dispose();
    config.dispose();
  }
  process.exit(0);
}

if (args.command === "tui") {
  if (chatHost !== undefined && !existsSync(chatHost)) {
    fail(`the app's chat host is missing (${chatHost}). Reinstall the package.`);
  }
  const folder = existingFolder(args.folder ?? process.cwd());
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "the tui command opens omp in this terminal, and this is not one. Run it in a terminal (over SSH: ssh -t).",
    );
  }
  const tmux = Bun.which("tmux");
  if (tmux === null) {
    fail(
      "the tui command runs omp in tmux, which is not installed. Install it (on Ubuntu: sudo apt install tmux), then run this again.",
    );
  }
  const name = tuiSessionName(folder);
  const running =
    Bun.spawnSync([tmux, "has-session", "-t", `=${name}`], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0;
  if (running && args.ompArgs.length > 0) {
    console.log(
      `omp is already open on ${folder}, so this goes back to it. The options after -- apply when it starts: quit it (/exit) and run this again to use them.`,
    );
  }
  if (!running) {
    // D2: chats that the app's hosts keep running with no app server holding them are taken back first, so omp opens
    // them here and not a copy. A reply still being written is finished first.
    const taken = await handBackHosts({
      hostsDir: hostsFolder(appDataFolder(Bun.env, home), Bun.env),
      waitMs: 10_000,
      onAsked: (count) =>
        console.log(`Taking ${count === 1 ? "a chat" : `${count} chats`} back from the app…`),
    });
    if (taken.finishing > 0) {
      console.log(
        `${taken.finishing === 1 ? "A chat is" : `${taken.finishing} chats are`} still finishing a reply; each comes back when its reply ends. Opened here before then, omp works on a copy of it.`,
      );
    }
  }
  // Written each start, so a removed or edited file comes back as the app needs it.
  const appData = appDataFolder(Bun.env, home);
  mkdirSync(appData, { recursive: true });
  const settingsFile = tuiSettingsFile(appData);
  writeFileSync(settingsFile, TUI_SETTINGS);
  const commands = tuiCommands({
    tmux,
    folder,
    omp: ompCommand({ binary: chatHost }),
    ompArgs: args.ompArgs,
    settingsFile,
    env: tuiEnvironment(Bun.env, ompSearchPath(home, Bun.env.PATH, existsSync)),
    insideTmux: (Bun.env.TMUX ?? "") !== "",
    running,
  });
  for (const command of commands) {
    const code = await Bun.spawn([...command], { stdio: ["inherit", "inherit", "inherit"] }).exited;
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
}

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
if (args.command === "pair" || args.command === "devices") {
  const running = await readRunningInstance(instanceFile(Bun.env, home), {
    alive: isAlive,
    responds,
  });
  const link = running === null ? undefined : serverLink(running.url);
  if (link === undefined) {
    fail(
      "the app is not running, and only the running app can pair or list devices. Start it first (systemctl --user start omp-app when it runs as the service, or omp-app).",
    );
  }
  try {
    if (args.command === "pair") {
      const made = PairingCode.parse(
        await callPairing(link, PAIRING_PATHS.newCode, { method: "POST" }),
      );
      console.log(pairingCodeText(made));
    } else {
      const list = DeviceList.parse(
        await callPairing(link, PAIRING_PATHS.devices, { method: "GET" }),
      );
      if (args.removeDevice === undefined) {
        console.log(devicesText(list));
      } else {
        const found = findDevice(list.devices, args.removeDevice);
        if (found === "none")
          fail(`no paired device is named "${args.removeDevice}". omp-app devices lists them.`);
        if (found === "several")
          fail(`several paired devices match "${args.removeDevice}": give more of the id.`);
        const after = DeviceList.parse(
          await callPairing(link, PAIRING_PATHS.remove, {
            method: "POST",
            body: { deviceId: found.id },
          }),
        );
        console.log(
          `Removed ${found.name}: its key stops working and its open windows close.\n\n${devicesText(after)}`,
        );
      }
    }
  } catch (error) {
    fail(`could not reach the app: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  parseFrameAncestors(Bun.env[FRAME_ANCESTORS_ENV]);
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
// The link stays the same from one start to the next: the token is kept beside the instance record, so a link saved on
// this computer (a bookmark, the desktop window's way to this computer's app) survives a restart. It opens the app on
// this computer only; every other device pairs.
const launchToken = await keepLaunchToken(launchTokenFile(logDir));
if (!launchToken.kept) logger.warn("launch-token.not-saved", { detail: launchToken.reason });
let started: StartResult<CompositionServer>;
try {
  started = await startOrAttach({
    port,
    start: () =>
      createCompositionServer({
        port,
        uiRoot: uiRoot(),
        chatHostBinary: chatHost,
        newChatsReady: true,
        earlyStats: true,
        cwd: folder,
        env: { PATH: searchPath },
        serverVersion: version,
        token: launchToken.token,
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
    `\nFrom another device, open ${server.remoteUrl} and pair it: allow it on a device that is already paired, or enter the one-time code omp-app pair prints here.\n\nServe that address over HTTPS and pass it to http://127.0.0.1:${server.port} (with Tailscale: tailscale serve --bg localhost:${server.port}).`,
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

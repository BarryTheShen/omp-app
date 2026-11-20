/**
 * `omp-app-device setup` and `omp-app-device remove` (#20), as root. The package only installs files; these turn the
 * idle files into agent access that can be turned on, and back:
 *
 *   setup [--json]    the agent account, the deny lines, the host key, the guard's settings, the guard started, then
 *                     the checks a turn-on makes (said plainly; nothing of the person's is changed)
 *   remove [--json]   off, the guard stopped, the account and what setup made removed; the access log and a pending
 *                     review are kept (the package's purge deletes them)
 *
 * They run through pkexec (the desktop app's Agent access panel: an administrator's password, polkit actions
 * `dev.ompapp.device.setup` and `.remove`) or sudo (a server). The person is the administrator account that asked;
 * root never is. With --json, one JSON line at the end: { ok, person, problems }.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { chmod, chown, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NOT_LINKED } from "../agent/agent";
import { SystemAgentAccount, systemSshdProblem } from "../guard/account";
import {
  type AccountFacts,
  AGENT_ACCOUNT,
  agentAccountProblem,
  denyAction,
  guardSettings,
  invokerUid,
  otherPerson,
  PATHS,
  personProblem,
  uidRangeOf,
  withAccount,
  withoutAccount,
} from "./plan";

// pkexec and sudo hand over the caller's umask, working folder, PATH entries and stdio: none of it is trusted.
const PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
process.umask(0o022);
process.chdir("/");
process.env.PATH = PATH;
for (const signal of ["SIGPIPE", "SIGHUP", "SIGXFSZ"] as const) process.on(signal, () => undefined);

const command = process.argv[2];
const rest = process.argv.slice(3);
const json = rest.includes("--json");

/** Runs a system program found on the fixed PATH, for at most 2 minutes; its exit code and output. */
function run(argv: string[]): { code: number; out: string } {
  const done = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH },
    timeout: 120_000,
  });
  return { code: done.exitCode ?? 1, out: `${done.stdout}${done.stderr}`.trim() };
}

/** What this run changed on the computer, in order, said plainly: the record setup and remove leave. */
const changes: string[] = [];

/**
 * The run's record, also when it stopped part-way: one line in the access log (`type` setup or remove, who asked, what
 * changed, what stands in the way) and a summary in the system journal, so what agent access did to this computer, and
 * what undoes it, can always be read back. A record that cannot be written never stops the answer.
 */
function record(ok: boolean, person: string | null, problems: string[]): void {
  // A refused call (not root, an unknown command) changed nothing and is not a run.
  if (process.getuid?.() !== 0 || (command !== "setup" && command !== "remove")) return;
  try {
    mkdirSync(PATHS.logDir, { recursive: true, mode: 0o750 });
    appendFileSync(
      join(PATHS.logDir, "access.log"),
      `${JSON.stringify({ type: command, at: new Date().toISOString(), ok, person, changes, problems })}\n`,
      { mode: 0o640 },
    );
  } catch {
    // The journal line below still says it.
  }
  const summary = `${command} ${ok ? "done" : "not done"}${person === null ? "" : ` for ${person}`}: ${
    changes.length === 0 ? "nothing changed" : changes.join("; ")
  }${problems.length === 0 ? "" : `. Problems: ${problems.join("; ")}`}`;
  run(["logger", "-t", "omp-app-device", summary]);
}

function finish(ok: boolean, person: string | null, problems: string[]): never {
  record(ok, person, problems);
  if (json) console.log(JSON.stringify({ ok, person, problems, changes }));
  else {
    for (const change of changes) console.log(`+ ${change}`);
    for (const problem of problems) console.log(`- ${problem}`);
    console.log(ok ? "Done." : "Not done.");
  }
  process.exit(ok ? 0 : 1);
}

function fail(reason: string, person: string | null = null): never {
  if (!json) process.stderr.write(`${reason}\n`);
  finish(false, person, [reason]);
}

// Anything that throws (a full disk, an account without its home) still answers, and the lock goes with the process.
process.on("uncaughtException", (error) =>
  fail(
    `agent access could not be ${command === "remove" ? "removed" : "set up"}: ${error.message}`,
  ),
);

/** The lock's holder, kept referenced for the program's life: its pipe closing lets the lock go. */
let lockHolder: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;

/**
 * One setup or remove at a time: flock(1) holds a lock on a file in /run while its child reads this program's pipe, so
 * the kernel lets it go when this program ends in any way (a crash or a kill included), never by a timer.
 */
async function takeLock(): Promise<void> {
  lockHolder = Bun.spawn(
    [
      "flock",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      PATHS.lock,
      "sh",
      "-c",
      "echo locked; read _",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH } },
  );
  lockHolder.unref();
  const first = await lockHolder.stdout.getReader().read();
  if (first.done !== true) return;
  if ((await lockHolder.exited) === 75) fail("another setup or remove of agent access is running");
  fail("the lock of agent access's setup could not be taken");
}

/** An account's line in the password database (by name or uid), with its groups. */
function account(key: string): AccountFacts | null {
  const line = run(["getent", "passwd", key]).out.split("\n")[0] ?? "";
  const [name, , uid, , , home, shell] = line.split(":");
  if (name === undefined || name === "" || uid === undefined || home === undefined) return null;
  const groups = run(["id", "-Gn", name]).out.split(/\s+/).filter(Boolean);
  return { name, uid: Number(uid), home, shell: shell ?? "", groups };
}

/** login.defs' range of people's uids. */
function uidRange(): { uidMin: number; uidMax: number } {
  return uidRangeOf(existsSync("/etc/login.defs") ? readFileSync("/etc/login.defs", "utf8") : "");
}

/** Writes a root-owned file whole (a new file of a unique name renamed over it), in a folder only root can write. */
async function writeWhole(path: string, text: string, mode: number): Promise<void> {
  const next = `${path}.${process.pid}.${Date.now()}.new`;
  await writeFile(next, text, { mode, flag: "wx" });
  await rename(next, path);
}

async function readOrNull(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

interface Made {
  uid?: number;
  /** Deny files setup created (removed again when they hold nothing else). */
  created?: string[];
}

async function readMade(): Promise<Made | null> {
  const text = await readOrNull(PATHS.made);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Made;
  } catch {
    return {};
  }
}

if (process.getuid?.() !== 0)
  fail(
    "this needs an administrator: run it from the desktop app's Agent access panel, or with sudo",
  );
if ((command !== "setup" && command !== "remove") || rest.some((arg) => arg !== "--json"))
  fail("use omp-app-device setup or omp-app-device remove");
await takeLock();

if (command === "setup") {
  const uid = invokerUid(process.env);
  if (typeof uid === "string") fail(uid);
  const person = account(String(uid));
  if (person === null) fail("the account that asked was not found");
  const range = uidRange();
  const shells = (await readOrNull("/etc/shells"))?.split("\n").map((line) => line.trim()) ?? [];
  const homeOwner = statSync(person.home, { throwIfNoEntry: false })?.uid ?? null;
  const unfit = personProblem(person, { ...range, shells, homeOwner });
  if (unfit !== null) fail(unfit, person.name);
  const other = otherPerson(await readOrNull(PATHS.settings), person.uid);
  if (other !== null)
    fail(
      `agent access on this computer is set up for ${other}: remove it first (in the Agent access panel of that account's desktop app, or sudo omp-app-device remove)`,
      person.name,
    );
  if (!existsSync(join(PATHS.openssh, "usr/sbin/sshd")))
    fail("the OpenSSH programs of agent access are missing: reinstall the app", person.name);

  await mkdir(PATHS.settingsDir, { recursive: true, mode: 0o700 });
  await chmod(PATHS.settingsDir, 0o700);
  const made: Made = (await readMade()) ?? {};

  // The agent account: a system account whose shell reads no startup files (dash), and no group but its own. One that
  // exists is used only when setup made it.
  const existing = account(AGENT_ACCOUNT);
  if (existing === null) {
    const created = run([
      "useradd",
      "--system",
      "--user-group",
      "--create-home",
      "--home-dir",
      PATHS.agentHome,
      "--shell",
      "/bin/sh",
      "--comment",
      "omp-app agents",
      AGENT_ACCOUNT,
    ]);
    const now = account(AGENT_ACCOUNT);
    if (created.code !== 0 || now === null)
      fail(`the agent account could not be made: ${created.out}`, person.name);
    made.uid = now.uid;
    await writeWhole(PATHS.made, `${JSON.stringify(made)}\n`, 0o600);
    changes.push(
      `made the system account ${AGENT_ACCOUNT} (uid ${now.uid}, home ${PATHS.agentHome}, shell /bin/sh)`,
    );
  } else {
    const problem = agentAccountProblem(existing, made, range.uidMin);
    if (problem !== null) fail(problem, person.name);
    run(["usermod", "--shell", "/bin/sh", AGENT_ACCOUNT]);
    changes.push(`kept the account ${AGENT_ACCOUNT} an earlier setup made (uid ${existing.uid})`);
  }
  const agent = account(AGENT_ACCOUNT);
  if (agent === null) fail("the agent account is missing", person.name);
  await chown(PATHS.agentHome, agent.uid, Number(run(["id", "-g", AGENT_ACCOUNT]).out));
  await chmod(PATHS.agentHome, 0o750);

  // No scheduled jobs for the agent account, without changing who else may schedule them.
  made.created ??= [];
  for (const kind of ["cron", "at"] as const) {
    const deny = `/etc/${kind}.deny`;
    const action = denyAction(kind, {
      allowExists: existsSync(`/etc/${kind}.allow`),
      denyExists: existsSync(deny),
    });
    if (action === "nothing") continue;
    const next = withAccount((await readOrNull(deny)) ?? "", AGENT_ACCOUNT);
    if (next !== null) {
      await writeWhole(deny, next, 0o644);
      changes.push(
        `${action === "create" ? "made" : "added a line to"} ${deny}: ${AGENT_ACCOUNT} may not schedule jobs`,
      );
    }
    if (action === "create" && !made.created.includes(deny)) made.created.push(deny);
  }
  await writeWhole(PATHS.made, `${JSON.stringify(made)}\n`, 0o600);

  // The computer's host key: the private half for the sessions' sshd (the agent account's group), the public half
  // for enrollment.
  await mkdir(PATHS.hostKeyDir, { recursive: true, mode: 0o755 });
  if (!existsSync(PATHS.hostKey)) {
    const keyed = run([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "",
      "-f",
      PATHS.hostKey,
    ]);
    if (keyed.code !== 0) fail(`the host key could not be made: ${keyed.out}`, person.name);
    changes.push(`made this computer's host key in ${PATHS.hostKeyDir}`);
  }
  run(["chgrp", AGENT_ACCOUNT, PATHS.hostKey]);
  await chmod(PATHS.hostKey, 0o640);

  const split = existsSync(join(PATHS.openssh, "usr/lib/openssh/sshd-session"));
  await writeWhole(
    PATHS.settings,
    `${JSON.stringify(guardSettings(person.name, person.uid, split), null, 2)}\n`,
    0o600,
  );
  changes.push(`wrote the guard's settings ${PATHS.settings} (person: ${person.name})`);
  // The access log is kept two years (monthly, 24 kept), not without end; also after a remove, until the purge.
  await writeWhole(
    PATHS.logrotate,
    `${PATHS.logDir}/access.log {\n  monthly\n  rotate 24\n  compress\n  delaycompress\n  missingok\n  notifempty\n  su root root\n  create 0640 root root\n}\n`,
    0o644,
  );
  changes.push(`wrote the access log's rotation ${PATHS.logrotate} (kept two years)`);

  // The guard, started (again: it reads its settings at its start).
  run(["systemctl", "daemon-reload"]);
  run(["systemctl", "enable", PATHS.guardUnit]);
  const started = run(["systemctl", "restart", PATHS.guardUnit]);
  if (started.code !== 0) fail(`the guard did not start: ${started.out}`, person.name);
  changes.push(`enabled and started ${PATHS.guardUnit} (access stays off until turned on)`);

  // The checks a turn-on makes, now, so the person hears them before turning on.
  const problems: string[] = [];
  const problem = await new SystemAgentAccount({
    account: AGENT_ACCOUNT,
    home: agent.home,
    inHome: [],
    personHome: person.home,
    cronDeny: "/etc/cron.deny",
    systemSshd: systemSshdProblem,
  }).problem();
  if (problem !== null) problems.push(problem);
  if (Bun.which("pkcheck") === null)
    problems.push(
      "polkit is not installed, so your password cannot be asked: sudo apt install polkitd",
    );
  if (Bun.which("gdbus") === null)
    problems.push(
      "gdbus is not installed, so access does not turn off on screen lock or sleep: sudo apt install libglib2.0-bin",
    );
  finish(true, person.name, problems);
}

// remove
const settings = await readOrNull(PATHS.settings);
const made = await readMade();
if (settings === null && made === null) finish(true, null, []);
let personName: string | null = null;
try {
  const named =
    settings === null ? undefined : (JSON.parse(settings) as { person?: unknown }).person;
  if (typeof named === "string") personName = named;
} catch {
  // Unreadable settings: everything else still goes.
}
const problems: string[] = [];
const person = personName === null ? null : account(personName);
// First, while the person's agent still runs: the server it is linked to forgets this computer (only this computer's
// key can ask that), and the agent's record of the link goes, so setting up again links afresh under the same name.
const personData = person === null ? null : join(person.home, ".local/share/omp-app-device");
if (person !== null && existsSync(`/run/user/${person.uid}/omp-app-device/agent.sock`)) {
  const left = run([
    "runuser",
    "-u",
    person.name,
    "--",
    "env",
    `XDG_RUNTIME_DIR=/run/user/${person.uid}`,
    PATHS.program,
    "leave",
  ]);
  const why = left.code === 0 ? "" : left.out;
  changes.push(
    left.code === 0
      ? "told the app's server to forget this computer, and removed the agent's link to it"
      : why === NOT_LINKED
        ? `${NOT_LINKED}: nothing to tell it`
        : `the app's server was not told (${why || "no answer"}): forget this computer in the app's Agent access panel; the agent's link to it was removed`,
  );
} else if (person !== null && personData !== null && existsSync(join(personData, "machine.json"))) {
  // The agent is not running: its record of the link goes all the same (as the person, never root in their home).
  run([
    "runuser",
    "-u",
    person.name,
    "--",
    "rm",
    "-f",
    join(personData, "machine.json"),
    join(personData, "identity.pem"),
  ]);
  changes.push(
    "the agent was not running, so the app's server was not told: forget this computer in the app's Agent access panel; the agent's link to it was removed",
  );
}
// The guard's stop turns access off: every session and process of the account ends, the key and sudo go.
run(["systemctl", "disable", "--now", PATHS.guardUnit]);
changes.push(`stopped and disabled ${PATHS.guardUnit} (access off, every agent session ended)`);
// The person's agent, as the person (never root following links in their home).
if (person !== null) {
  const runtime = `/run/user/${person.uid}`;
  if (existsSync(runtime))
    run([
      "runuser",
      "-u",
      person.name,
      "--",
      "env",
      `XDG_RUNTIME_DIR=${runtime}`,
      "systemctl",
      "--user",
      "disable",
      "--now",
      PATHS.agentUnit,
    ]);
  run([
    "runuser",
    "-u",
    person.name,
    "--",
    "rm",
    "-f",
    join(person.home, ".config/systemd/user/default.target.wants", PATHS.agentUnit),
  ]);
  changes.push(`stopped ${person.name}'s agent (${PATHS.agentUnit}) and removed its start link`);
}
// The agent account, only when it is the one setup made. One that is not keeps its home and its deny lines too, and
// the answer says remove did not finish.
const agent = account(AGENT_ACCOUNT);
const foreign = agent === null ? null : agentAccountProblem(agent, made, uidRange().uidMin);
if (foreign !== null) problems.push(`the account ${AGENT_ACCOUNT} was left alone: ${foreign}`);
else if (agent !== null) {
  for (let round = 0; round < 10; round += 1) {
    if (run(["pkill", "-KILL", "-u", AGENT_ACCOUNT]).code !== 0) break;
    await Bun.sleep(100);
  }
  run(["crontab", "-r", "-u", AGENT_ACCOUNT]);
  run(["loginctl", "disable-linger", AGENT_ACCOUNT]);
  const gone = run(["userdel", "--remove", AGENT_ACCOUNT]);
  if (gone.code !== 0 && account(AGENT_ACCOUNT) !== null)
    fail(`the agent account could not be removed: ${gone.out}`, personName);
  changes.push(
    `removed the account ${AGENT_ACCOUNT} (uid ${agent.uid}), its home ${PATHS.agentHome} and its scheduled jobs`,
  );
}
if (foreign === null)
  for (const kind of ["cron", "at"] as const) {
    const deny = `/etc/${kind}.deny`;
    const text = await readOrNull(deny);
    const next = text === null ? null : withoutAccount(text, AGENT_ACCOUNT);
    if (next === null) continue;
    // A deny file setup created goes when it names no one else; another keeps everyone else's lines.
    if (made?.created?.includes(deny) && next.trim() === "") {
      await rm(deny, { force: true });
      changes.push(`removed ${deny}, which setup had made`);
    } else {
      await writeWhole(deny, next, 0o644);
      changes.push(`took ${AGENT_ACCOUNT}'s line out of ${deny}`);
    }
  }
// What setup made, except the access log and any pending review (state): the record of what agents did, and the
// hold on the next turn-on after a sudo grant, stay until the package is purged. The sudo rule and the shared folders
// always go (the guard unmounted them when it stopped); the account's home only with the account.
for (const path of [
  PATHS.settingsDir,
  PATHS.hostKeyDir,
  PATHS.sudoersDropIn,
  PATHS.sharedFolders,
  ...(foreign === null ? [PATHS.agentHome] : []),
]) {
  // A link in place of one of them is removed itself, never followed.
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    await rm(path, { recursive: true, force: true });
    changes.push(`removed ${path}`);
  }
}
changes.push(
  `kept the access log ${PATHS.logDir} and any pending review in ${PATHS.stateDir} until the package is purged`,
);
run(["systemctl", "daemon-reload"]);
finish(foreign === null, personName, problems);

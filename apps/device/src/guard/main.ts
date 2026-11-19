/**
 * `omp-app-device guard` (#20), run as root by `omp-app-device-guard.service`. Its settings are in a root-owned file,
 * `/etc/omp-app-device/guard.json` (or the path given as its one argument):
 *
 *   { "person": "<the person's account>", "account": "omp-agent", "maxOnMinutes": 120,
 *     "hostKey": "/var/lib/omp-app-device/host_ed25519", "stateDir": "/var/lib/omp-app-device",
 *     "runDir": "/run/omp-app-device", "logFile": "/var/log/omp-app-device/access.log",
 *     "sshd": "/usr/lib/omp-app-device/openssh/sshd", "sshdSession": "...", "sshdAuth": "...",
 *     "sftpServer": "/usr/lib/omp-app-device/openssh/sftp-server",
 *     "wrapper": "/usr/lib/omp-app-device/omp-app-device wrapper" }
 *
 * Turning on asks polkit (action `dev.ompapp.device.turn-on`, `auth_self`, never kept) for the process that asked, which
 * must be the person's.
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { watchLock } from "../agent/lock-watch";
import {
  type AccountFacts,
  agentAccountProblem,
  PATHS,
  personProblem,
  uidRangeOf,
} from "../install/plan";
import { SystemAgentAccount, systemSshdProblem } from "./account";
import { Guard, type GuardAction } from "./guard";
import { SliceLauncher } from "./launcher";
import { HOME_STARTUP_PATHS, persistencePaths } from "./persistence";
import { SudoersFile } from "./sudo";

const Settings = z.strictObject({
  /** The settings' format (setup writes 1; manual installs of before had none). */
  schema: z.literal(1).optional(),
  person: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  /** The person's uid when setup named them: an account renamed or reused since does not become the person. */
  personUid: z.number().int().min(1).optional(),
  account: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  maxOnMinutes: z.number().int().min(1).max(240),
  hostKey: z.string().startsWith("/"),
  stateDir: z.string().startsWith("/"),
  runDir: z.string().startsWith("/"),
  logFile: z.string().startsWith("/"),
  sshd: z.string().startsWith("/"),
  sshdSession: z.string().startsWith("/").optional(),
  sshdAuth: z.string().startsWith("/").optional(),
  sftpServer: z.string().startsWith("/"),
  wrapper: z.string().startsWith("/"),
  /** The agent account's sudo grant: one drop-in, written only while a grant lasts. */
  sudoersDropIn: z
    .string()
    .startsWith("/etc/sudoers.d/")
    .default("/etc/sudoers.d/zz-omp-app-agent"),
});

/** The account's line in the password database: uid, gid, home. */
function account(name: string): { uid: number; gid: number; home: string } {
  const line = Bun.spawnSync(["getent", "passwd", name]).stdout.toString().trim();
  const [, , uid, gid, , home] = line.split(":");
  if (uid === undefined || gid === undefined || home === undefined)
    throw new Error(`no account ${name}`);
  return { uid: Number(uid), gid: Number(gid), home };
}

if (process.getuid?.() !== 0) {
  process.stderr.write("omp-app-device guard runs as root (its service starts it).\n");
  process.exit(1);
}
const raw = JSON.parse(
  readFileSync(process.argv[2] ?? "/etc/omp-app-device/guard.json", "utf8"),
) as Record<string, unknown>;
if (typeof raw.schema === "number" && raw.schema > 1) {
  process.stderr.write(
    "these settings are newer than this program: run omp-app-device setup again\n",
  );
  process.exit(1);
}
const settings = Settings.parse(raw);
const person = account(settings.person);
if (settings.personUid !== undefined && person.uid !== settings.personUid) {
  process.stderr.write(
    `the person's account ${settings.person} is not the one setup named: run omp-app-device setup again\n`,
  );
  process.exit(1);
}
const agent = account(settings.account);

/** An account as the system describes it now, its groups included; null when there is none. */
function facts(name: string): AccountFacts | null {
  const line = Bun.spawnSync(["getent", "passwd", name]).stdout.toString().split("\n")[0] ?? "";
  const [found, , uid, , , home, shell] = line.split(":");
  if (found === undefined || found === "" || uid === undefined || home === undefined) return null;
  const groups = Bun.spawnSync(["id", "-Gn", found]).stdout.toString().split(/\s+/).filter(Boolean);
  return { name: found, uid: Number(uid), home, shell: shell ?? "", groups };
}

/**
 * Checked at every turn-on of a computer setup made (settings `schema` 1): the agent account is still the one setup
 * made (no group added since, a system account, its home) and the person still an administrator, as setup checked.
 */
async function accountsProblem(): Promise<string | null> {
  const range = uidRangeOf(await readFile("/etc/login.defs", "utf8").catch(() => ""));
  const agentNow = facts(settings.account);
  if (agentNow === null) return `there is no account ${settings.account}`;
  let made: { uid?: number } | null = null;
  try {
    made = JSON.parse(await readFile(PATHS.made, "utf8")) as { uid?: number };
  } catch {
    // No record of what setup made: the account cannot be shown to be its.
  }
  const agentProblem = agentAccountProblem(agentNow, made, range.uidMin);
  if (agentProblem !== null) return agentProblem;
  const personNow = facts(settings.person);
  if (personNow === null) return `there is no account ${settings.person}`;
  const shells = (await readFile("/etc/shells", "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim());
  const homeOwner = (await stat(personNow.home).catch(() => null))?.uid ?? null;
  return personProblem(personNow, { ...range, shells, homeOwner });
}

const log = (line: string) => {
  appendFileSync(settings.logFile, `${line}\n`, { mode: 0o640 });
  Bun.spawn(["logger", "-t", "omp-app-device", line], { stdout: "ignore", stderr: "ignore" });
};

/**
 * The password, asked by polkit for the process that asked, which must be one of the person's. polkit is given the
 * process's start time and uid with its pid (`pid,pid-start-time,uid`, as pkcheck(1) requires of new code): a pid that
 * ended and was reused by another process does not match.
 */
const verify = async (pid: number, action: GuardAction, message: string): Promise<boolean> => {
  let subject: string;
  try {
    const uid = statSync(`/proc/${pid}`).uid;
    if (uid !== person.uid) return false;
    // proc(5): the 22nd field, counted after the command name in parentheses (which may hold spaces).
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (startTime === undefined || !/^\d+$/.test(startTime)) return false;
    subject = `${pid},${startTime},${uid}`;
  } catch {
    return false;
  }
  // Without polkit nothing can ask the password, so the answer is no (said in the log, not as a crash of the guard).
  const pkcheck = Bun.which("pkcheck");
  if (pkcheck === null) {
    log(
      JSON.stringify({ type: "refused", reason: "polkit is not installed (apt install polkitd)" }),
    );
    return false;
  }
  const check = Bun.spawn(
    [
      pkcheck,
      "--action-id",
      `dev.ompapp.device.${action}`,
      "--process",
      subject,
      "--allow-user-interaction",
      // What the dialog says: the guard's own words, with the length it will grant (the `polkit.message` detail of
      // the org.freedesktop.PolicyKit1.Authority documentation).
      "--detail",
      "polkit.message",
      message,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await check.exited) === 0;
};

/**
 * logind's delay lock on sleep, held while access is on: `systemd-inhibit --mode=delay` takes it and keeps it while its
 * command waits; killing it releases it (its command dies with it). Without systemd-inhibit nothing holds the sleep
 * back, and off on sleep is only as quick as the signal.
 */
function holdSleep(): () => void {
  const inhibit = Bun.which("systemd-inhibit");
  const sleep = Bun.which("sleep");
  if (inhibit === null || sleep === null) return () => undefined;
  const holder = Bun.spawn(
    [
      inhibit,
      "--what=sleep",
      "--mode=delay",
      "--who=omp-app agent access",
      "--why=Agent access turns off before this computer sleeps",
      sleep,
      "infinity",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  return () => holder.kill();
}

const guard = new Guard({
  runDir: settings.runDir,
  account: settings.account,
  hostKey: settings.hostKey,
  wrapper: settings.wrapper,
  sftpServer: settings.sftpServer,
  ...(settings.sshdSession === undefined ? {} : { sshdSession: settings.sshdSession }),
  ...(settings.sshdAuth === undefined ? {} : { sshdAuth: settings.sshdAuth }),
  launcher: new SliceLauncher([settings.sshd], settings.account),
  verify,
  maxOnMs: settings.maxOnMinutes * 60_000,
  log,
  stateDir: settings.stateDir,
  watchPaths: persistencePaths(settings.account, agent.home),
  agentAccount: new SystemAgentAccount({
    account: settings.account,
    home: agent.home,
    inHome: HOME_STARTUP_PATHS,
    personHome: person.home,
    cronDeny: "/etc/cron.deny",
    systemSshd: systemSshdProblem,
    ...(settings.schema === 1 ? { accounts: accountsProblem } : {}),
  }),
  sudo: new SudoersFile(settings.sudoersDropIn),
  holdSleep,
});
await guard.start({ person: { uid: person.uid, gid: person.gid }, agentGid: agent.gid });
log(JSON.stringify({ type: "started" }));
// "About to sleep" turns access off here, as root, while the delay lock holds the sleep back: the person's agent may be
// frozen with the user sessions before it could ask (it still turns off on a screen lock).
const stopSleepWatch = watchLock(
  (event) => {
    if (event !== "sleeping" || !guard.state().on) return;
    log(JSON.stringify({ type: "sleep", note: "access turns off before this computer sleeps" }));
    void guard.off();
  },
  (line) => log(JSON.stringify({ type: "note", note: line })),
);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopSleepWatch();
    void guard.stop().finally(() => process.exit(0));
  });
}

/**
 * The agent account between accesses (#20): nothing it left may outlive access. At the guard's start, at every
 * turn-on and at every off the guard ends every process of the account (also those outside the session slice: a cron or
 * `at` job), then removes what could start something later or skip the session wrapper: the shell startup files, the
 * ssh folder, autostart entries, user systemd units, the crontab, `at` jobs and the linger flag, and everything the
 * account owns in the shared temporary folders (`/tmp`, `/var/tmp`, `/dev/shm`, `/dev/mqueue`). The agent's work
 * files in its home stay. The account's shell must read no startup files when sshd runs the wrapper through it
 * (`$SHELL -c`): Debian's and Ubuntu's bash read `~/.bashrc` even then (`SSH_SOURCE_BASHRC`), so the shell is dash
 * (`/bin/sh`).
 */
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

export interface AgentAccount {
  /** Why sessions may not start as this account, or null. */
  problem(): Promise<string | null>;
  /** Ends every process of the account and removes what it left; returns the paths removed. */
  reset(): Promise<string[]>;
}

/** Runs a program as root; its exit code (127 when it cannot start). */
export type Run = (argv: readonly string[]) => Promise<number>;

const runReal: Run = async (argv) => {
  try {
    return await Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      .exited;
  } catch {
    return 127;
  }
};

/** What `atq` prints for one job (`<id>\t<date> <queue> <user>`): its id when it is the account's. */
function atJobOf(line: string, account: string): string | null {
  const fields = line.trim().split(/\s+/);
  return fields.length >= 2 && fields.at(-1) === account && /^\d+$/.test(fields[0] ?? "")
    ? (fields[0] ?? null)
    : null;
}

/** Folders every account can write to, which outlive a session (and `/var/tmp` a reboot). */
export const SHARED_TEMP_FOLDERS: readonly string[] = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  "/dev/mqueue",
];

/**
 * Why the computer's own ssh server, when it runs, would let `account` log in past the guard (a key a session leaves
 * in `~/.ssh` would work there, unrecorded): null when it does not run or refuses the account. Read from `sshd -T`,
 * as root; when that cannot be read, the answer is a problem too.
 */
export async function systemSshdProblem(account: string): Promise<string | null> {
  const active = (unit: string) =>
    Bun.spawnSync(["systemctl", "is-active", "--quiet", unit]).exitCode === 0;
  if (!active("ssh.service") && !active("ssh.socket")) return null;
  const sshd = Bun.which("sshd", { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
  const effective =
    sshd === null
      ? null
      : Bun.spawnSync([sshd, "-T", "-C", `user=${account},host=localhost,addr=127.0.0.1`]);
  if (effective === null || effective.exitCode !== 0)
    return `this computer's own ssh server is running and its settings could not be read: stop it (sudo systemctl disable --now ssh.socket ssh.service), or refuse ${account} there`;
  if (!sshdAllows(effective.stdout.toString(), account)) return null;
  return `this computer's own ssh server is running and lets ${account} log in past the guard: refuse it there (echo "DenyUsers ${account}" | sudo tee /etc/ssh/sshd_config.d/omp-agent-deny.conf && sudo systemctl reload ssh), or stop it (sudo systemctl disable --now ssh.socket ssh.service)`;
}

/** Whether settings printed by `sshd -T` let `account` log in (by DenyUsers and AllowUsers; sshd's own order). */
export function sshdAllows(effective: string, account: string): boolean {
  const words = (key: string) =>
    effective
      .match(new RegExp(`^${key} (.*)$`, "m"))?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const allow = words("allowusers");
  return !words("denyusers").includes(account) && (allow.length === 0 || allow.includes(account));
}

export class SystemAgentAccount implements AgentAccount {
  readonly #account: string;
  readonly #home: string;
  /** Paths in the home to remove (startup files, folders), relative to it. */
  readonly #inHome: readonly string[];
  readonly #run: Run;
  readonly #passwd: string;
  readonly #tempFolders: readonly string[];
  readonly #personHome: string | undefined;
  readonly #cronDeny: string | undefined;
  readonly #systemSshd: ((account: string) => Promise<string | null>) | undefined;
  readonly #accounts: (() => Promise<string | null>) | undefined;

  constructor(options: {
    readonly account: string;
    readonly home: string;
    readonly inHome: readonly string[];
    readonly run?: Run;
    readonly passwd?: string;
    /** Where the account's leftovers are removed besides its home (tests point it at a folder of their own). */
    readonly tempFolders?: readonly string[];
    /** Checked before each turn-on when given: the person's home, closed to other accounts. */
    readonly personHome?: string;
    /** Checked before each turn-on when given (and cron is installed): it names the account. */
    readonly cronDeny?: string;
    /** Checked before each turn-on when given: the computer's own ssh server refuses the account. */
    readonly systemSshd?: (account: string) => Promise<string | null>;
    /** Checked before each turn-on when given: the agent account and the person are still as setup checked them. */
    readonly accounts?: () => Promise<string | null>;
  }) {
    this.#account = options.account;
    this.#home = options.home;
    this.#inHome = options.inHome;
    this.#run = options.run ?? runReal;
    this.#passwd = options.passwd ?? "/etc/passwd";
    this.#tempFolders = options.tempFolders ?? SHARED_TEMP_FOLDERS;
    this.#personHome = options.personHome;
    this.#cronDeny = options.cronDeny;
    this.#systemSshd = options.systemSshd;
    this.#accounts = options.accounts;
  }

  async problem(): Promise<string | null> {
    const entry = (await readFile(this.#passwd, "utf8"))
      .split("\n")
      .find((line) => line.startsWith(`${this.#account}:`));
    const shell = entry?.split(":")[6]?.trim();
    if (shell === undefined) return `there is no account ${this.#account}`;
    const real = await realpath(shell).catch(() => shell);
    if (basename(real) !== "dash")
      return `the ${this.#account} account's shell must be /bin/sh (dash), which reads no startup files: run sudo usermod --shell /bin/sh ${this.#account}`;
    const accounts = await this.#accounts?.();
    if (accounts !== undefined && accounts !== null) return accounts;
    if (this.#personHome !== undefined) {
      const mode = (await stat(this.#personHome)).mode;
      if ((mode & 0o007) !== 0)
        return `your home folder (${this.#personHome}) can be opened by other accounts, ${this.#account} too: run chmod 750 ${this.#personHome}`;
    }
    if (this.#cronDeny !== undefined && Bun.which("crontab") !== null) {
      const listed = async (path: string) =>
        (await readFile(path, "utf8").catch(() => null))
          ?.split("\n")
          .some((line) => line.trim() === this.#account) ?? null;
      // With cron.allow, only those it lists may use cron; without it, cron.deny must name the account.
      const allowed = await listed(this.#cronDeny.replace(/\.deny$/, ".allow"));
      const denied = allowed === null ? await listed(this.#cronDeny) : !allowed;
      if (denied !== true)
        return `${this.#account} may schedule jobs with cron: run echo ${this.#account} | sudo tee -a ${this.#cronDeny}`;
    }
    return (await this.#systemSshd?.(this.#account)) ?? null;
  }

  async reset(): Promise<string[]> {
    await this.#endProcesses();
    const removed: string[] = [];
    for (const path of this.#inHome) {
      const gone = await this.#remove(path);
      if (gone !== null) removed.push(gone);
    }
    // The shared temporary folders (`/var/tmp` outlives a reboot): every entry of the account, links not followed.
    for (const folder of this.#tempFolders) {
      const found = await this.#run([
        "sh",
        "-c",
        'find "$1" -xdev -user "$2" -print -quit 2>/dev/null | grep -q .',
        "sh",
        folder,
        this.#account,
      ]);
      if (found !== 0) continue;
      await this.#run(["find", folder, "-xdev", "-user", this.#account, "-delete"]);
      removed.push(`files of ${this.#account} in ${folder}`);
    }
    if ((await this.#run(["crontab", "-r", "-u", this.#account])) === 0)
      removed.push(`the crontab of ${this.#account}`);
    for (const job of await this.#atJobs()) {
      if ((await this.#run(["atrm", job])) === 0) removed.push(`at job ${job}`);
    }
    await this.#run(["loginctl", "disable-linger", this.#account]);
    return removed;
  }

  /** Every process of the account, also one that forks while it is being killed. */
  async #endProcesses(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await this.#run(["pkill", "-KILL", "-u", this.#account]);
      // pgrep's 1: none left.
      if ((await this.#run(["pgrep", "-u", this.#account])) === 1) return;
      await Bun.sleep(50);
    }
  }

  async #atJobs(): Promise<string[]> {
    try {
      const atq = Bun.spawn(["atq"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const text = await new Response(atq.stdout).text();
      await atq.exited;
      return text
        .split("\n")
        .map((line) => atJobOf(line, this.#account))
        .filter((job): job is string => job !== null);
    } catch {
      return [];
    }
  }

  /**
   * Removes `relativePath` under the home without following a link the account made: walking down from the home, a
   * link on the way is removed itself (it is the account's own entry), and nothing outside the home is reached.
   */
  async #remove(relativePath: string): Promise<string | null> {
    const parts = relativePath.split(sep).filter((part) => part !== "" && part !== ".");
    if (parts.length === 0 || parts.includes("..")) return null;
    let at = this.#home;
    for (const [index, part] of parts.entries()) {
      at = join(at, part);
      const info = await lstat(at).catch(() => null);
      if (info === null) return null;
      const last = index === parts.length - 1;
      if (info.isSymbolicLink() || last) {
        await rm(at, { recursive: true, force: true });
        return `~/${relative(this.#home, at)}`;
      }
      if (!info.isDirectory()) return null;
    }
    return null;
  }
}

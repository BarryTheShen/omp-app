/**
 * What `omp-app-device setup` and `remove` decide (#20), apart from doing it: who the person may be, whether an
 * existing agent account is setup's own, the guard's settings, and the deny files. Kept free of the system so it can be
 * tested as is.
 */

/** Where the package puts agent access, and where setup writes. */
export const PATHS = {
  program: "/usr/lib/omp-app-device/omp-app-device",
  openssh: "/usr/lib/omp-app-device/openssh",
  settingsDir: "/etc/omp-app-device",
  settings: "/etc/omp-app-device/guard.json",
  /** What setup made (the account's uid, deny files it created): remove and a second setup act only on these. */
  made: "/etc/omp-app-device/made.json",
  hostKeyDir: "/etc/omp-app-device-host",
  hostKey: "/etc/omp-app-device-host/host_ed25519",
  stateDir: "/var/lib/omp-app-device",
  logDir: "/var/log/omp-app-device",
  logrotate: "/etc/logrotate.d/omp-app-device",
  agentHome: "/var/lib/omp-agent",
  sudoersDropIn: "/etc/sudoers.d/zz-omp-app-agent",
  lock: "/run/omp-app-device-setup.lock",
  guardUnit: "omp-app-device-guard.service",
  agentUnit: "omp-app-device.service",
} as const;

export const AGENT_ACCOUNT = "omp-agent";

/** The guard settings' format: a guard refuses a newer one ("run setup again"). */
export const SETTINGS_SCHEMA = 1;

/**
 * The account that asked, as `pkexec` (PKEXEC_UID) or `sudo` (SUDO_UID) tells it; both set it themselves and clear
 * what the caller passed. Root is never the person: agents would then work for root.
 */
export function invokerUid(env: Record<string, string | undefined>): number | string {
  const { PKEXEC_UID: pkexec, SUDO_UID: sudo } = env;
  if (pkexec !== undefined && sudo !== undefined && pkexec !== sudo)
    return "pkexec and sudo name different accounts: run it one way only";
  const raw = pkexec ?? sudo;
  if (raw === undefined)
    return "run it as the person who will turn access on: from the desktop app's Agent access panel, or with sudo";
  if (!/^\d+$/.test(raw)) return "the account that asked could not be read";
  const uid = Number(raw);
  if (uid === 0)
    return "the person who turns access on cannot be root: run it with sudo from your own account";
  return uid;
}

/** An account as the system describes it. */
export interface AccountFacts {
  readonly name: string;
  readonly uid: number;
  readonly home: string;
  readonly shell: string;
  /** The groups it belongs to, its primary one included. */
  readonly groups: readonly string[];
}

/** Groups whose members polkit takes as administrators on Ubuntu (49-ubuntu-admin.rules: sudo and admin). */
export const ADMIN_GROUPS: readonly string[] = ["sudo", "admin"];

/**
 * Why this account may not be the person: a turn-on with its own password may lead to a sudo grant (root for the agent
 * account), so it must be a real login account of an administrator of this computer.
 */
export function personProblem(
  person: AccountFacts,
  facts: {
    readonly uidMin: number;
    readonly uidMax: number;
    readonly shells: readonly string[];
    /** The uid owning the person's home, or null when it does not exist. */
    readonly homeOwner: number | null;
  },
): string | null {
  if (person.name === AGENT_ACCOUNT) return `${AGENT_ACCOUNT} cannot be the person`;
  if (person.uid < facts.uidMin || person.uid > facts.uidMax)
    return `${person.name} is not a login account of a person (uid ${person.uid})`;
  if (!facts.shells.includes(person.shell))
    return `${person.name} has no login shell (${person.shell})`;
  if (facts.homeOwner !== person.uid)
    return `${person.name}'s home folder ${person.home} is not theirs`;
  if (!person.groups.some((group) => ADMIN_GROUPS.includes(group)))
    return `${person.name} is not an administrator of this computer: agent access lets its person allow sudo, so only an administrator may be it`;
  return null;
}

/** login.defs' range of people's uids, from its text (Debian's defaults when unset). */
export function uidRangeOf(loginDefs: string): { uidMin: number; uidMax: number } {
  const value = (key: string, fallback: number) =>
    Number(loginDefs.match(new RegExp(`^\\s*${key}\\s+(\\d+)`, "m"))?.[1] ?? fallback);
  return { uidMin: value("UID_MIN", 1000), uidMax: value("UID_MAX", 60000) };
}

/**
 * Whether an existing agent account is the one setup made: its uid as recorded, a system account, the home setup gave
 * it and no group but its own. Anything else is someone's account and is left alone.
 */
export function agentAccountProblem(
  agent: AccountFacts,
  made: { readonly uid?: number } | null,
  uidMin: number,
): string | null {
  const notOurs = `an account named ${AGENT_ACCOUNT} exists that agent access did not make`;
  if (made?.uid !== agent.uid) return `${notOurs}: rename or remove it first`;
  if (agent.uid >= uidMin || agent.home !== PATHS.agentHome)
    return `${notOurs} as a system account with home ${PATHS.agentHome}: rename or remove it first`;
  const others = agent.groups.filter((group) => group !== AGENT_ACCOUNT);
  if (others.length > 0)
    return `${AGENT_ACCOUNT} is in other groups (${others.join(", ")}), which would give agents their rights: remove it from them`;
  return null;
}

/** The computer is set up for one person (by uid); unreadable settings belong to someone unknown. */
export function otherPerson(settingsText: string | null, uid: number): string | null {
  if (settingsText === null) return null;
  try {
    const was = JSON.parse(settingsText) as { person?: unknown; personUid?: unknown };
    if (typeof was.person !== "string" || typeof was.personUid !== "number")
      return "an account its settings do not name";
    return was.personUid === uid ? null : was.person;
  } catch {
    return "an account its settings do not name";
  }
}

/** The guard's settings: the bundled OpenSSH programs (OpenSSH 10 splits sshd into sshd-session and sshd-auth). */
export function guardSettings(
  person: string,
  personUid: number,
  split: boolean,
): Record<string, unknown> {
  const openssh = PATHS.openssh;
  return {
    schema: SETTINGS_SCHEMA,
    person,
    personUid,
    account: AGENT_ACCOUNT,
    hostKey: PATHS.hostKey,
    stateDir: PATHS.stateDir,
    runDir: "/run/omp-app-device",
    logFile: `${PATHS.logDir}/access.log`,
    sshd: `${openssh}/usr/sbin/sshd`,
    ...(split
      ? {
          sshdSession: `${openssh}/usr/lib/openssh/sshd-session`,
          sshdAuth: `${openssh}/usr/lib/openssh/sshd-auth`,
        }
      : {}),
    sftpServer: `${openssh}/usr/lib/openssh/sftp-server`,
    wrapper: `${PATHS.program} wrapper`,
    sudoersDropIn: PATHS.sudoersDropIn,
  };
}

/**
 * What to do with a deny file so the agent account cannot schedule jobs, keeping what the computer allows others:
 * an allow file already keeps the account out (it is never listed); an existing deny file gains the account; with
 * neither, cron lets everyone (so a deny file naming only the account is created) and at lets only root (nothing to do).
 */
export function denyAction(
  kind: "cron" | "at",
  files: { readonly allowExists: boolean; readonly denyExists: boolean },
): "append" | "create" | "nothing" {
  if (files.allowExists) return "nothing";
  if (files.denyExists) return "append";
  return kind === "cron" ? "create" : "nothing";
}

/** A deny file's text with the account in it once (null: it is there already). */
export function withAccount(text: string, account: string): string | null {
  const lines = text.split("\n");
  if (lines.some((line) => line.trim() === account)) return null;
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${body}${account}\n`;
}

/** A deny file's text without the account (null: it was not there). */
export function withoutAccount(text: string, account: string): string | null {
  const lines = text.split("\n");
  if (!lines.some((line) => line.trim() === account)) return null;
  return lines.filter((line) => line.trim() !== account).join("\n");
}

/**
 * The sshd config for one session (#20): written by the guard for each stream, read by an `sshd -i` that serves that
 * stream only. Everything a session may not do is said here, not left to sshd's defaults: one key (the turn-on's), the
 * agent account only, no forwarding of any kind, no user rc or environment, and every session through the wrapper.
 */

export interface SessionConfig {
  /** The account sessions log in as (`omp-agent`). */
  readonly account: string;
  readonly hostKey: string;
  readonly authorizedKeys: string;
  /** The wrapper sshd forces every session through (absolute path, maybe with arguments). */
  readonly wrapper: string;
  readonly sftpServer: string;
  /** The stream this sshd serves: the wrapper tags its records with it. */
  readonly stream: number;
  /** The guard's socket the wrapper sends records to. */
  readonly recordsSocket: string;
  /** OpenSSH 10's helpers, when sshd is not the system's (`/usr/lib/openssh/`). */
  readonly sshdSession?: string;
  readonly sshdAuth?: string;
  /** Where sshd writes its own log. */
  readonly logFile?: string;
}

/** The settings every session's config must have, as `sshd -T` prints them (lowercase names). */
export const REQUIRED_SETTINGS: Readonly<Record<string, string>> = {
  pubkeyauthentication: "yes",
  passwordauthentication: "no",
  kbdinteractiveauthentication: "no",
  authenticationmethods: "publickey",
  permitrootlogin: "no",
  permituserrc: "no",
  permituserenvironment: "no",
  permittunnel: "no",
  allowtcpforwarding: "no",
  allowstreamlocalforwarding: "no",
  allowagentforwarding: "no",
  x11forwarding: "no",
  gatewayports: "no",
  permitlisten: "none",
  permitopen: "none",
  strictmodes: "yes",
  usepam: "no",
  logingracetime: "10",
  maxauthtries: "2",
};

/** Quotes a path for sshd's config: in double quotes, nothing that would end them. */
function quoted(path: string): string {
  if (/["\n\r]/.test(path)) throw new Error(`not a path sshd can take: ${path}`);
  return `"${path}"`;
}

export function sessionConfig(config: SessionConfig): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.account)) throw new Error("not an account name");
  if (!Number.isInteger(config.stream) || config.stream < 1) throw new Error("not a stream");
  const lines = [
    "# Written by omp-app-device-guard for one session; changes here are replaced.",
    `HostKey ${quoted(config.hostKey)}`,
    `AuthorizedKeysFile ${quoted(config.authorizedKeys)}`,
    `AllowUsers ${config.account}`,
    "AuthenticationMethods publickey",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
    "PermitUserRC no",
    "PermitUserEnvironment no",
    "PermitTunnel no",
    "AllowTcpForwarding no",
    "AllowStreamLocalForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "GatewayPorts no",
    "PermitListen none",
    "PermitOpen none",
    "PermitTTY yes",
    "StrictModes yes",
    "UsePAM no",
    "PidFile none",
    // One key, offered at once: a session that does not authenticate soon, or tries more, is ended.
    "LoginGraceTime 10",
    "MaxAuthTries 2",
    "LogLevel VERBOSE",
    `SetEnv ${quoted(`OMP_ACCESS_STREAM=${config.stream}`)} ${quoted(`OMP_ACCESS_RECORDS=${config.recordsSocket}`)} ${quoted(`OMP_ACCESS_SFTP_SERVER=${config.sftpServer}`)}`,
    `Subsystem sftp ${quoted(config.sftpServer)} -l INFO`,
    `ForceCommand ${config.wrapper}`,
  ];
  if (config.sshdSession !== undefined) lines.push(`SshdSessionPath ${quoted(config.sshdSession)}`);
  if (config.sshdAuth !== undefined) lines.push(`SshdAuthPath ${quoted(config.sshdAuth)}`);
  return `${lines.join("\n")}\n`;
}

/** The `authorized_keys` line for a turn-on's key: that key only, no forwarding, a terminal allowed. */
export function authorizedKeyLine(publicKey: string): string {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(publicKey))
    throw new Error("not an Ed25519 public key");
  return `restrict,pty ${publicKey}\n`;
}

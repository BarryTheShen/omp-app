/**
 * The files the agents' `ssh` reads to reach a machine (#20), all in one owner-only folder:
 * - `ssh_config`: a `Host <alias>` block per enrolled machine, its ProxyCommand the server's `device-ssh`, its host key
 *   pinned in `known_hosts` under the alias, its key the turn-on's session key. A person's `~/.ssh/config` takes it with
 *   one `Include` line.
 * - `known_hosts`: each machine's sshd host key, under its alias only.
 * - `keys/<alias>`: the session key while the machine is on; removed when it turns off or its link ends.
 * Aliases are checked by the contract (letters, digits and dashes), so nothing in a block reads as a pattern or option.
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AccessAlias } from "@omp-app/contracts";

export interface SshFilesMachine {
  readonly alias: string;
  readonly hostKey: string;
}

export class SshFiles {
  readonly folder: string;
  readonly #proxyCommand: readonly string[];
  /** The account the sessions log in as on each machine. */
  readonly #user: string;

  /** `proxyCommand`: the program and its arguments before the alias, e.g. `["/usr/bin/omp-app", "device-ssh"]`. */
  constructor(folder: string, proxyCommand: readonly string[], user = "omp-agent") {
    this.folder = folder;
    this.#proxyCommand = proxyCommand;
    this.#user = user;
  }

  get configPath(): string {
    return join(this.folder, "ssh_config");
  }

  keyPath(alias: string): string {
    return join(this.folder, "keys", AccessAlias.parse(alias));
  }

  /** Writes the config and the pinned host keys for these machines. */
  async write(machines: readonly SshFilesMachine[]): Promise<void> {
    await mkdir(join(this.folder, "keys"), { recursive: true, mode: 0o700 });
    await chmod(this.folder, 0o700);
    const quote = (word: string) => `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const proxy = [...this.#proxyCommand.map(quote), "%n"].join(" ");
    const blocks = machines.map((machine) => {
      const alias = AccessAlias.parse(machine.alias);
      return [
        `Host ${alias}`,
        `  HostName ${alias}`,
        `  HostKeyAlias omp-access-${alias}`,
        `  User ${this.#user}`,
        `  ProxyCommand ${proxy}`,
        `  IdentityFile ${quote(this.keyPath(alias))}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${quote(join(this.folder, "known_hosts"))}`,
        "  StrictHostKeyChecking yes",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  ClearAllForwardings yes",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "",
      ].join("\n");
    });
    const header = "# Written by omp-app (agent access); changes here are replaced.\n\n";
    await writeFile(this.configPath, header + blocks.join("\n"), { mode: 0o600 });
    const hosts = machines
      .map((machine) => `omp-access-${AccessAlias.parse(machine.alias)} ${machine.hostKey}`)
      .join("\n");
    await writeFile(join(this.folder, "known_hosts"), hosts === "" ? "" : `${hosts}\n`, {
      mode: 0o600,
    });
  }

  /** The session key of a machine that turned on; null removes it. */
  async setKey(alias: string, key: string | null): Promise<void> {
    const path = this.keyPath(alias);
    if (key === null) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(join(this.folder, "keys"), { recursive: true, mode: 0o700 });
    await writeFile(path, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

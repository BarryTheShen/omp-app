/**
 * A sudo grant for the agent account (#20): one sudoers drop-in, written only by the guard (root), checked with
 * `visudo -c -f` before it is moved into place, removed when the grant ends, when access turns off, and when the guard
 * starts (so a reboot or a crash never leaves it). It names the agent account only: the person's own processes never
 * get passwordless sudo from it. sudo-rs (Ubuntu's sudo since 25.10) reads the same drop-ins and its visudo checks them.
 */
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SudoGrants {
  /** Grants the account passwordless sudo; returns why not, or null. */
  grant(account: string): Promise<string | null>;
  /** Removes any grant (nothing to remove is fine). */
  revoke(): Promise<void>;
}

export class SudoersFile implements SudoGrants {
  readonly #path: string;
  readonly #visudo: string;

  /** `path`: the drop-in, e.g. `/etc/sudoers.d/zz-omp-app-agent`. */
  constructor(path: string, visudo = "visudo") {
    this.#path = path;
    this.#visudo = visudo;
  }

  async grant(account: string): Promise<string | null> {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(account)) return "not an account name";
    // Written beside the drop-in under a name sudo skips (it has a dot), checked, then moved over it in one step.
    const pending = join(dirname(this.#path), `.omp-app-agent.${process.pid}.pending`);
    await writeFile(pending, `${account} ALL=(ALL:ALL) NOPASSWD: ALL\n`, { mode: 0o440 });
    await chmod(pending, 0o440);
    const check = Bun.spawnSync([this.#visudo, "-c", "-f", pending], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (check.exitCode !== 0) {
      await rm(pending, { force: true });
      return `the sudo rule did not check out: ${check.stderr.toString().trim() || check.stdout.toString().trim()}`;
    }
    await rename(pending, this.#path);
    return null;
  }

  async revoke(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}

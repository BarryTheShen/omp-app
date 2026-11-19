/**
 * How the guard starts a session's `sshd -i` (#20):
 * - `SliceLauncher` (as root): `systemd-run` starts it as the agent account in the `omp-agent-access.slice`, so stopping
 *   the slice ends every session and anything a session started inside it.
 * - `ChildLauncher` (tests, one account): a plain child process of the guard, ended by killing it.
 */
import { readdir, readFile } from "node:fs/promises";
import type { SessionLauncher } from "./guard";

type Started = ReturnType<SessionLauncher["start"]>;

function wrap(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Started {
  return {
    stdin: { write: (bytes) => proc.stdin.write(bytes), end: () => void proc.stdin.end() },
    stdout: proc.stdout,
    exited: proc.exited,
    kill: () => proc.kill("SIGKILL"),
  };
}

export class SliceLauncher implements SessionLauncher {
  readonly #sshd: readonly string[];
  readonly #account: string;
  readonly #slice: string;

  /** `sshd`: the program and anything before `-i` (e.g. `["/usr/lib/omp-app-device/openssh/sshd"]`). */
  constructor(sshd: readonly string[], account: string, slice = "omp-agent-access.slice") {
    this.#sshd = sshd;
    this.#account = account;
    this.#slice = slice;
  }

  start(configPath: string): Started {
    return wrap(
      Bun.spawn(
        [
          "systemd-run",
          "--quiet",
          "--collect",
          "--pipe",
          "--wait",
          `--slice=${this.#slice}`,
          `--uid=${this.#account}`,
          "--property=KillMode=control-group",
          "--",
          ...this.#sshd,
          "-i",
          "-f",
          configPath,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      ),
    );
  }

  /** Every process in the slice gets SIGKILL at once (one that ignores SIGTERM may not wait out a stop), then the stop. */
  async stopAll(): Promise<void> {
    const run = (argv: string[]) =>
      Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited.catch(() => 127);
    await run(["systemctl", "kill", "--signal=SIGKILL", "--kill-whom=all", this.#slice]);
    await run(["systemctl", "stop", this.#slice]);
  }

  /**
   * Sessions run as the agent account: a process in the slice running as root (real or effective uid 0) came from a
   * sudo grant. Each gets SIGKILL, a few rounds over, as one may fork while it is killed.
   */
  async endRoot(): Promise<number> {
    let ended = 0;
    for (let round = 0; round < 5; round += 1) {
      const found = await rootInSlice(this.#slice);
      if (found.length === 0) break;
      for (const pid of found) {
        try {
          process.kill(pid, "SIGKILL");
          ended += 1;
        } catch {
          // Already gone.
        }
      }
      await Bun.sleep(50);
    }
    return ended;
  }
}

export class ChildLauncher implements SessionLauncher {
  readonly #sshd: readonly string[];
  readonly #env: Record<string, string | undefined>;
  readonly #children = new Set<Bun.Subprocess<"pipe", "pipe", "ignore">>();

  constructor(sshd: readonly string[], env: Record<string, string | undefined> = process.env) {
    this.#sshd = sshd;
    this.#env = env;
  }

  /** Each session's sshd leads a process group of its own (`setsid`), so ending it ends what the session started. */
  start(configPath: string): Started {
    const proc = Bun.spawn(["setsid", ...this.#sshd, "-i", "-f", configPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: this.#env,
    });
    this.#children.add(proc);
    void proc.exited.finally(() => this.#children.delete(proc));
    return { ...wrap(proc), kill: () => killGroup(proc) };
  }

  async stopAll(): Promise<void> {
    for (const child of this.#children) killGroup(child);
    await Promise.all([...this.#children].map((child) => child.exited));
  }

  /** One account, no root: nothing to end. */
  async endRoot(): Promise<number> {
    return 0;
  }
}

/** Processes in `slice` (by their cgroup) whose real or effective uid is root. */
async function rootInSlice(slice: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cgroup = await readFile(`/proc/${entry}/cgroup`, "utf8");
      if (!cgroup.includes(`/${slice}/`)) continue;
      const uids = (await readFile(`/proc/${entry}/status`, "utf8")).match(
        /^Uid:\s+(\d+)\s+(\d+)/m,
      );
      if (uids?.[1] === "0" || uids?.[2] === "0") found.push(Number(entry));
    } catch {
      // Gone while read.
    }
  }
  return found;
}

function killGroup(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

/**
 * omp-app updating itself (Settings → App → omp-app): looks for the newest release on GitHub, and installs one (a newer
 * release, or the one before for Go back) on the server's own computer. The package is downloaded into the app's data
 * folder and checked against the release's checksums; the install and the restart run in a unit of their own outside
 * the server's service (`systemd-run --user`), since restarting the service ends every process in it. That needs the
 * installed package running as the `omp-app` user service, and `sudo` without a password; elsewhere the reason and the
 * command to run instead. A release carries the omp it pins, so nothing installs while omp's update job has an omp
 * waiting to be switched to: that move goes only through the job's switch.
 *
 * Files in `<app data>/updates`: `v<version>/` (a downloaded package and the release's `SHA256SUMS`; this release's and
 * the one before are kept), `last.json` (`{ version: 1, from, to, at }`, written before an install: after it, the new
 * server shows it and Go back installs `from`), `failed.json` (`{ version: 1, to }`, written by the install unit when
 * apt fails) and `install-<version>.log` (that unit's output).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_RELEASES, AppFailure, type AppUpdates, AppVersion } from "@omp-app/contracts";
import { z } from "zod";

const LATEST = "https://api.github.com/repos/BarryTheShen/omp-app/releases/latest";
/** A look for the newest release older than this is made again when Settings asks. */
const CHECK_EVERY_MS = 60 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** The installed app's user service: the unit whose restart moves the server to the new release. */
const SERVICE = "omp-app.service";

export interface RunResult {
  readonly code: number;
  readonly output: string;
}

export interface AppUpdaterOptions {
  /** `<app data>/updates`. */
  readonly dir: string;
  /** The release this server runs. */
  readonly installed: string;
  /** omp's update job's status file (`<app data>/omp-update.json`); absent where no such job runs. */
  readonly ompStatus?: string;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs a command to its end (`dpkg-query`, `sudo -n true`, `systemd-run`), replaced in tests. */
  readonly run?: (command: string, args: readonly string[]) => Promise<RunResult>;
  /** This process's control groups (`/proc/self/cgroup`), replaced in tests. */
  readonly cgroup?: () => Promise<string>;
  readonly now?: () => Date;
}

const Latest = z.object({ tag_name: z.string(), published_at: z.string().min(1) });
const LastFile = z.object({
  version: z.literal(1),
  from: AppVersion,
  to: AppVersion,
  at: z.string().min(1),
});
const FailedFile = z.object({ version: z.literal(1), to: AppVersion });
const OmpJob = z.object({
  pending: z.string().optional(),
  running: z.string().optional(),
  blocked: z.string().optional(),
});

type Job = NonNullable<AppUpdates["job"]>;
type Install = AppUpdates["install"];

const message = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

function runCommand(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (failure) => done({ code: 127, output: failure.message }));
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The install unit's script: apt, then the service's restart; on a failure, the version it could not install. */
const INSTALL_SCRIPT = [
  'if sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades "$1" >"$2" 2>&1; then',
  `  systemctl --user daemon-reload; systemctl --user restart ${SERVICE}`,
  "else",
  `  printf '{"version":1,"to":"%s"}\\n' "$4" >"$3"`,
  "fi",
].join("\n");

export class AppUpdater {
  readonly #options: AppUpdaterOptions;
  readonly #fetch: NonNullable<AppUpdaterOptions["fetch"]>;
  readonly #run: NonNullable<AppUpdaterOptions["run"]>;
  readonly #now: () => Date;
  #latest: AppUpdates["latest"] = null;
  #checkedAt: Date | null = null;
  #checkProblem: string | null = null;
  #checking: Promise<void> | null = null;
  #job: Job | null = null;
  #last: AppUpdates["last"] = null;
  readonly #ready: Promise<void>;

  constructor(options: AppUpdaterOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#run = options.run ?? runCommand;
    this.#now = options.now ?? (() => new Date());
    this.#ready = this.#readFiles();
  }

  /** What an earlier update left: the one that brought this release, or the one that failed to install. */
  async #readFiles(): Promise<void> {
    const { dir, installed } = this.#options;
    const last = LastFile.safeParse(await readJson(join(dir, "last.json")));
    if (last.success && last.data.to === installed) {
      this.#last = { from: last.data.from, to: last.data.to, at: last.data.at };
    }
    const failed = FailedFile.safeParse(await readJson(join(dir, "failed.json")));
    if (failed.success && failed.data.to !== installed) {
      const log = join(dir, `install-${failed.data.to}.log`);
      const tail = (await readFile(log, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ");
      this.#job = {
        version: failed.data.to,
        step: "failed",
        at:
          (last.success && last.data.to === failed.data.to ? last.data.at : null) ??
          this.#now().toISOString(),
        detail: `The package did not install${tail === "" ? "" : `: ${tail}`} (${log}).`,
      };
    }
  }

  /** The updates as Settings shows them; looks for the newest release first when asked or an hour after the last look. */
  async read(options: { readonly check?: boolean } = {}): Promise<AppUpdates> {
    await this.#ready;
    const stale =
      this.#checkedAt === null ||
      this.#now().getTime() - this.#checkedAt.getTime() >= CHECK_EVERY_MS;
    if (options.check === true || stale) await this.#check();
    return await this.#snapshot();
  }

  async #snapshot(): Promise<AppUpdates> {
    return {
      installed: this.#options.installed,
      latest: this.#latest,
      checkedAt: this.#checkedAt?.toISOString() ?? null,
      ...(this.#checkProblem === null ? {} : { checkProblem: this.#checkProblem }),
      install: await this.#install(),
      job: this.#job,
      last: this.#last,
    };
  }

  /** One look at a time; a second asker waits for the one under way. */
  #check(): Promise<void> {
    this.#checking ??= (async () => {
      try {
        const answer = await this.#fetch(LATEST, {
          headers: { accept: "application/vnd.github+json", "user-agent": "omp-app" },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        if (!answer.ok) throw new Error(`GitHub answered ${answer.status}`);
        const release = Latest.parse(await answer.json());
        const version = AppVersion.safeParse(release.tag_name.replace(/^v/, ""));
        if (!version.success) throw new Error(`the newest release is named ${release.tag_name}`);
        this.#latest = { version: version.data, at: release.published_at };
        this.#checkProblem = null;
      } catch (failure) {
        this.#checkProblem = `The newest release could not be looked up: ${message(failure)}.`;
      } finally {
        this.#checkedAt = this.#now();
        this.#checking = null;
      }
    })();
    return this.#checking;
  }

  /** Whether this server can install a release itself; when not, why, and what to run instead. */
  async #install(): Promise<Install> {
    const { installed } = this.#options;
    const byHand = (version: string): string =>
      `wget ${APP_RELEASES}/download/v${version}/omp-app_${version}_amd64.deb && sudo apt install ./omp-app_${version}_amd64.deb && systemctl --user restart ${SERVICE}`;
    const command = this.#latest === null ? {} : { command: byHand(this.#latest.version) };
    // A server run from its source says "dev" or its package's "0.0.0".
    if (installed === "0.0.0" || !AppVersion.safeParse(installed).success) {
      return {
        possible: false,
        reason: "This server is a development build: it does not update itself.",
      };
    }
    const cgroup = await (
      this.#options.cgroup ?? (() => readFile("/proc/self/cgroup", "utf8"))
    )().catch(() => "");
    if (!cgroup.includes(`/${SERVICE}`)) {
      return {
        possible: false,
        reason:
          "This server does not run as the omp-app service, so it cannot restart itself into a new release.",
        ...command,
      };
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own format, not a template
    const dpkg = await this.#run("dpkg-query", ["-W", "-f=${Version}", "omp-app"]);
    if (dpkg.code !== 0 || dpkg.output.trim() !== installed) {
      return {
        possible: false,
        reason: "This server is not the installed omp-app package.",
        ...command,
      };
    }
    if (this.#options.ompStatus !== undefined) {
      const job = OmpJob.safeParse(await readJson(this.#options.ompStatus));
      const held = job.success
        ? (job.data.running ?? job.data.pending ?? job.data.blocked)
        : undefined;
      if (held !== undefined) {
        return {
          possible: false,
          reason: `omp's update is under way or waiting (${held}): omp-app updates wait until it is done, since a release brings the omp it pins.`,
        };
      }
    }
    if ((await this.#run("sudo", ["-n", "true"])).code !== 0) {
      return {
        possible: false,
        reason:
          "Installing needs sudo without a password for this account on the server's computer.",
        ...command,
      };
    }
    return { possible: true };
  }

  /** Starts installing `version`: returns once the download began; the server restarts when it is installed. */
  async update(version: string): Promise<AppUpdates> {
    await this.#ready;
    if (this.#job !== null && this.#job.step !== "failed") {
      throw new AppFailure({
        code: "conflict",
        message: `omp-app ${this.#job.version} is being installed already.`,
        retryable: false,
      });
    }
    if (version === this.#options.installed) {
      throw new AppFailure({
        code: "invalid_args",
        message: `This server runs omp-app ${version} already.`,
        retryable: false,
      });
    }
    const install = await this.#install();
    if (!install.possible) {
      throw new AppFailure({ code: "permission", message: install.reason, retryable: false });
    }
    this.#job = { version, step: "downloading", at: this.#now().toISOString() };
    void this.#installRelease(version).catch((failure: unknown) => {
      this.#job = {
        version,
        step: "failed",
        at: this.#now().toISOString(),
        detail: message(failure),
      };
    });
    return await this.#snapshot();
  }

  async #download(url: string): Promise<Buffer> {
    const answer = await this.#fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
    return Buffer.from(await answer.arrayBuffer());
  }

  async #installRelease(version: string): Promise<void> {
    const { dir, installed } = this.#options;
    const name = `omp-app_${version}_amd64.deb`;
    const folder = join(dir, `v${version}`);
    const sums = (await this.#download(`${APP_RELEASES}/download/v${version}/SHA256SUMS`)).toString(
      "utf8",
    );
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+\*?/))
      .find((fields) => fields[1] === name)?.[0];
    if (expected === undefined)
      throw new Error(`The release ${version} lists no checksum for ${name}.`);
    const deb = await this.#download(`${APP_RELEASES}/download/v${version}/${name}`);
    const actual = createHash("sha256").update(deb).digest("hex");
    if (actual !== expected.toLowerCase()) {
      throw new Error(
        `The downloaded ${name} does not match the release's checksum: nothing was installed.`,
      );
    }
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await writeFile(path, deb);
    // Only this release's package and the running one's folder stay (the running one is the next Go back).
    for (const entry of await readdir(dir).catch(() => [])) {
      if (/^v\d+\.\d+\.\d+$/.test(entry) && entry !== `v${version}` && entry !== `v${installed}`) {
        await rm(join(dir, entry), { recursive: true, force: true });
      }
    }
    await rm(join(dir, "failed.json"), { force: true });
    await writeFile(
      join(dir, "last.json"),
      `${JSON.stringify({ version: 1, from: installed, to: version, at: this.#now().toISOString() })}\n`,
    );
    this.#job = { version, step: "installing", at: this.#now().toISOString() };
    const started = await this.#run("systemd-run", [
      "--user",
      `--unit=omp-app-update-${version.replaceAll(".", "-")}-${this.#now().getTime()}`,
      "--collect",
      "sh",
      "-c",
      INSTALL_SCRIPT,
      "omp-app-update",
      path,
      join(dir, `install-${version}.log`),
      join(dir, "failed.json"),
      version,
    ]);
    if (started.code !== 0)
      throw new Error(`The install could not start: ${started.output.trim()}`);
    // The unit installs and restarts the service: this process ends with it. When apt fails it writes failed.json.
    void this.#watchFailure(version);
  }

  /** While this server still runs, an install that failed shows as failed. */
  async #watchFailure(version: string): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
      await new Promise((done) => setTimeout(done, 2_000));
      const failed = FailedFile.safeParse(await readJson(join(this.#options.dir, "failed.json")));
      if (failed.success && failed.data.to === version) {
        await this.#readFiles();
        return;
      }
    }
  }
}

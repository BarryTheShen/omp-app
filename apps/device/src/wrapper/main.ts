/**
 * `omp-app-device wrapper` (#20): sshd's ForceCommand for every agent session. It runs as the agent account, reports
 * each session to the guard's records socket (what ran, what the terminal showed, how it ended), then runs it:
 * - a command (`ssh laptop ls`): `bash -c` with its output also sent to the guard;
 * - an interactive shell: `bash -l` under `script`, which records only what the terminal shows, so input typed at a
 *   prompt that hides it (a password) is never recorded;
 * - a file copy (sftp): the sftp server, recorded as metadata only.
 * If the guard cannot be told, nothing runs: a session that cannot be recorded does not happen.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
const original = env.SSH_ORIGINAL_COMMAND ?? "";
const stream = Number(env.OMP_ACCESS_STREAM ?? "0");
const recordsPath = env.OMP_ACCESS_RECORDS ?? "";
/** The sftp server's path, as the session's sshd config names it (`Subsystem sftp <path> -l INFO`). */
const sftpServer = env.OMP_ACCESS_SFTP_SERVER ?? "/usr/lib/openssh/sftp-server";
const run = randomBytes(8).toString("hex");
const kind: "command" | "shell" | "sftp" =
  original === ""
    ? "shell"
    : /(^|\/)sftp-server(\s|$)|^internal-sftp$/.test(original)
      ? "sftp"
      : "command";

/**
 * The guard's records socket: `accepted` is true once the guard took the run's start; null when it cannot be reached.
 * Every line goes whole and in order: what the socket cannot take now waits for its drain (`settled`).
 */
async function connectRecords(): Promise<{
  write(line: object): void;
  /** Whether much is waiting to be sent: the output is read more slowly. */
  backlogged(): boolean;
  /** Resolves once everything written was sent. */
  settled(): Promise<void>;
  /** Sends what is waiting, then closes. */
  end(): Promise<void>;
  accepted: Promise<boolean>;
} | null> {
  if (recordsPath === "" || !Number.isInteger(stream) || stream < 1) return null;
  let answered: (ok: boolean) => void = () => undefined;
  const accepted = new Promise<boolean>((done) => {
    answered = done;
    setTimeout(() => done(false), 5_000);
  });
  const backlog: Buffer[] = [];
  let waiting = 0;
  let closed = false;
  const whenSent: (() => void)[] = [];
  let socket: Bun.Socket | null = null;
  const flush = () => {
    while (backlog.length > 0 && socket !== null && !closed) {
      const head = backlog[0] as Buffer;
      const written = Math.max(0, socket.write(head));
      waiting -= written;
      if (written < head.length) {
        backlog[0] = head.subarray(written);
        return;
      }
      backlog.shift();
    }
    if (backlog.length === 0 || closed) for (const done of whenSent.splice(0)) done();
  };
  try {
    socket = await Bun.connect({
      unix: recordsPath,
      socket: {
        data(_socket, chunk) {
          answered(new TextDecoder().decode(chunk).startsWith("ok\n"));
        },
        drain() {
          flush();
        },
        close() {
          closed = true;
          answered(false);
          flush();
        },
      },
    });
  } catch {
    return null;
  }
  const settled = () =>
    backlog.length === 0 || closed
      ? Promise.resolve()
      : new Promise<void>((done) => whenSent.push(done));
  return {
    write: (line) => {
      const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
      backlog.push(bytes);
      waiting += bytes.length;
      if (backlog.length === 1) flush();
    },
    backlogged: () => waiting > 1_048_576,
    settled,
    end: async () => {
      await settled();
      socket?.end();
    },
    accepted,
  };
}

/** A command line as recorded: one longer than the record holds is cut, with its full length and checksum. */
function recorded(command: string): string {
  if (command.length <= 4_000) return command;
  const sha = createHash("sha256").update(command).digest("hex");
  return `${command.slice(0, 3_800)} … [cut: ${command.length} characters in all, sha256 ${sha}]`;
}

function refused(): never {
  process.stderr.write("agent access: this session cannot be recorded, so it does not run.\n");
  process.exit(126);
}

const records = await connectRecords();
if (records === null) refused();

records.write({
  type: "start",
  stream,
  run,
  kind,
  command: kind === "shell" ? "(interactive shell)" : recorded(original),
  folder: process.cwd().slice(0, 1_000),
  startedAt: new Date().toISOString(),
});
// Nothing runs until the guard has taken the start.
if (!(await records.accepted)) refused();

/** What the terminal showed, to the guard in pieces it takes; waits while much is still unsent. */
const output = async (bytes: Uint8Array) => {
  for (let at = 0; at < bytes.length; at += 60_000) {
    records.write({
      type: "output",
      stream,
      run,
      bytes: Buffer.from(bytes.subarray(at, at + 60_000)).toString("base64"),
    });
  }
  if (records.backlogged()) await records.settled();
};

let exitCode: number | null = null;
try {
  if (kind === "sftp") {
    // A copy session: its files go over sftp's own channel (stdin and stdout); its log (`-e`: to stderr instead of
    // syslog) names each file opened, written, removed or renamed, and is what the live view shows of it.
    const proc = Bun.spawn([sftpServer, "-e", "-l", "INFO"], {
      stdio: ["inherit", "inherit", "pipe"],
    });
    for await (const chunk of proc.stderr) await output(chunk);
    exitCode = await proc.exited;
  } else if (kind === "shell") {
    // `script` runs the shell on a terminal of its own and writes what that terminal shows to a FIFO only this account
    // can open (an extra fd from Bun.spawn is a socket, which `script` cannot open by path). No FIFO, no shell.
    const folder = mkdtempSync(join(tmpdir(), "omp-access-"));
    const fifo = join(folder, "terminal");
    try {
      if (Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode !== 0) {
        process.stderr.write(
          "agent access: this session cannot be recorded, so it does not run.\n",
        );
        exitCode = 126;
      } else {
        const reading = (async () => {
          for await (const chunk of Bun.file(fifo).stream()) await output(chunk);
        })();
        const proc = Bun.spawn(
          ["script", "--quiet", "--flush", "--return", "--command", "bash -l", fifo],
          { stdio: ["inherit", "inherit", "inherit"] },
        );
        exitCode = await proc.exited;
        // A `script` that ended before opening the FIFO leaves the reading waiting for a writer: one that opens and
        // closes it ends the reading (no reader any more: nothing to do).
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // The reading has ended.
        }
        await reading;
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  } else {
    const proc = Bun.spawn(["bash", "-c", original], { stdio: ["inherit", "pipe", "pipe"] });
    const pipe = async (from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
      for await (const chunk of from) {
        to.write(chunk);
        await output(chunk);
      }
    };
    await Promise.all([pipe(proc.stdout, process.stdout), pipe(proc.stderr, process.stderr)]);
    exitCode = await proc.exited;
  }
} finally {
  records.write({ type: "end", stream, run, exitCode, endedAt: new Date().toISOString() });
  await records.end();
}
process.exit(exitCode ?? 1);

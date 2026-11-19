/**
 * Agent access end to end (#20), with nothing faked between the agent's ssh and the machine's shell: a server (its real
 * enrollment route, hub, proxy socket and ssh files), the machine's agent and guard, a real `sshd -i` and the wrapper.
 * Needs OpenSSH unpacked and a StrictModes-safe folder, as the guard's tests do; skipped without them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { AccessActivity } from "@omp-app/contracts";
import type { AccessLink } from "../../../../packages/server/src/devices/access/link";
import {
  type DeviceAccess,
  deviceAccessRoute,
  openDeviceAccess,
} from "../../../../packages/server/src/devices/access/routes";
import { PairingDesk } from "../../../../packages/server/src/devices/pairing";
import { Guard } from "../guard/guard";
import { ChildLauncher } from "../guard/launcher";
import { Agent } from "./agent";

const OPENSSH = process.env.OMP_APP_DEVICE_TEST_OPENSSH ?? "";
const BASE = process.env.OMP_APP_DEVICE_TEST_DIR ?? "";
const ready = OPENSSH !== "" && BASE !== "";
const LIB = join(OPENSSH, "usr/lib/x86_64-linux-gnu");
const BUN = process.execPath;
const account = userInfo().username;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const each of cleanup.splice(0).reverse()) await each();
});

async function chain() {
  const dir = await mkdtemp(join(BASE, "chain-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  // The machine: its guard, with a real sshd and the wrapper, and its agent.
  const hostKey = join(dir, "machine", "host_ed25519");
  await Bun.spawn(["mkdir", "-p", join(dir, "machine")]).exited;
  await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", hostKey]).exited;
  const guard = new Guard({
    runDir: join(dir, "machine", "run"),
    account,
    hostKey,
    wrapper: `env LD_LIBRARY_PATH=${LIB} ${BUN} ${join(import.meta.dir, "../wrapper/main.ts")}`,
    sftpServer: join(OPENSSH, "usr/lib/openssh/sftp-server"),
    ...(existsSync(join(OPENSSH, "usr/lib/openssh/sshd-session"))
      ? {
          sshdSession: join(OPENSSH, "usr/lib/openssh/sshd-session"),
          sshdAuth: join(OPENSSH, "usr/lib/openssh/sshd-auth"),
        }
      : {}),
    launcher: new ChildLauncher(["env", `LD_LIBRARY_PATH=${LIB}`, join(OPENSSH, "usr/sbin/sshd")]),
    verify: async () => true,
    maxOnMs: 2 * 3_600_000,
    log: () => undefined,
    stateDir: join(dir, "machine", "state"),
    watchPaths: [join(dir, "machine", "home", ".bashrc")],
    sudo: { grant: async () => null, revoke: async () => undefined },
    agentAccount: { problem: async () => null, reset: async () => [] },
  });
  await guard.start();
  cleanup.push(() => guard.stop());
  // The person's terminals here are the test runner's: the notice is kept, not written to them.
  const told: string[] = [];
  const agent = await Agent.open({
    dataDir: join(dir, "machine", "data"),
    runtimeDir: join(dir, "machine", "agent-run"),
    guardSocket: guard.controlSocket,
    tellTerminals: async (text) => told.push(text),
    readReach: async () => ["the internet (via eth0)", "192.168.1.0/24 (via eth0)"],
  });
  await agent.start();
  cleanup.push(() => agent.stop());

  // The server: enrollment and the access link on a real HTTP server.
  const desk = new PairingDesk();
  const heard: AccessActivity[] = [];
  let access: DeviceAccess | null = null;
  const server = Bun.serve<{ link?: AccessLink }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bun) {
      if (access === null) return new Response("starting", { status: 503 });
      const answer = await deviceAccessRoute(request, new URL(request.url), access, {
        hostAllowed: () => true,
        upgrade: (each) => bun.upgrade(each, { data: {} }),
      });
      return answer === "upgraded"
        ? undefined
        : (answer ?? new Response("not found", { status: 404 }));
    },
    websocket: {
      open(ws) {
        ws.data.link = access?.hub.attach(
          (frame) => {
            ws.send(JSON.stringify(frame));
          },
          (code, reason) => ws.close(code, reason),
        );
      },
      message(ws, message) {
        ws.data.link?.receive(String(message));
      },
      close(ws) {
        if (ws.data.link !== undefined) access?.hub.detached(ws.data.link);
      },
    },
  });
  cleanup.push(() => void server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;
  const opened = await openDeviceAccess({
    appDataDir: join(dir, "server"),
    env: { XDG_RUNTIME_DIR: join(dir, "server-run") },
    serverOrigin: origin,
    desk,
    proxyCommand: [BUN, join(import.meta.dir, "test-device-ssh.ts")],
    sessionAccount: account,
    threadOfScope: () => null,
    onMachinesChanged: () => undefined,
    onActivity: (each) => heard.push(each),
  });
  access = opened;
  cleanup.push(() => opened.stop());

  const ssh = (...command: string[]) =>
    Bun.spawn(["ssh", "-F", opened.files.configPath, "-o", "BatchMode=yes", "laptop", ...command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OMP_ACCESS_TEST_PROXY: join(dir, "server-run", "omp-app-access", "proxy.sock"),
      },
    });
  const until = async (what: string, check: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await Bun.sleep(25);
    }
  };
  return { agent, guard, access: opened, desk, origin, heard, ssh, until, dir, told };
}

describe.skipIf(!ready)("agent access end to end (#20)", () => {
  test("enrolled and on, an agent's ssh runs a command on the machine; the machine's signed records reach the server", async () => {
    const c = await chain();
    expect(await c.agent.enroll(c.origin, c.desk.newCode().code, "laptop")).toBeNull();
    // Off: no way in.
    const before = c.ssh("true");
    expect(await before.exited).toBe(255);
    expect(await new Response(before.stderr).text()).toContain("laptop: agent access is off");

    expect(await c.agent.on(process.pid, 30)).toBeNull();
    await c.until("the server sees it on", () => c.access.hub.machines()[0]?.state.on === true);
    await c.until("the session key is written", () => existsSync(c.access.files.keyPath("laptop")));
    // What access opens, as the machine read it, is in the server's view of it.
    await c.until("the reach", () => (c.access.hub.machines()[0]?.reach.length ?? 0) > 0);
    expect(c.access.hub.machines()[0]?.reach).toEqual([
      "the internet (via eth0)",
      "192.168.1.0/24 (via eth0)",
    ]);
    const session = c.ssh("echo hello from the machine; exit 3");
    expect(await session.exited).toBe(3);
    expect(await new Response(session.stdout).text()).toBe("hello from the machine\n");
    await c.until("both records", () => c.heard.length >= 2);
    expect(c.told).toEqual([
      "omp agent session on this computer: echo hello from the machine; exit 3 (omp-app-device watch shows it)",
    ]);
    expect(
      c.heard.map((each) => [
        each.record.seq,
        each.record.command,
        each.record.exitCode,
        each.verified,
      ]),
    ).toEqual([
      [1, "echo hello from the machine; exit 3", null, true],
      [1, "echo hello from the machine; exit 3", 3, true],
    ]);
    // The machine's host key is the one the server pinned at enrollment: ssh checked it strictly.
    expect(
      await readFile(join(c.dir, "server-run", "omp-app-access", "known_hosts"), "utf8"),
    ).toContain("omp-access-laptop ssh-ed25519 ");
    // Sudo allowed at the machine: the server's view of it says until when.
    expect(await c.agent.sudo(process.pid, 5)).toBeNull();
    await c.until("the server sees sudo", () => {
      const state = c.access.hub.machines()[0]?.state;
      return state?.on === true && state.sudoUntil !== null;
    });
  });

  test("an agent that starts while the guard is on (it restarted mid-access) turns access off and says so (audit 2 F9)", async () => {
    const c = await chain();
    await c.agent.enroll(c.origin, c.desk.newCode().code, "laptop");
    await c.agent.on(process.pid, 30);
    await c.until("on", () => c.guard.state().on);
    // The agent goes away without turning access off (a crash, a restart), and starts again.
    await c.agent.stop();
    const told: string[] = [];
    const again = await Agent.open({
      dataDir: join(c.dir, "machine", "data"),
      runtimeDir: join(c.dir, "machine", "agent-run"),
      guardSocket: c.guard.controlSocket,
      tellTerminals: async (text) => told.push(text),
    });
    await again.start();
    try {
      await c.until("the guard is off", () => !c.guard.state().on);
      await c.until("the person is told", () =>
        told.some((each) => each.startsWith("Agent access was still on")),
      );
      expect(again.state.on).toBe(false);
    } finally {
      await again.stop();
    }
  });

  test("off from any page: the machine turns off, its sessions end and the next ssh is refused", async () => {
    const c = await chain();
    await c.agent.enroll(c.origin, c.desk.newCode().code, "laptop");
    await c.agent.on(process.pid, 30);
    await c.until("on", () => c.access.hub.machines()[0]?.state.on === true);
    // While on, the computer is not moved to another enrollment: the turn-on's session key stays with its server.
    expect(await c.agent.enroll(c.origin, c.desk.newCode().code, "other")).toBe(
      "turn agent access off first",
    );
    await Bun.sleep(100);
    const long = c.ssh("sleep 600");
    // The open session is in the machine's state on the server (the panel's "1 session").
    await c.until("the server counts the session", () => {
      const state = c.access.hub.machines()[0]?.state;
      return state?.on === true && state.sessions === 1;
    });
    await c.until("its run's start reached the server", () => c.heard.length >= 1);
    const machineId = c.access.hub.machines()[0]?.id ?? "";
    expect(c.access.hub.off(machineId)).toBe(true);
    await long.exited;
    await c.until("the agent is off", () => !c.agent.state.on);
    await c.until("the server sees it off", () => c.access.hub.machines()[0]?.state.on === false);
    // The person hears what happened while it was on.
    await c.until("the summary", () =>
      c.told.some((each) => each.startsWith("Agent access is off.")),
    );
    expect(c.told.at(-1)).toBe("Agent access is off. While on: 1 session; no sudo.");
    const after = c.ssh("true");
    expect(await after.exited).toBe(255);
  });

  test("a computer being removed is forgotten by the server, and set up again it enrolls under the same name", async () => {
    const c = await chain();
    expect(await c.agent.enroll(c.origin, c.desk.newCode().code, "laptop")).toBeNull();
    expect(c.access.hub.machines().map((each) => each.alias)).toEqual(["laptop"]);
    // Off, so no link is kept: the agent opens one only to say it leaves.
    expect(await c.agent.leave()).toBeNull();
    expect(c.access.hub.machines()).toEqual([]);
    expect(c.agent.machine).toBeNull();
    expect(existsSync(join(c.dir, "machine", "data", "machine.json"))).toBe(false);
    // Before, the server still held the name and the second setup was refused ("alias-taken", found on a VM).
    expect(await c.agent.enroll(c.origin, c.desk.newCode().code, "laptop")).toBeNull();
    expect(c.access.hub.machines().map((each) => each.alias)).toEqual(["laptop"]);
  });
});

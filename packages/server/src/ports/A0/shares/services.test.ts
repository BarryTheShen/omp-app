import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadId } from "@omp-app/contracts";
import { listServices } from "./services";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const listen = (n: number, local: string, inode: number) =>
  `   ${n}: ${local} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
const T1 = "thread-one" as ThreadId;
const T2 = "thread-two" as ThreadId;

let root: string | null = null;
afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

/**
 * A process in the fake `/proc`: its name, parent, control group and the sockets it holds. Each leads a session of its
 * own, as omp's bash tool starts every command.
 */
async function process(
  base: string,
  pid: number,
  comm: string,
  parent: number,
  cgroup: string,
  inodes: readonly number[],
) {
  const dir = join(base, String(pid));
  await mkdir(join(dir, "fd"), { recursive: true });
  for (const [fd, inode] of inodes.entries())
    await symlink(`socket:[${inode}]`, join(dir, "fd", String(fd + 3)));
  await writeFile(join(dir, "comm"), `${comm}\n`);
  await writeFile(join(dir, "cmdline"), `${comm}\0`);
  const fields = [
    "S",
    String(parent),
    String(pid),
    String(pid),
    ...Array.from({ length: 15 }, () => "0"),
    "100",
  ];
  await writeFile(join(dir, "stat"), `${pid} (${comm}) ${fields.join(" ")}\n`);
  await writeFile(join(dir, "cgroup"), `0::${cgroup}\n`);
}

describe("the services a share can open (#2788)", () => {
  test("each a port, with the chat that started it; not the app's own or the chats' hosts'; never-share marked", async () => {
    root = await mkdtemp(join(tmpdir(), "omp-app-proc-"));
    await mkdir(join(root, "net"));
    await writeFile(
      join(root, "net/tcp"),
      HEADER +
        listen(0, "0100007F:95F1", 1) + // 127.0.0.1:38385, a chat host's own
        listen(1, "0100007F:1435", 2) + // 127.0.0.1:5173, started in that host's scope
        listen(2, "00000000:0BB8", 3) + // 0.0.0.0:3000, started under a host (no systemd)
        listen(3, "0100007F:20C0", 4) + // 127.0.0.1:8384, syncthing
        listen(4, "0100007F:10DD", 5) + // 127.0.0.1:4317, the app
        listen(5, "01004064:2328", 6) + // 100.64.0.1:9000, the private network only
        listen(6, "0100007F:1B58", 7), // 127.0.0.1:7000, another user's
    );
    await writeFile(
      join(root, "net/tcp6"),
      `${HEADER}${listen(0, "00000000000000000000000001000000:1435", 8)}`, // ::1:5173, the same service
    );
    await writeFile(join(root, "stat"), "btime 1700000000\n");
    const scope = "/user.slice/user-1000.slice/user@1000.service/app.slice/omp-app-chat-a.scope";
    const service = "/user.slice/user-1000.slice/user@1000.service/app.slice/omp-app.service";
    // The first host's scope holds what it started, also a daemon that left its parent.
    await process(root, 100, "bun", 1, scope, [1]);
    await process(root, 200, "vite", 1, scope, [2, 8]);
    // The second host runs in the app's own service: what it started is found through its parents.
    await process(root, 300, "bun", 600, service, []);
    await process(root, 350, "bash", 300, service, []);
    await process(root, 400, "python3", 350, service, [3]);
    await process(root, 500, "syncthing", 1, "/user.slice/syncthing.service", [4]);
    await process(root, 600, "omp-app", 1, service, [5]);
    await process(root, 700, "node", 1, service, [6]);
    const services = await listServices({
      chats: () => [
        { pid: 100, threadId: T1 },
        { pid: 300, threadId: T2 },
      ],
      ownPid: 600,
      ownPorts: () => new Set(),
      proc: { root, ticksPerSecond: 100 },
    });
    expect(
      services.map((entry) => [entry.port, entry.program, entry.threadId, entry.neverShare]),
    ).toEqual([
      [3000, "python3", T2, false],
      [5173, "vite", T1, false],
      [7000, null, null, false],
      [8384, "syncthing", null, true],
    ]);
  });

  test("a scope the server runs in too, or that several chats share, names no chat; a host's own children still do", async () => {
    root = await mkdtemp(join(tmpdir(), "omp-app-proc-"));
    await mkdir(join(root, "net"));
    await writeFile(
      join(root, "net/tcp"),
      HEADER +
        listen(0, "0100007F:0FA1", 11) + // 127.0.0.1:4001, in the server's scope, not under a host
        listen(1, "0100007F:0FA2", 12) + // 127.0.0.1:4002, started under the first host
        listen(2, "0100007F:0FA3", 13), // 127.0.0.1:4003, in a scope two chats share
    );
    await writeFile(join(root, "net/tcp6"), HEADER);
    await writeFile(join(root, "stat"), "btime 1700000000\n");
    const T3 = "thread-three" as ThreadId;
    const slice = "/user.slice/user-1000.slice/user@1000.service/app.slice";
    // The server was started from a chat, so it runs in that chat's scope, as its own chats' hosts do.
    await process(root, 600, "omp-app", 1, `${slice}/omp-app-chat-x.scope`, []);
    await process(root, 100, "bun", 600, `${slice}/omp-app-chat-x.scope`, []);
    await process(root, 150, "vite", 1, `${slice}/omp-app-chat-x.scope`, [11]);
    await process(root, 160, "python3", 100, `${slice}/omp-app-chat-x.scope`, [12]);
    await process(root, 200, "bun", 1, `${slice}/omp-app-chat-y.scope`, []);
    await process(root, 300, "bun", 1, `${slice}/omp-app-chat-y.scope`, []);
    await process(root, 250, "node", 1, `${slice}/omp-app-chat-y.scope`, [13]);
    const services = await listServices({
      chats: () => [
        { pid: 100, threadId: T1 },
        { pid: 200, threadId: T2 },
        { pid: 300, threadId: T3 },
      ],
      ownPid: 600,
      ownPorts: () => new Set(),
      proc: { root, ticksPerSecond: 100 },
    });
    expect(services.map((entry) => [entry.port, entry.program, entry.threadId])).toEqual([
      [4001, "vite", null],
      [4002, "python3", T1],
      [4003, "node", null],
    ]);
  });
});

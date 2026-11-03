import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseListening, readListening } from "./listening";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const line = (n: number, local: string, state: string, inode: number) =>
  `   ${n}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

describe("the sockets listening on this machine (#2788)", () => {
  test("only listening sockets, with their addresses and ports, IPv4 and IPv6", () => {
    const v4 =
      HEADER +
      line(0, "0100007F:1435", "0A", 111) +
      line(1, "00000000:1F90", "0A", 222) +
      line(2, "0100007F:1435", "01", 999);
    expect(parseListening(v4, false)).toEqual([
      { port: 5173, address: "127.0.0.1", inode: 111 },
      { port: 8080, address: "0.0.0.0", inode: 222 },
    ]);
    const v6 =
      HEADER +
      line(0, "00000000000000000000000001000000:0BB8", "0A", 333) +
      line(1, "00000000000000000000000000000000:0016", "0A", 444) +
      line(2, "0000000000000000FFFF00000100007F:1F91", "0A", 555);
    expect(parseListening(v6, true)).toEqual([
      { port: 3000, address: "::1", inode: 333 },
      { port: 22, address: "::", inode: 444 },
      { port: 8081, address: "127.0.0.1", inode: 555 },
    ]);
  });

  let root: string | null = null;
  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
    root = null;
  });

  test("each socket with the program holding it: its name, command, start, control group and parents", async () => {
    root = await mkdtemp(join(tmpdir(), "omp-app-proc-"));
    await mkdir(join(root, "net"));
    await writeFile(
      join(root, "net/tcp"),
      HEADER + line(0, "0100007F:1435", "0A", 111) + line(1, "00000000:1F90", "0A", 222),
    );
    await writeFile(join(root, "net/tcp6"), HEADER);
    await writeFile(join(root, "stat"), "cpu  1 2 3\nbtime 1700000000\n");
    const pid = join(root, "4242");
    await mkdir(join(pid, "fd"), { recursive: true });
    await symlink("socket:[111]", join(pid, "fd/3"));
    await symlink("/dev/null", join(pid, "fd/0"));
    await writeFile(join(pid, "comm"), "vite\n");
    await writeFile(join(pid, "cmdline"), "node\0vite\0--port\x005173\0");
    // pid (comm) state ppid pgrp session …, the 22nd field the start in clock ticks since boot.
    const fields = ["S", "4100", "4242", "4242", ...Array.from({ length: 15 }, () => "0"), "12345"];
    await writeFile(join(pid, "stat"), `4242 (vite (dev)) ${fields.join(" ")} 0 0\n`);
    // Its parent, a shell in a session of its own, and the shell's parent, a chat's host.
    await mkdir(join(root, "4100"));
    await writeFile(join(root, "4100/stat"), "4100 (bash) S 4000 4100 4100 0\n");
    await mkdir(join(root, "4000"));
    await writeFile(join(root, "4000/stat"), "4000 (chat-host) S 1 4000 4000 0\n");
    await writeFile(
      join(pid, "cgroup"),
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/omp-app-chat-abc.scope\n",
    );
    const listed = await readListening({ root, ticksPerSecond: 100 });
    expect(listed).toEqual([
      {
        port: 5173,
        address: "127.0.0.1",
        inode: 111,
        pid: 4242,
        program: "vite",
        command: "node vite --port 5173",
        startedAt: (1_700_000_000 + 123.45) * 1000,
        cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/omp-app-chat-abc.scope",
        ancestors: [4100, 4000],
      },
      {
        port: 8080,
        address: "0.0.0.0",
        inode: 222,
        pid: null,
        program: null,
        command: null,
        startedAt: null,
        cgroup: null,
        ancestors: [],
      },
    ]);
  });
});

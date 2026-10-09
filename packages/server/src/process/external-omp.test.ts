import { describe, expect, test } from "bun:test";
import { findExternalOmp, matchExternalOmp, readProcessTable } from "./external-omp";
import { leaseSocketName } from "./session-lease";

const sessionId = "01a00000-0000-7000-8000-000000000010";
const sessionFile = "/home/fixture/.omp/agent/sessions/-workspace/2026-09-01_01a00000.jsonl";
const otherFile = "/home/fixture/.omp/agent/sessions/-workspace/2026-09-02_01a00001.jsonl";
const ownersDir = "/home/fixture/.omp/run/session-owners";

/** A `/proc/net/unix` table with one datagram socket named as omp names this chat's lease. */
function tableWithLease(): string {
  return [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    `0000000000000000: 00000003 00000000 00000000 0002 03 9001 @${leaseSocketName(sessionId, ownersDir)}`,
  ].join("\n");
}

describe("matchExternalOmp", () => {
  test("an omp that resumes this chat's file is a running writer of it", () => {
    const ps = `4101 /home/user/.bun/bin/omp --mode rpc-ui --resume ${sessionFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("running");
  });

  test("an omp that names this chat by its id as one argument is a running writer", () => {
    const ps = `4102 omp --session ${sessionId}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("running");
  });

  test("an omp for another chat does not count", () => {
    const ps = `4103 omp --mode rpc-ui --resume ${otherFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("a program that only mentions this chat's file is not an omp", () => {
    const ps = `4104 less ${sessionFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("an id that only appears inside a longer word does not name the chat", () => {
    const ps = `4105 omp --session ${sessionId}9`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("the app's own server, which names no chat, is not a writer", () => {
    const ps = "4106 bun /home/fixture/workspace/projects/omp-app/packages/server/scripts/dev.ts";
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("an empty process table has no writer", () => {
    expect(matchExternalOmp("", sessionId, sessionFile)).toBe("none");
  });

  test("the rename host this server started is not another omp, even though it names the file", () => {
    const ps = `4107 omp --mode rpc-ui --resume ${sessionFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile, 4107)).toBe("none");
    expect(matchExternalOmp(ps, sessionId, sessionFile, 4108)).toBe("running");
  });
});

describe("findExternalOmp", () => {
  const noProcesses = async () => "";

  test("a live omp holding the chat's lease is running, and the process list is not needed", async () => {
    let listed = 0;
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => tableWithLease(),
        readTable: async () => {
          listed += 1;
          return "";
        },
      }),
    ).resolves.toBe("running");
    expect(listed).toBe(0);
  });

  test("an omp that names the file, before it has written, is running even with no lease yet", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => "",
        readTable: async () => `4101 omp --resume ${sessionFile}`,
      }),
    ).resolves.toBe("running");
  });

  test("the rename host this server started does not make the chat look held", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        ownPid: 4107,
        platform: "linux",
        readUnixSockets: async () => "",
        readTable: async () => `4107 omp --mode rpc-ui --resume ${sessionFile}`,
      }),
    ).resolves.toBe("none");
  });

  test("no lease and no omp naming the chat is none", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => "",
        readTable: noProcesses,
      }),
    ).resolves.toBe("none");
  });

  test("an unreadable process list is unknown, even when the lease is free", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => "",
        readTable: async () => undefined,
      }),
    ).resolves.toBe("unknown");
  });

  test("an unreadable lease table is unknown, even when the process list is empty", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => {
          throw new Error("no /proc");
        },
        readTable: noProcesses,
      }),
    ).resolves.toBe("unknown");
  });

  test("off Linux, where the lease cannot be probed, an empty process list is none", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "darwin",
        readTable: noProcesses,
      }),
    ).resolves.toBe("none");
  });

  test("off Linux, an unreadable process list is unknown", async () => {
    await expect(
      findExternalOmp({
        sessionId,
        sessionFile,
        ownersDir,
        platform: "darwin",
        readTable: async () => undefined,
      }),
    ).resolves.toBe("unknown");
  });
});

describe("readProcessTable", () => {
  test("returns the command's output when it succeeds", async () => {
    await expect(readProcessTable(["sh", "-c", "echo listed"])).resolves.toBe("listed\n");
  });

  test("a command that cannot start gives no process list", async () => {
    await expect(readProcessTable(["/nonexistent/omp-app-process-list"])).resolves.toBeUndefined();
  });

  test("a command that exits non-zero gives no process list", async () => {
    await expect(readProcessTable(["sh", "-c", "echo partial; exit 3"])).resolves.toBeUndefined();
  });

  test("a command that runs past the limit is stopped and gives no process list", async () => {
    const started = performance.now();
    await expect(readProcessTable(["sleep", "30"], 200)).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

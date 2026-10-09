import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  leaseSocketName,
  ompSessionOwnersDir,
  probeSessionLease,
  unixDatagramNames,
} from "./session-lease";

const sessionId = "01a00000-0000-7000-8000-00000000abcd";
const ownersDir = "/fixture/home/.omp/run/session-owners";
const otherOwnersDir = "/fixture/other/.omp/run/session-owners";

/** A `/proc/net/unix` table: the header, then one row per socket (type 0001 stream, 0002 datagram). */
function procNetUnix(rows: readonly { readonly type: string; readonly name?: string }[]): string {
  const header = "Num       RefCount Protocol Flags    Type St Inode Path";
  const lines = rows.map(
    (row, index) =>
      `${index.toString(16).padStart(16, "0")}: 00000003 00000000 00000000 ${row.type} 03 ${1000 + index}${row.name === undefined ? "" : ` ${row.name}`}`,
  );
  return [header, ...lines].join("\n");
}

describe("leaseSocketName", () => {
  test("names the same lease for the same session and owners directory, whatever the spelling of the directory", () => {
    const relative = leaseSocketName(sessionId, "fixture/home/.omp/run/session-owners");
    expect(leaseSocketName(sessionId, `${resolve("fixture/home/.omp/run/session-owners")}/`)).toBe(
      relative,
    );
    expect(relative).toMatch(/^omp-file-lock-[0-9a-f]{32}$/);
  });

  test("names a different lease for another session or another owners directory", () => {
    const name = leaseSocketName(sessionId, ownersDir);
    expect(leaseSocketName("01a00000-0000-7000-8000-00000000beef", ownersDir)).not.toBe(name);
    expect(leaseSocketName(sessionId, otherOwnersDir)).not.toBe(name);
  });

  test("names a session id that is not a plain token by its hash, not by the id itself", () => {
    const hostile = "../escape/session";
    const name = leaseSocketName(hostile, ownersDir);
    expect(name).toMatch(/^omp-file-lock-[0-9a-f]{32}$/);
    expect(name).not.toBe(leaseSocketName(join(ownersDir, "escape"), ownersDir));
  });
});

describe("ompSessionOwnersDir", () => {
  test("is run/session-owners under the home directory, with omp's config directory name", () => {
    expect(ompSessionOwnersDir({}, "/fixture/home")).toBe("/fixture/home/.omp/run/session-owners");
    expect(ompSessionOwnersDir({ PI_CONFIG_DIR: ".alt" }, "/fixture/home")).toBe(
      "/fixture/home/.alt/run/session-owners",
    );
  });

  test("uses the XDG state root only when omp's own state root exists under it", () => {
    const xdg = "/fixture/xdg-state-that-does-not-exist";
    expect(ompSessionOwnersDir({ XDG_STATE_HOME: xdg }, "/fixture/home")).toBe(
      "/fixture/home/.omp/run/session-owners",
    );
  });
});

describe("unixDatagramNames", () => {
  test("keeps the named datagram sockets only", () => {
    const table = procNetUnix([
      { type: "0001", name: "@omp-file-lock-stream" },
      { type: "0002", name: "@omp-file-lock-lease" },
      { type: "0005", name: "@omp-file-lock-packet" },
      { type: "0002" },
    ]);
    expect([...unixDatagramNames(table)]).toEqual(["@omp-file-lock-lease"]);
  });

  test("an empty table, or only its header, names nothing", () => {
    expect(unixDatagramNames("")).toEqual(new Set());
    expect(unixDatagramNames(procNetUnix([]))).toEqual(new Set());
  });
});

describe("probeSessionLease", () => {
  const lease = leaseSocketName(sessionId, ownersDir);

  test("is held while a datagram socket bears the chat's lease name", async () => {
    const table = procNetUnix([{ type: "0002", name: `@${lease}` }]);
    await expect(
      probeSessionLease({
        sessionId,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => table,
      }),
    ).resolves.toBe("held");
  });

  test("is free when the name is only a stream socket, which omp's lease never is", async () => {
    const table = procNetUnix([{ type: "0001", name: `@${lease}` }]);
    await expect(
      probeSessionLease({
        sessionId,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => table,
      }),
    ).resolves.toBe("free");
  });

  test("is free when the lease belongs to another owners directory", async () => {
    const table = procNetUnix([
      { type: "0002", name: `@${leaseSocketName(sessionId, otherOwnersDir)}` },
    ]);
    await expect(
      probeSessionLease({
        sessionId,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => table,
      }),
    ).resolves.toBe("free");
  });

  test("is unknown when the socket table cannot be read", async () => {
    await expect(
      probeSessionLease({
        sessionId,
        ownersDir,
        platform: "linux",
        readUnixSockets: async () => {
          throw new Error("no /proc");
        },
      }),
    ).resolves.toBe("unknown");
  });

  test("is unsupported off Linux, where the socket table is not read at all", async () => {
    let reads = 0;
    await expect(
      probeSessionLease({
        sessionId,
        ownersDir,
        platform: "darwin",
        readUnixSockets: async () => {
          reads += 1;
          return "";
        },
      }),
    ).resolves.toBe("unsupported");
    expect(reads).toBe(0);
  });
});

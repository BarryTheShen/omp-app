import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

/** A TCP socket listening on this machine, as `/proc/net/tcp` or `tcp6` lists it. */
export interface ListeningSocket {
  readonly port: number;
  /** The address it is bound to: `127.0.0.1`, `0.0.0.0`, `::1`, `::` or another. */
  readonly address: string;
  readonly inode: number;
}

/** A listening socket with the program that holds it, when that program is this user's to look at. */
export interface ListeningProgram extends ListeningSocket {
  readonly pid: number | null;
  /** Its name, as `/proc/<pid>/comm` gives it. */
  readonly program: string | null;
  /** Its command line, its words joined by spaces. */
  readonly command: string | null;
  /** When it started, in milliseconds since the epoch. */
  readonly startedAt: number | null;
  /** Its control group's path (the systemd unit it runs in). */
  readonly cgroup: string | null;
  /**
   * Its parents, nearest first, up to the first process. omp's bash tool starts each command in a session of its own,
   * but as a child of the chat's host, so a service a chat started has that host among them.
   */
  readonly ancestors: readonly number[];
}

const LISTEN = "0A";

/** The four bytes of an IPv4 address as `/proc/net/tcp` writes them: one 32-bit word in the machine's (little-endian) order. */
function ipv4(hex: string): string {
  const bytes = [6, 4, 2, 0].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return bytes.join(".");
}

/** An IPv6 address as `/proc/net/tcp6` writes it: four 32-bit words, each in little-endian order. */
function ipv6(hex: string): string {
  const groups: string[] = [];
  for (let word = 0; word < 4; word += 1) {
    const bytes = hex.slice(word * 8, word * 8 + 8).match(/../g) ?? [];
    const ordered = bytes.reverse().join("");
    groups.push(ordered.slice(0, 4), ordered.slice(4, 8));
  }
  const full = groups.map((group) => Number.parseInt(group, 16).toString(16));
  // IPv4-mapped (::ffff:a.b.c.d) is written as IPv4.
  if (full.slice(0, 5).every((group) => group === "0") && full[5] === "ffff") {
    const tail = groups.slice(6).join("");
    return [0, 2, 4, 6].map((at) => Number.parseInt(tail.slice(at, at + 2), 16)).join(".");
  }
  const text = full.join(":");
  if (text === "0:0:0:0:0:0:0:0") return "::";
  if (text === "0:0:0:0:0:0:0:1") return "::1";
  return text.replace(/(^|:)0(:0)+(:|$)/, "::");
}

/** The sockets in LISTEN state in the text of `/proc/net/tcp` (or `tcp6`, with `v6`). */
export function parseListening(text: string, v6: boolean): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== LISTEN) continue;
    const [host, port] = (fields[1] ?? "").split(":");
    if (host === undefined || port === undefined) continue;
    sockets.push({
      port: Number.parseInt(port, 16),
      address: v6 ? ipv6(host) : ipv4(host),
      inode: Number(fields[9]),
    });
  }
  return sockets;
}

/** What `/proc/<pid>/stat` holds after the program's name (which may hold spaces and parentheses). */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

export interface ProcReader {
  /** Where `/proc` is; tests give a folder of their own. */
  readonly root: string;
  /** The kernel's clock ticks a second (`getconf CLK_TCK`): 100 on Linux. */
  readonly ticksPerSecond: number;
}

const PROC: ProcReader = { root: "/proc", ticksPerSecond: 100 };

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** A process's parent, as `/proc/<pid>/stat` gives it (field 4: [1] after the name). */
async function parentOf(proc: ProcReader, pid: number): Promise<number | null> {
  const stat = await readText(join(proc.root, String(pid), "stat"));
  const parent = stat === null ? undefined : statFields(stat)[1];
  return parent === undefined ? null : Number(parent);
}

/** The parents from `first` up, until the first process (or 64 of them, or one seen twice). */
async function ancestorsFrom(proc: ProcReader, first: number | null): Promise<number[]> {
  const chain: number[] = [];
  let pid = first;
  while (pid !== null && pid > 1 && chain.length < 64 && !chain.includes(pid)) {
    chain.push(pid);
    pid = await parentOf(proc, pid);
  }
  return chain;
}

/**
 * The listening sockets in short: their ids, sorted. Two small files read, no program looked up, so it can be read every
 * few seconds; the services are read again only when it changes.
 */
export async function listeningSignature(proc: ProcReader = PROC): Promise<string> {
  const sockets = [
    ...parseListening((await readText(join(proc.root, "net/tcp"))) ?? "", false),
    ...parseListening((await readText(join(proc.root, "net/tcp6"))) ?? "", true),
  ];
  return sockets
    .map((socket) => socket.inode)
    .sort((left, right) => left - right)
    .join(",");
}

/**
 * Every TCP socket listening on this machine, with the program that holds it (#2788). A program's sockets are found
 * through its open files (`socket:[inode]`), which only its own user may read: another user's program is listed with
 * no program. Sockets listening on two addresses are two entries.
 */
export async function readListening(proc: ProcReader = PROC): Promise<ListeningProgram[]> {
  const sockets = [
    ...parseListening((await readText(join(proc.root, "net/tcp"))) ?? "", false),
    ...parseListening((await readText(join(proc.root, "net/tcp6"))) ?? "", true),
  ];
  if (sockets.length === 0) return [];
  const wanted = new Set(sockets.map((socket) => socket.inode));
  const owners = new Map<number, number>();
  const pids = (await readdir(proc.root).catch(() => [] as string[])).filter((name) =>
    /^\d+$/.test(name),
  );
  await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(join(proc.root, pid, "fd")).catch(() => [] as string[]);
      for (const fd of fds) {
        const target = await readlink(join(proc.root, pid, "fd", fd)).catch(() => "");
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode !== undefined && wanted.has(Number(inode)))
          owners.set(Number(inode), Number(pid));
      }
    }),
  );
  const boot = Number(
    /^btime (\d+)$/m.exec((await readText(join(proc.root, "stat"))) ?? "")?.[1] ?? 0,
  );
  return Promise.all(
    sockets.map(async (socket): Promise<ListeningProgram> => {
      const pid = owners.get(socket.inode) ?? null;
      if (pid === null) {
        return {
          ...socket,
          pid,
          program: null,
          command: null,
          startedAt: null,
          cgroup: null,
          ancestors: [],
        };
      }
      const base = join(proc.root, String(pid));
      const [comm, cmdline, stat, cgroup] = await Promise.all([
        readText(join(base, "comm")),
        readText(join(base, "cmdline")),
        readText(join(base, "stat")),
        readText(join(base, "cgroup")),
      ]);
      const fields = stat === null ? [] : statFields(stat);
      // After the name: state is field 3 of the line, so the parent (field 4) is [1] and the start time (field 22) [19].
      const parent = fields[1] === undefined ? null : Number(fields[1]);
      const ticks = fields[19] === undefined ? null : Number(fields[19]);
      return {
        ...socket,
        pid,
        program: comm?.trim() || null,
        command: cmdline === null ? null : cmdline.split("\0").filter(Boolean).join(" ") || null,
        startedAt:
          ticks === null || boot === 0 ? null : (boot + ticks / proc.ticksPerSecond) * 1000,
        cgroup: cgroup?.match(/^0::(.*)$/m)?.[1] ?? null,
        ancestors: await ancestorsFrom(proc, parent),
      };
    }),
  );
}

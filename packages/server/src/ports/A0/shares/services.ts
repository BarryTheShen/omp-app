import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ListeningService, ThreadId } from "@omp-app/contracts";
import { type ProcReader, readListening } from "./listening";

/**
 * Programs never shared, even when a chat starts one (#2788): the app itself, remote login, sync and network tools,
 * databases, and browsers (whose listening port is their remote-debugging one). Listed, never shared.
 */
export const NEVER_SHARE_PROGRAMS: ReadonlySet<string> = new Set([
  "omp-app",
  "sshd",
  "syncthing",
  "tailscaled",
  "postgres",
  "mysqld",
  "mariadbd",
  "redis-server",
  "mongod",
  "chrome",
  "chromium",
  "firefox",
  "WebKitWebDriver",
]);

/** A chat's host process: its own sockets are not services, and what it starts is that chat's. */
export interface ChatHost {
  readonly pid: number;
  readonly threadId: ThreadId;
}

export interface ServiceSources {
  readonly chats: () => readonly ChatHost[];
  /** The app's own process: its sockets are not services. */
  readonly ownPid: number;
  /**
   * Whether the app listens on this address and port itself (its server, the shares' gates). By address and port, not by
   * port alone: a share's gate takes its service's port number at the share's address, and the service, listening on the
   * same number at another address, is still a service (#2788).
   */
  readonly ownSocket: (address: string, port: number) => boolean;
  readonly neverShare?: ReadonlySet<string>;
  readonly proc?: ProcReader;
}

/** Addresses a service on this machine can be reached at from it: its own, or every network. */
const REACHABLE_HERE = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

const unitOf = (cgroup: string | null): string | null =>
  cgroup === null ? null : (cgroup.split("/").at(-1) ?? null);

/**
 * The services listening on this machine that a share can pass requests to (#2788), one a port: those listening on the
 * machine itself or on every network. Not the app's own process or ports, nor the chats' host processes. A service in a
 * chat host's own systemd scope, or started under its host process (without systemd, a daemon that left its parent is no
 * chat's), was started by that chat. A scope the server runs in too (its own service, or a chat's scope it was started
 * from), or that holds several chats, names none of them.
 */
export async function listServices(sources: ServiceSources): Promise<ListeningService[]> {
  const proc = sources.proc ?? { root: "/proc", ticksPerSecond: 100 };
  const listening = await readListening(proc);
  const chats = sources.chats();
  const hosts = new Set(chats.map((chat) => chat.pid));
  const byHost = new Map(chats.map((chat) => [chat.pid, chat.threadId]));
  const unitOfPid = async (pid: number): Promise<string | null> => {
    const cgroup = await readFile(join(proc.root, String(pid), "cgroup"), "utf8").catch(() => null);
    return unitOf(cgroup?.match(/^0::(.*)$/m)?.[1] ?? null);
  };
  const ownUnit = await unitOfPid(sources.ownPid);
  const byUnit = new Map<string, ThreadId>();
  const sharedUnits = new Set<string>();
  for (const [chat, unit] of await Promise.all(
    chats.map(async (chat) => [chat, await unitOfPid(chat.pid)] as const),
  )) {
    if (unit === null || unit === ownUnit || !unit.startsWith("omp-app-chat-")) continue;
    if (byUnit.has(unit)) sharedUnits.add(unit);
    byUnit.set(unit, chat.threadId);
  }
  for (const unit of sharedUnits) byUnit.delete(unit);
  const own = sources.ownSocket;
  const neverShare = sources.neverShare ?? NEVER_SHARE_PROGRAMS;
  const services = new Map<number, ListeningService>();
  for (const socket of listening) {
    if (socket.pid === sources.ownPid || (socket.pid !== null && hosts.has(socket.pid))) continue;
    if (
      own(socket.address, socket.port) ||
      !REACHABLE_HERE.has(socket.address) ||
      services.has(socket.port)
    )
      continue;
    const unit = unitOf(socket.cgroup);
    const threadId =
      (unit === null ? undefined : byUnit.get(unit)) ??
      byHost.get(socket.ancestors.find((pid) => byHost.has(pid)) ?? -1) ??
      null;
    services.set(socket.port, {
      port: socket.port,
      address: socket.address,
      program: socket.program,
      command: socket.command,
      startedAt: socket.startedAt,
      threadId,
      neverShare: socket.program !== null && neverShare.has(socket.program),
    });
  }
  return [...services.values()].sort((left, right) => left.port - right.port);
}

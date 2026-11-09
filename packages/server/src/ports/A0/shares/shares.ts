import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  AppFailure,
  DEVICE_COOKIE,
  type FolderPath,
  type ListeningService,
  SHARE_IDLE_MS,
  type Share,
  type SharesList,
  SharesPort,
  type StreamKey,
  streamKey,
  type WorkspaceRelativePath,
} from "@omp-app/contracts";
import type { DevicePairing } from "../../../devices";
import type { Logger } from "../../../logging";
import type { PortHandlerContext, PortRegistration } from "../../../registry/ports";
import { type Gate, openGate } from "./gate";
import { listeningSignature } from "./listening";
import { type ChatHost, listServices } from "./services";

/**
 * A chat's service is shared by itself once it has listened this long, and a share ends once its service has been gone
 * this long (#2836): services that came and went every 2 s made and ended about 400 shares in 14 minutes, each a row
 * that appeared and vanished, and a share opened a moment after its service went had ended.
 */
export const SHARE_AFTER_MS = 5_000;
export const END_AFTER_MS = 10_000;

/**
 * The ports a debugger listens on unless told otherwise: Go's Delve (2345), Java's JDWP as most tools set it (5005),
 * Python's debugpy (5678), Chrome's remote debugging (9222) and Node's inspector (9229). Whoever reaches one runs code on
 * this machine, so a chat's debugger is never shared by itself; it can still be shared by hand.
 */
export const DEBUGGER_PORTS: ReadonlySet<number> = new Set([2345, 5005, 5678, 9222, 9229]);

/** The ports Linux hands out to a program that asks for any free one, as `/proc` gives them; else Linux's default. */
export function randomPortRange(proc = "/proc"): { readonly low: number; readonly high: number } {
  try {
    const [low, high] = readFileSync(join(proc, "sys/net/ipv4/ip_local_port_range"), "utf8")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (low !== undefined && high !== undefined && Number.isInteger(low) && Number.isInteger(high))
      return { low, high };
  } catch {
    // No such file: not Linux, or no /proc.
  }
  return { low: 32_768, high: 60_999 };
}

export interface SharesPortContext {
  readonly pairing: Pick<DevicePairing, "store" | "connections">;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  /** The chats' host processes: what one starts is that chat's. */
  readonly chats: () => readonly ChatHost[];
  /** The app server's own port: never a service. */
  readonly appPort: () => number | undefined;
  /** The machine's address that shares open at: by default its Tailscale address, when it has one. */
  readonly address?: () => string | null;
  readonly logger?: Logger;
  /** How often the listening sockets are looked at. */
  readonly pollMs?: number;
  readonly now?: () => number;
  /** For tests: the services and their signature, instead of the machine's. */
  readonly readServices?: () => Promise<ListeningService[]>;
  readonly signature?: () => Promise<string>;
  /** omp's statistics page, started when first asked (#2836 D6); absent: this server does not run it. */
  readonly stats?: { readonly start: () => Promise<number> };
  /** For tests: the range random ports are handed out of, instead of the machine's. */
  readonly randomPorts?: { readonly low: number; readonly high: number };
}

/** The machine's Tailscale address: an IPv4 address in 100.64.0.0/10. */
export function tailnetAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      const [first, second] = entry.address.split(".").map(Number);
      if (first === 100 && second !== undefined && second >= 64 && second <= 127)
        return entry.address;
    }
  }
  return null;
}

const failure = (
  code: "not_found" | "invalid_args" | "permission" | "unavailable",
  message: string,
) => new AppFailure({ code, message, retryable: false });

interface Held {
  readonly share: Share;
  readonly gate: Gate;
  /** The address the gate listens at: with its port, a socket of the app's own. */
  readonly address: string;
  /** A service's start, so a service stopped by hand is not shared again by itself while it runs. */
  readonly startedAt: number | null;
}

export interface SharesRuntime {
  readonly registration: PortRegistration;
  /** Looks at the listening sockets now (what the timer does). */
  poll(): Promise<void>;
  stop(): void;
}

/**
 * The services and pages open to the paired devices (#2788). A service a chat starts on a port someone picked (a dev
 * server's 3000, 5173, 8080) is shared by itself and the chat is told; one on a port the system handed out at random
 * (test servers, editors' and tools' own ports) or a debugger's is listed only, as any other service, and shared when
 * someone asks. A share ends when its service stops, when it is stopped, or after 12 hours unused; a device removed from
 * the paired devices loses its sessions on every share.
 */
export function createSharesRuntime(context: SharesPortContext): SharesRuntime {
  const now = context.now ?? Date.now;
  const address = context.address ?? tailnetAddress;
  const random = context.randomPorts ?? randomPortRange();
  /** A chat's service shared by itself: its port was picked, not handed out at random, and is no debugger's. */
  const opensByItself = (port: number): boolean =>
    !DEBUGGER_PORTS.has(port) && (port < random.low || port > random.high);
  const held = new Map<string, Held>();
  /** Services stopped by hand, by port and start: not shared again by themselves. */
  const stoppedByHand = new Set<string>();
  /** A chat's service not shared yet, by port and start: when it was first seen listening. */
  const firstSeen = new Map<string, number>();
  /** A service share whose service is not listening, by share: since when. */
  const goneSince = new Map<string, number>();
  const changed = streamKey(SharesPort.name, "changed");
  const sharedForChat = streamKey(SharesPort.name, "sharedForChat");
  const announce = () => context.publish(changed, { at: now() });
  /** The app's own sockets: its server's port, and each gate's address and port (a gate may take its service's number). */
  const ownSocket = (at: string, port: number): boolean =>
    port === context.appPort() ||
    [...held.values()].some((entry) => entry.address === at && entry.gate.port === port);
  const services = (): Promise<ListeningService[]> =>
    context.readServices?.() ??
    listServices({ chats: context.chats, ownPid: process.pid, ownSocket });
  const shown = (entry: Held): Share => ({
    ...entry.share,
    lastUsedAt: entry.gate.lastUsedAt(),
    openedBy: [...entry.gate.openedBy()],
  });
  const sharedPort = (port: number): Held | undefined =>
    [...held.values()].find((entry) => entry.share.kind === "service" && entry.share.port === port);
  const where = (): string => {
    const at = address();
    if (at === null)
      throw failure(
        "unavailable",
        "This machine has no address for shares: set OMP_APP_SHARE_ADDRESS to an address of it that your devices reach.",
      );
    return at;
  };

  const shareService = async (service: ListeningService, automatic: boolean): Promise<Held> => {
    const existing = sharedPort(service.port);
    if (existing !== undefined) return existing;
    const id = randomUUID();
    const at = where();
    const gate = await openGate({
      shareId: id,
      address: at,
      port: service.port,
      target: { kind: "service", port: service.port, address: service.address },
      reserved: [DEVICE_COOKIE],
      onOpened: announce,
      ...(context.logger === undefined ? {} : { logger: context.logger }),
      now,
    });
    const share: Share = {
      id,
      kind: "service",
      port: service.port,
      folder: null,
      path: null,
      url: gate.url,
      automatic,
      threadId: service.threadId,
      createdAt: now(),
      lastUsedAt: now(),
      openedBy: [],
    };
    const entry: Held = { share, gate, address: at, startedAt: service.startedAt };
    held.set(id, entry);
    context.logger?.info("share.created", {
      share: id,
      port: service.port,
      at_port: gate.port,
      program: service.program ?? "unknown",
      automatic: automatic ? 1 : 0,
    });
    announce();
    return entry;
  };

  const end = (id: string, reason: string): Held | undefined => {
    goneSince.delete(id);
    const entry = held.get(id);
    if (entry === undefined) return undefined;
    entry.gate.stop();
    held.delete(id);
    context.logger?.info("share.ended", { share: id, reason });
    announce();
    return entry;
  };

  let signature: string | null = null;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (const entry of [...held.values()])
        if (now() - entry.gate.lastUsedAt() > SHARE_IDLE_MS)
          end(entry.share.id, "unused for 12 hours");
      const next = await (context.signature?.() ?? listeningSignature());
      // The sockets as they were, and nothing waiting on its time: nothing to look at.
      const moved = next !== signature;
      if (!moved && firstSeen.size === 0 && goneSince.size === 0) return;
      signature = next;
      const listed = await services();
      const ports = new Set(listed.map((service) => service.port));
      for (const entry of [...held.values()]) {
        if (entry.share.kind !== "service" || entry.share.port === null) continue;
        if (ports.has(entry.share.port)) {
          goneSince.delete(entry.share.id);
          continue;
        }
        const since = goneSince.get(entry.share.id) ?? now();
        goneSince.set(entry.share.id, since);
        if (now() - since >= END_AFTER_MS) end(entry.share.id, "the service stopped");
      }
      const waiting = new Set<string>();
      for (const service of listed) {
        if (
          service.threadId === null ||
          service.neverShare ||
          !opensByItself(service.port) ||
          sharedPort(service.port) !== undefined
        )
          continue;
        const key = `${service.port}:${service.startedAt}`;
        if (stoppedByHand.has(key) || address() === null) continue;
        const since = firstSeen.get(key) ?? now();
        if (now() - since < SHARE_AFTER_MS) {
          firstSeen.set(key, since);
          waiting.add(key);
          continue;
        }
        firstSeen.delete(key);
        const entry = await shareService(service, true);
        context.publish(sharedForChat, {
          threadId: service.threadId,
          share: shown(entry),
          program: service.program,
        });
      }
      // A service gone before its time came is forgotten.
      for (const key of [...firstSeen.keys()]) if (!waiting.has(key)) firstSeen.delete(key);
      if (moved) announce();
    } catch (error) {
      context.logger?.warn("share.poll_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), context.pollMs ?? 2_000);
  const forgetRemoved = context.pairing.store.onRemoved((deviceId) => {
    for (const entry of held.values()) entry.gate.forget(deviceId);
  });

  const handlers = {
    list: async (): Promise<SharesList> => ({
      services: await services(),
      shares: [...held.values()].map(shown),
      address: address(),
    }),
    share: async (args: unknown): Promise<Share> => {
      const { port } = args as { port: number };
      const service = (await services()).find((candidate) => candidate.port === port);
      if (service === undefined) throw failure("not_found", `Nothing listens on port ${port} now.`);
      if (service.neverShare)
        throw failure(
          "permission",
          `${service.program ?? "This program"} on port ${port} is never shared: it is on the never-share list.`,
        );
      return shown(await shareService(service, false));
    },
    shareStats: async (): Promise<Share> => {
      const stats = context.stats;
      if (stats === undefined)
        throw failure("unavailable", "This app server does not run omp's statistics page.");
      const port = await stats.start().catch((error: unknown) => {
        throw failure("unavailable", error instanceof Error ? error.message : String(error));
      });
      // omp names its page as it starts listening; the machine's sockets show it a moment later.
      for (let tries = 0; tries < 20; tries += 1) {
        const service = (await services()).find((candidate) => candidate.port === port);
        if (service !== undefined) return shown(await shareService(service, false));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return shown(
        await shareService(
          {
            port,
            address: "127.0.0.1",
            program: "omp",
            command: "omp stats",
            startedAt: null,
            threadId: null,
            neverShare: false,
          },
          false,
        ),
      );
    },
    sharePage: async (args: unknown): Promise<Share> => {
      const { folder, path } = args as { folder: FolderPath; path: WorkspaceRelativePath };
      const asked = resolve(resolve(folder), path);
      if (!asked.startsWith(resolve(folder) + sep))
        throw failure("invalid_args", "That file is not in the folder.");
      // Real paths too: a folder link inside the chat's folder must not share a folder outside it.
      const root = await realpath(resolve(folder)).catch(() => null);
      const file = root === null ? null : await realpath(asked).catch(() => null);
      if (root === null || file === null) throw failure("not_found", "That file is not there.");
      if (!file.startsWith(root + sep))
        throw failure("invalid_args", "That file is not in the folder.");
      if (!/\.html?$/i.test(file))
        throw failure("invalid_args", "Only an HTML file opens as a page.");
      const found = await stat(file).catch(() => null);
      if (found === null || !found.isFile()) throw failure("not_found", "That file is not there.");
      const pageRoot = dirname(file);
      const entryFile = basename(file);
      const existing = [...held.values()].find(
        (entry) =>
          entry.share.kind === "page" &&
          entry.share.folder !== null &&
          entry.share.path !== null &&
          resolve(entry.share.folder, entry.share.path) === asked,
      );
      if (existing !== undefined) return shown(existing);
      const id = randomUUID();
      const at = where();
      const gate = await openGate({
        shareId: id,
        address: at,
        port: 0,
        target: { kind: "page", root: pageRoot, entry: entryFile },
        reserved: [DEVICE_COOKIE],
        onOpened: announce,
        ...(context.logger === undefined ? {} : { logger: context.logger }),
        now,
      });
      const share: Share = {
        id,
        kind: "page",
        port: null,
        folder,
        path,
        url: gate.url,
        automatic: false,
        threadId: null,
        createdAt: now(),
        lastUsedAt: now(),
        openedBy: [],
      };
      const entry: Held = { share, gate, address: at, startedAt: null };
      held.set(id, entry);
      context.logger?.info("share.created", { share: id, page: entryFile, at_port: gate.port });
      announce();
      return shown(entry);
    },
    open: (args: unknown, call: PortHandlerContext): { url: string } => {
      const { id } = args as { id: string };
      const entry = held.get(id);
      if (entry === undefined) throw failure("not_found", "That share has ended.");
      const deviceId = context.pairing.connections.deviceOf(call.connectionId);
      // Said in "Opened on …": a paired device by its name; the app's own computer and a device no longer listed as words.
      const name =
        deviceId === null
          ? "this computer"
          : (context.pairing.store.list().find((device) => device.id === deviceId)?.name ??
            "a paired device");
      return { url: entry.gate.ticket(deviceId, name) };
    },
    stop: (args: unknown): null => {
      const { id } = args as { id: string };
      const entry = end(id, "stopped");
      if (entry === undefined) throw failure("not_found", "That share has ended.");
      if (entry.share.port !== null) stoppedByHand.add(`${entry.share.port}:${entry.startedAt}`);
      return null;
    },
  };

  return {
    registration: { port: SharesPort, context, handlers },
    poll,
    stop() {
      clearInterval(timer);
      forgetRemoved();
      for (const entry of held.values()) entry.gate.stop();
      held.clear();
    },
  };
}

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
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

export interface SharesPortContext {
  readonly pairing: Pick<DevicePairing, "store" | "connections">;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  /** The chats' host processes: what one starts is that chat's. */
  readonly chats: () => readonly ChatHost[];
  /** The app server's own port: never a service. */
  readonly appPort: () => number | undefined;
  /** The machine's address on the private network shares open at; by default its Tailscale address. */
  readonly address?: () => string | null;
  readonly logger?: Logger;
  /** How often the listening sockets are looked at. */
  readonly pollMs?: number;
  readonly now?: () => number;
  /** For tests: the services and their signature, instead of the machine's. */
  readonly readServices?: () => Promise<ListeningService[]>;
  readonly signature?: () => Promise<string>;
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
 * The services and pages open to the paired devices (#2788). A service a chat starts is shared by itself and the chat is
 * told; any other is shared when someone asks. A share ends when its service stops, when it is stopped, or after 12 hours
 * unused; a device removed from the paired devices loses its sessions on every share.
 */
export function createSharesRuntime(context: SharesPortContext): SharesRuntime {
  const now = context.now ?? Date.now;
  const address = context.address ?? tailnetAddress;
  const held = new Map<string, Held>();
  /** Services stopped by hand, by port and start: not shared again by themselves. */
  const stoppedByHand = new Set<string>();
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
        "This machine has no address on a private network (Tailscale) for a share to open at.",
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
      if (next === signature) return;
      signature = next;
      const listed = await services();
      const ports = new Set(listed.map((service) => service.port));
      for (const entry of [...held.values()])
        if (
          entry.share.kind === "service" &&
          entry.share.port !== null &&
          !ports.has(entry.share.port)
        )
          end(entry.share.id, "the service stopped");
      for (const service of listed) {
        if (
          service.threadId === null ||
          service.neverShare ||
          sharedPort(service.port) !== undefined
        )
          continue;
        if (stoppedByHand.has(`${service.port}:${service.startedAt}`)) continue;
        if (address() === null) continue;
        const entry = await shareService(service, true);
        context.publish(sharedForChat, {
          threadId: service.threadId,
          share: shown(entry),
          program: service.program,
        });
      }
      announce();
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
    sharePage: async (args: unknown): Promise<Share> => {
      const { folder, path } = args as { folder: FolderPath; path: WorkspaceRelativePath };
      const root = resolve(folder);
      const file = resolve(root, path);
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
          resolve(entry.share.folder, entry.share.path) === file,
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

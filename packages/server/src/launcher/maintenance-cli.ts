/**
 * `omp-app maintenance`: what an omp update does to the running app, from a terminal. It holds the app's own work
 * (queued tasks, its continues after a usage limit), pauses and resumes chats, and reads each chat's omp. It signs in
 * as a page on this computer does: the launch token from the instance record, the app's own origin. It prints JSON.
 */
import { createAppClient, type WebSocketFactory, type WebSocketLike } from "@omp-app/client";
import {
  AppPort,
  type ChatHostsResult,
  ChatSessionPort,
  ThreadId,
  UPDATE_HOLD_MOST_MINUTES,
  type UpdateHoldState,
} from "@omp-app/contracts";

export type MaintenanceCommand =
  | { readonly action: "status" }
  | { readonly action: "hold"; readonly minutes: number; readonly reason: string }
  | { readonly action: "release" }
  | { readonly action: "pause" }
  | { readonly action: "resume"; readonly threadIds: readonly ThreadId[] };

export const MAINTENANCE_USAGE =
  "Use omp-app maintenance status, hold <minutes> <reason>, release, pause, or resume <chat id> [<chat id> ...].";

/** How long one call to the app may take before the command gives up. */
export const MAINTENANCE_CALL_MS = 30_000;

/** The command `omp-app maintenance <argv>` names, or why it names none. */
export function parseMaintenance(
  argv: readonly string[],
):
  | { readonly ok: true; readonly command: MaintenanceCommand }
  | { readonly ok: false; readonly message: string } {
  const [action, ...rest] = argv;
  if ((action === "status" || action === "release" || action === "pause") && rest.length === 0) {
    return { ok: true, command: { action } };
  }
  if (action === "hold") {
    const [minutesText = "", ...words] = rest;
    const minutes = /^[0-9]{1,4}$/.test(minutesText) ? Number(minutesText) : Number.NaN;
    const reason = words.join(" ").trim();
    if (
      !(minutes >= 1 && minutes <= UPDATE_HOLD_MOST_MINUTES) ||
      reason === "" ||
      reason.length > 200
    ) {
      return {
        ok: false,
        message: `Use omp-app maintenance hold <minutes, 1 to ${UPDATE_HOLD_MOST_MINUTES}> <reason, up to 200 characters>.`,
      };
    }
    return { ok: true, command: { action, minutes, reason } };
  }
  if (action === "resume") {
    const threadIds = rest.map((text) => ThreadId.safeParse(text));
    if (threadIds.length === 0 || threadIds.some((parsed) => !parsed.success)) {
      return {
        ok: false,
        message:
          "Use omp-app maintenance resume <chat id> [<chat id> ...]: it resumes only the chats named (maintenance status lists them).",
      };
    }
    return {
      ok: true,
      command: {
        action,
        threadIds: threadIds.flatMap((parsed) => (parsed.success ? [parsed.data] : [])),
      },
    };
  }
  return { ok: false, message: MAINTENANCE_USAGE };
}

/** What `status` prints: the server and its omp, its health, the update hold, and each running chat's host. */
export interface MaintenanceStatus {
  readonly server: {
    readonly version: string;
    /** New at each start of the server: an update sees from it that the install restarted the server. */
    readonly instanceId: string;
    readonly omp: string | null;
  };
  readonly health: string;
  readonly hold: UpdateHoldState;
  readonly chats: ChatHostsResult["chats"];
}

/** Bun's socket, sent with the app's own origin: the server takes a socket from its own pages' origin only. */
function socketWithOrigin(origin: string): WebSocketFactory {
  return (url, protocols) =>
    new WebSocket(url, {
      headers: { origin },
      ...(protocols === undefined ? {} : { protocols: [...protocols] }),
    }) as unknown as WebSocketLike;
}

/** Runs one command against the running app at `link` and gives back what it prints. */
export async function runMaintenance(
  command: MaintenanceCommand,
  link: { readonly origin: string; readonly token: string },
  options: { readonly callMs?: number } = {},
): Promise<
  MaintenanceStatus | UpdateHoldState | { readonly paused: number } | { readonly resumed: number }
> {
  const socketUrl = new URL("/ws", link.origin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const client = createAppClient({
    url: socketUrl.toString(),
    token: link.token,
    clientName: "omp-app maintenance",
    webSocketFactory: socketWithOrigin(link.origin),
  });
  const call = () => ({ signal: AbortSignal.timeout(options.callMs ?? MAINTENANCE_CALL_MS) });
  try {
    const chats = client.port(ChatSessionPort);
    switch (command.action) {
      case "status": {
        const app = client.port(AppPort);
        const [info, health, hold, hosts] = await Promise.all([
          app.serverInfo({}, call()),
          app.health({}, call()),
          chats.updateHold({}, call()),
          chats.chatHosts({}, call()),
        ]);
        return {
          server: {
            version: info.serverVersion,
            instanceId: info.instanceId,
            omp: info.omp?.version ?? null,
          },
          health: health.status,
          hold,
          chats: hosts.chats,
        };
      }
      case "hold":
        return await chats.setUpdateHold(
          { action: "hold", reason: command.reason, minutes: command.minutes },
          call(),
        );
      case "release":
        return await chats.setUpdateHold({ action: "release" }, call());
      case "pause":
        return { paused: (await chats.pauseAll({ paused: true }, call())).chats };
      case "resume":
        return {
          resumed: (
            await chats.pauseAll({ paused: false, threadIds: [...command.threadIds] }, call())
          ).chats,
        };
    }
  } finally {
    client.dispose();
  }
}

/**
 * Agent access on the server (#20): enrollment (`POST /devices/access/enroll`, with a one-time pairing code typed on
 * the machine) and each machine's access link (`/devices/access/link`, WebSocket). `openDeviceAccess` opens the store,
 * the history, the ssh files, the hub and the proxy socket together.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccessActivity,
  AccessEnroll,
  type AccessEnrolled,
  type AccessMachine,
  DEVICE_ACCESS_PATHS,
} from "@omp-app/contracts";
import type { Logger } from "../../logging";
import type { PairingDesk } from "../pairing";
import { ActivityLog } from "./activity";
import { AccessHub } from "./hub";
import { accessDataFolder, accessProxySocket, accessRuntimeFolder } from "./paths";
import { listenAccessProxy, socketAnswers } from "./proxy";
import { SshFiles } from "./ssh-files";
import { AccessStore } from "./store";

export interface DeviceAccessServer {
  readonly hub: AccessHub;
  readonly enroll: (body: unknown) => Promise<AccessEnrolled>;
}

export interface DeviceAccess extends DeviceAccessServer {
  readonly store: AccessStore;
  readonly activity: ActivityLog;
  readonly files: SshFiles;
  /** Stops the proxy socket. */
  stop(): void;
}

/** Opens agent access: the machines, their history, the ssh files and the proxy socket. */
export async function openDeviceAccess(options: {
  readonly appDataDir: string;
  readonly env: Record<string, string | undefined>;
  /** The address machines enroll with and sign into their answers (the app's https address). */
  readonly serverOrigin: string;
  readonly desk: PairingDesk;
  /** The program and arguments ssh runs before the alias: `omp-app device-ssh`. */
  readonly proxyCommand: readonly string[];
  /** The account sessions log in as on every machine (`omp-agent`). */
  readonly sessionAccount?: string;
  readonly threadOfScope: (scopeId: string) => string | null;
  /** A chat's name, as the chat list shows it (PLAN §7f); null when unknown. */
  readonly chatName?: (threadId: string) => Promise<string | null>;
  readonly onMachinesChanged: (machines: AccessMachine[]) => void;
  readonly onActivity: (activity: AccessActivity) => void;
  /** Puts a notice into a chat (agent access given, taken away or denied; a folder request answered). */
  readonly notify?: (threadId: string, text: string) => void;
  readonly logger?: Logger;
  /** The host names the server account's ssh already knows (`hostsInSshConfig`), replaced in tests. */
  readonly knownHosts?: () => Promise<ReadonlySet<string>>;
}): Promise<DeviceAccess> {
  const data = accessDataFolder(options.appDataDir);
  const runtime = accessRuntimeFolder(options.env, options.appDataDir);
  // Another server of this account holds agent access in this folder: its socket and ssh files stay its own.
  if (await socketAnswers(accessProxySocket(runtime))) {
    throw new Error(
      `another omp-app server of this account runs agent access in ${runtime}; this one runs without it`,
    );
  }
  const store = await AccessStore.open({
    folder: data,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const activity = await ActivityLog.open(
    join(data, "activity"),
    store.list().map((machine) => machine.id),
  );
  const files = new SshFiles(runtime, options.proxyCommand, options.sessionAccount);
  const hub = await AccessHub.open({
    store,
    activity,
    files,
    serverOrigin: options.serverOrigin,
    threadOfScope: options.threadOfScope,
    ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
    onMachinesChanged: options.onMachinesChanged,
    onActivity: options.onActivity,
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const stopProxy = await listenAccessProxy(accessProxySocket(runtime), hub, options.logger);
  const enroll = async (body: unknown): Promise<AccessEnrolled> => {
    const parsed = AccessEnroll.safeParse(body);
    if (!parsed.success) return { status: "refused", reason: "code" };
    // An alias the server account's ssh already names would take `ssh <alias>` from the host it means. Checked before
    // the code is used, so a refused alias does not spend it.
    const known = await (options.knownHosts ?? (() => hostsInSshConfig(options.env.HOME)))();
    if (known.has(parsed.data.alias)) return { status: "refused", reason: "alias-taken" };
    const code = options.desk.enterCode(parsed.data.code);
    if (code.status !== "ok") return { status: "refused", reason: "code" };
    const made = await store.enroll({
      alias: parsed.data.alias,
      identityKey: parsed.data.identityKey,
      hostKey: parsed.data.hostKey,
    });
    if (made.status !== "enrolled") return { status: "refused", reason: made.status };
    options.logger?.info("device_access.enrolled", { machine: made.machine.alias });
    return { status: "enrolled", machineId: made.machine.id };
  };
  return { hub, enroll, store, activity, files, stop: stopProxy };
}

/**
 * The host names written out in the server account's ssh config and the system's (`Host` lines; patterns with `*`, `?`
 * or `!` are not names). Included files are not followed.
 */
export async function hostsInSshConfig(home: string | undefined): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const files = [
    ...(home === undefined ? [] : [join(home, ".ssh", "config")]),
    "/etc/ssh/ssh_config",
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const match = /^\s*host\s*(?:=|\s)\s*(.+)$/i.exec(line);
      if (match === null) continue;
      for (const name of (match[1] ?? "").split(/\s+/))
        if (name !== "" && !/[*?!]/.test(name)) names.add(name.replace(/^"|"$/g, ""));
    }
  }
  return names;
}

/** The enrollment route and the link's upgrade; undefined for any other path. */
export async function deviceAccessRoute(
  request: Request,
  url: URL,
  access: DeviceAccessServer,
  helpers: {
    readonly hostAllowed: (request: Request) => boolean;
    readonly upgrade: (request: Request) => boolean;
  },
): Promise<Response | "upgraded" | undefined> {
  if (url.pathname !== DEVICE_ACCESS_PATHS.enroll && url.pathname !== DEVICE_ACCESS_PATHS.link)
    return undefined;
  if (!helpers.hostAllowed(request)) return new Response("Host not allowed", { status: 403 });
  if (url.pathname === DEVICE_ACCESS_PATHS.link) {
    return helpers.upgrade(request)
      ? "upgraded"
      : new Response("WebSocket upgrade required", { status: 426 });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: "refused", reason: "code" } satisfies AccessEnrolled, {
      status: 400,
    });
  }
  return Response.json(await access.enroll(body));
}

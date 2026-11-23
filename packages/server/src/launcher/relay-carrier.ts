/**
 * `omp-app relay <app address>`: the user's own browser for the app's chats, from the computer that browser runs on.
 * omp's relay extension connects only to `ws://127.0.0.1:<port>/ext` on its own computer; this listens there and
 * carries each connection to the app's server (`/browser-relay`) over the app's own address, as a paired device, so no
 * tunnel to the app's computer is needed. The server joins it to its relay, which takes the extension only that way.
 *
 * It pairs once with a one-time code and keeps its key in the state folder (owner-only), one per app address; the
 * device shows in Settings → App → Devices as "Browser relay on <computer>", where Remove ends it.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PAIRING_PATHS,
  PairingCodeEntered,
  SOCKET_DEVICE_PROTOCOL_PREFIX,
  SOCKET_PROTOCOL,
} from "@omp-app/contracts";
import { z } from "zod";

/** Each app address this computer's carrier paired with, and its key there. */
const Keys = z.record(z.string(), z.strictObject({ deviceId: z.string(), key: z.string() }));
type Keys = z.infer<typeof Keys>;

async function readKeys(file: string): Promise<Keys> {
  try {
    return Keys.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return {};
  }
}

async function writeKeys(file: string, keys: Keys): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Pairs with the app at `server` with a one-time code: its key, or why not in plain words. */
export async function pairRelay(
  server: string,
  code: string,
  name: string,
): Promise<{ readonly deviceId: string; readonly key: string } | string> {
  let answer: Response;
  try {
    answer = await fetch(`${server}${PAIRING_PATHS.code}`, {
      method: "POST",
      // The app takes pairing only from its own pages; a program names the app's address as its page's.
      headers: { "content-type": "application/json", origin: server },
      body: JSON.stringify({ code, name, kind: "browser-relay", keep: "host" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return `the app at ${server} did not answer (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!answer.ok) return `the app at ${server} refused to pair (HTTP ${answer.status})`;
  const parsed = PairingCodeEntered.safeParse(await answer.json().catch(() => null));
  if (!parsed.success) return `the app at ${server} answered something else`;
  const result = parsed.data;
  if (result.status === "wrong") return `that code is not right (${result.triesLeft} tries left)`;
  if (result.status === "expired") return "no code works now: make a new one and run this again";
  if (result.key === undefined) return "the app paired but gave no key";
  return { deviceId: result.deviceId, key: result.key };
}

export interface RelayCarrierOptions {
  /** The app's address, as an origin. */
  readonly server: string;
  /** Where omp's relay extension connects on this computer. */
  readonly port: number;
  /** The keys file (`<state folder>/relay-keys.json`). */
  readonly keysFile: string;
  /** The name this carrier pairs under. */
  readonly name: string;
  /** A one-time code, or how to ask for one when this computer is not paired with that address yet. */
  readonly code: string | undefined;
  readonly askCode: () => Promise<string>;
  readonly say: (line: string) => void;
}

/** A running carrier: `done` settles when it stops for good (its key removed, or `stop`). */
export interface RelayCarrier {
  readonly port: number;
  readonly done: Promise<string>;
  stop(): void;
}

interface CarriedData {
  upstream: WebSocket | null;
  waiting: (string | Uint8Array)[];
}

/** Pairs if needed, then carries the extension's connections until stopped; why it could not start, or the carrier. */
export async function startRelayCarrier(
  options: RelayCarrierOptions,
): Promise<RelayCarrier | string> {
  const keys = await readKeys(options.keysFile);
  let paired = keys[options.server];
  if (paired === undefined) {
    const code = options.code ?? (await options.askCode());
    const made = await pairRelay(options.server, code.trim(), options.name);
    if (typeof made === "string") return `Not paired: ${made}.`;
    paired = made;
    await writeKeys(options.keysFile, { ...keys, [options.server]: made });
    options.say(`Paired with ${options.server} as "${options.name}" (Settings → App → Devices).`);
  }
  const key = paired.key;
  const upstreamUrl = `${options.server.replace(/^http/, "ws")}/browser-relay`;
  let finish: (why: string) => void = () => undefined;
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let listener: ReturnType<typeof Bun.serve<CarriedData, never>>;
  try {
    listener = Bun.serve<CarriedData, never>({
      hostname: "127.0.0.1",
      port: options.port,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname !== "/ext") return new Response("Not found", { status: 404 });
        // Only a browser extension's socket: a web page names its own address as its origin, and is refused.
        const origin = request.headers.get("origin");
        if (origin === null || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
          return new Response("Forbidden", { status: 403 });
        }
        return server.upgrade(request, { data: { upstream: null, waiting: [] } })
          ? undefined
          : new Response("WebSocket upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          const upstream = new WebSocket(upstreamUrl, {
            headers: { Origin: options.server },
            protocols: [SOCKET_PROTOCOL, `${SOCKET_DEVICE_PROTOCOL_PREFIX}${key}`],
          } as unknown as string[]);
          upstream.binaryType = "arraybuffer";
          socket.data.upstream = upstream;
          upstream.onopen = () => {
            for (const data of socket.data.waiting.splice(0)) upstream.send(data);
            options.say("The browser's extension is connected to the app.");
          };
          upstream.onmessage = (event) =>
            socket.send(
              typeof event.data === "string"
                ? event.data
                : new Uint8Array(event.data as ArrayBuffer),
            );
          upstream.onclose = (event) => {
            if (event.code === 4401) {
              finish(
                "This computer's browser relay is no longer paired with the app (removed in Settings → App → Devices). Run it again with a new code.",
              );
            } else if (event.code === 4409) {
              options.say(`The app turned the extension away: ${event.reason}`);
            }
            socket.close(1000, "the app closed the connection");
          };
          upstream.onerror = () => socket.close(1011, "the app could not be reached");
        },
        message(socket, message) {
          const data = typeof message === "string" ? message : new Uint8Array(message);
          const upstream = socket.data.upstream;
          if (upstream !== null && upstream.readyState === WebSocket.OPEN) upstream.send(data);
          else socket.data.waiting.push(data);
        },
        close(socket) {
          const upstream = socket.data.upstream;
          if (upstream !== null && upstream.readyState <= WebSocket.OPEN) upstream.close(1000);
        },
      },
    });
  } catch {
    return `Port ${options.port} on 127.0.0.1 is taken: another relay runs on this computer (omp's own, or another carrier). Stop it, or give --port and the same port in the extension's options.`;
  }
  done.then(async (why) => {
    listener.stop(true);
    if (why.startsWith("This computer's browser relay is no longer paired")) {
      const now = await readKeys(options.keysFile);
      delete now[options.server];
      await writeKeys(options.keysFile, now);
    }
  });
  return {
    port: listener.port as number,
    done,
    stop: () => finish("stopped"),
  };
}

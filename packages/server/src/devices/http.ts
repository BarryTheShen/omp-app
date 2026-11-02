/**
 * The pairing routes (`PAIRING_PATHS`). Three are for a device with no key yet, which has no connection: they take the
 * app's own pages only (the WebSocket's Host and Origin check). Three are for `omp-app pair` and `omp-app devices` on
 * the server: they take the launch token as a bearer, on the loopback address only. One turns a page signed in with the
 * launch link at the Tailscale address into a paired device: the token as a bearer, from that page only.
 */
import {
  type DeviceList,
  PAIRING_PATHS,
  type PairingAdopted,
  PairingAsk,
  type PairingAsked,
  PairingClaim,
  type PairingClaimed,
  type PairingCode,
  type PairingCodeEntered,
  PairingCodeEntry,
} from "@omp-app/contracts";
import { z } from "zod";
import type { Logger } from "../logging";
import { deviceCookie } from "./cookie";
import type { DevicePairing } from "./index";

/** A pairing request's body is small: more is refused. */
const BODY_BYTES_MAX = 4096;

export interface PairingRouteOptions {
  readonly pairing: DevicePairing;
  /** The request comes from one of the app's own pages: its Host and Origin are the app's. */
  readonly fromAppPage: (request: Request) => boolean;
  /** The request comes to the server's loopback address, from no web page. */
  readonly fromThisComputer: (request: Request) => boolean;
  /** The request comes from the app's page at its Tailscale address (not a page on this computer). */
  readonly fromRemotePage: (request: Request) => boolean;
  /** The paired device whose key the request's cookie carries; undefined when none. */
  readonly deviceOf: (request: Request) => string | undefined;
  /** The request came over HTTPS (the Tailscale address), so the key's cookie is Secure. */
  readonly overHttps: (request: Request) => boolean;
  /** Checks a bearer against the launch token. */
  readonly isLaunchToken: (candidate: string) => boolean;
  /** What to open on a new device. */
  readonly address: () => string;
  readonly logger?: Logger;
}

const NO_STORE = { "Cache-Control": "no-store", "Content-Type": "application/json" } as const;

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...NO_STORE, ...headers } });
}

const refused = (status: number, error: string): Response => json(status, { error });

/** The request's JSON body, checked; a Response when it is too large, not JSON or not the expected shape. */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  if (Number(request.headers.get("content-length") ?? "0") > BODY_BYTES_MAX)
    return refused(413, "Too large");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return refused(400, "Unreadable");
  }
  if (text.length > BODY_BYTES_MAX) return refused(413, "Too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refused(400, "Not JSON");
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : refused(400, "Unexpected request");
}

function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

const RemoveArgs = z.object({ deviceId: z.string().min(1) }).strict();

/** Answers a `/pair/…` request; undefined for any other path. */
export async function pairingRoute(
  request: Request,
  url: URL,
  options: PairingRouteOptions,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/pair/")) return undefined;
  const { store, desk } = options.pairing;
  const pair = async (
    name: string,
    kind: PairingAsk["kind"],
    via: string,
  ): Promise<{ deviceId: string; cookie: string } | Response> => {
    try {
      const { device, key } = await store.add(name, kind);
      options.logger?.info("device.paired", { via, kind, device: device.id.slice(0, 8) });
      return { deviceId: device.id, cookie: deviceCookie(key, options.overHttps(request)) };
    } catch {
      return refused(500, "The device could not be saved.");
    }
  };
  const list = (): DeviceList => ({ devices: store.list(), requests: desk.waiting() });

  switch (url.pathname) {
    case PAIRING_PATHS.ask:
    case PAIRING_PATHS.claim:
    case PAIRING_PATHS.code: {
      if (request.method !== "POST") return refused(405, "Method not allowed");
      if (!options.fromAppPage(request)) return refused(403, "Not this app's page");
      if (url.pathname === PAIRING_PATHS.ask) {
        const ask = await bodyOf(request, PairingAsk);
        if (ask instanceof Response) return ask;
        const asked = desk.ask(ask.name, ask.kind);
        if (asked === "busy")
          return refused(429, "Too many devices are asking to pair. Try again in a few minutes.");
        options.logger?.info("device.pairing_asked", { kind: ask.kind });
        return json(200, asked satisfies PairingAsked);
      }
      if (url.pathname === PAIRING_PATHS.claim) {
        const claim = await bodyOf(request, PairingClaim);
        if (claim instanceof Response) return claim;
        const result = desk.claim(claim.requestId);
        if (result.status !== "allowed") return json(200, result satisfies PairingClaimed);
        const paired = await pair(result.name, result.kind, "allow");
        if (paired instanceof Response) return paired;
        return json(200, { status: "paired", deviceId: paired.deviceId } satisfies PairingClaimed, {
          "Set-Cookie": paired.cookie,
        });
      }
      const entry = await bodyOf(request, PairingCodeEntry);
      if (entry instanceof Response) return entry;
      const result = desk.enterCode(entry.code);
      if (result.status === "wrong") {
        options.logger?.warn("device.pairing_code_wrong", { tries_left: result.triesLeft });
        return json(200, result satisfies PairingCodeEntered);
      }
      if (result.status === "expired") return json(200, result satisfies PairingCodeEntered);
      const paired = await pair(entry.name, entry.kind, "code");
      if (paired instanceof Response) return paired;
      return json(
        200,
        { status: "paired", deviceId: paired.deviceId } satisfies PairingCodeEntered,
        {
          "Set-Cookie": paired.cookie,
        },
      );
    }
    case PAIRING_PATHS.newCode:
    case PAIRING_PATHS.devices:
    case PAIRING_PATHS.remove: {
      if (!options.fromThisComputer(request)) return refused(403, "Only on the app's own computer");
      const bearer = bearerOf(request);
      if (bearer === undefined || !options.isLaunchToken(bearer))
        return refused(401, "The app's launch token is needed");
      if (url.pathname === PAIRING_PATHS.devices) {
        if (request.method !== "GET") return refused(405, "Method not allowed");
        return json(200, list());
      }
      if (request.method !== "POST") return refused(405, "Method not allowed");
      if (url.pathname === PAIRING_PATHS.newCode) {
        const made = desk.newCode();
        return json(200, {
          code: made.code,
          expiresAt: new Date(made.expiresAt).toISOString(),
          address: options.address(),
        } satisfies PairingCode);
      }
      const args = await bodyOf(request, RemoveArgs);
      if (args instanceof Response) return args;
      try {
        if (!(await store.remove(args.deviceId))) return refused(404, "No such device");
      } catch {
        return refused(500, "The device list could not be saved.");
      }
      return json(200, list());
    }
    case PAIRING_PATHS.adopt: {
      if (request.method !== "POST") return refused(405, "Method not allowed");
      // Pages on this computer keep signing in with the launch link: they are not devices.
      if (!options.fromRemotePage(request))
        return refused(403, "Only the app's page at its Tailscale address");
      const bearer = bearerOf(request);
      if (bearer === undefined || !options.isLaunchToken(bearer))
        return refused(401, "The app's launch token is needed");
      const already = options.deviceOf(request);
      if (already !== undefined) return json(200, { deviceId: already } satisfies PairingAdopted);
      const adopt = await bodyOf(request, PairingAsk);
      if (adopt instanceof Response) return adopt;
      const paired = await pair(adopt.name, adopt.kind, "link");
      if (paired instanceof Response) return paired;
      return json(200, { deviceId: paired.deviceId } satisfies PairingAdopted, {
        "Set-Cookie": paired.cookie,
      });
    }
    default:
      return refused(404, "Not found");
  }
}

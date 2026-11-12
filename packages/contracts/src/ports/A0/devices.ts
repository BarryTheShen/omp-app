/**
 * Paired devices: each device the app is opened on has a key of its own, given once when it pairs and kept by the
 * device in a cookie its page cannot read. A device pairs either when a device already paired allows it (both show the
 * same 6 digits), or with a one-time code made on a paired device or by `omp-app pair` on the server.
 *
 * The `A0.devices` port is for paired devices; the `/pair/*` routes (`PAIRING_PATHS`) are for a device that is not
 * paired yet, which has no connection.
 */
import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";

/** What a device is, as its pairing screen tells it. */
export const DeviceKind = z.enum(["home-screen-app", "desktop-window", "browser"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** The name a device is listed under, chosen when it pairs and changed in Settings → Devices. */
export const DeviceName = z.string().trim().min(1).max(60);
export type DeviceName = z.infer<typeof DeviceName>;

/** The cookie that carries a paired device's key: set by the server, never readable by the page (HttpOnly). */
export const DEVICE_COOKIE = "omp-app-device";

/** A device key: 32 random bytes in base64url (43 characters). Anything else signs nothing in. */
export const DEVICE_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * How a panel in another app's frame, which no cookie of the app reaches, signs in: its WebSocket offers
 * `SOCKET_PROTOCOL`, then `SOCKET_DEVICE_PROTOCOL_PREFIX` followed by its key. So the key travels in the handshake's
 * `Sec-WebSocket-Protocol` header, not in the address, where a proxy may log it. The server names `SOCKET_PROTOCOL` back.
 * A key is base64url (`DEVICE_KEY_SHAPE`), which a protocol (a token) carries as is; a page offers nothing else there,
 * since the browser refuses a protocol with any other character.
 */
export const SOCKET_PROTOCOL = "omp-app";
export const SOCKET_DEVICE_PROTOCOL_PREFIX = "omp-app.device.";

/** A device's request is answered within this time, or it ends. */
export const PAIRING_REQUEST_MS = 5 * 60_000;
/** A one-time code works once, within this time. */
export const PAIRING_CODE_MS = 10 * 60_000;
/** Wrong entries a one-time code takes before it stops working. */
export const PAIRING_CODE_TRIES = 5;

/** A one-time code: 8 letters and digits without look-alikes (no I, O, 0, 1), shown as two groups of 4. */
export const PairingCodeText = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/);

/** Writes a one-time code as it is shown and typed: `K7F3-QX9M`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A code as typed: upper case, without the dash or spaces. */
export function normalizePairingCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * What a pairing QR code opens: the app's page with the one-time code in the address's fragment (`#pair=`), which the
 * browser keeps to itself; the page reads it and pairs.
 */
export function pairingLink(address: string, code: string): string {
  return `${address.replace(/\/+$/, "")}/#pair=${code}`;
}

export const PairedDevice = z
  .object({
    id: z.string().min(1),
    name: DeviceName,
    kind: DeviceKind,
    /** ISO time it paired. */
    pairedAt: z.string(),
    /** ISO time it last connected; null before its first connection. */
    lastSeenAt: z.string().nullable(),
  })
  .strict();
export type PairedDevice = z.infer<typeof PairedDevice>;

/** A device that asked to pair and waits for a paired device to allow it. */
export const PairingRequest = z
  .object({
    id: z.string().min(1),
    name: DeviceName,
    kind: DeviceKind,
    /** The 6 digits the asking device shows: allow it only when they match. */
    code: z.string().regex(/^\d{6}$/),
    requestedAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type PairingRequest = z.infer<typeof PairingRequest>;

/** The paired devices and the requests waiting, as every paired page hears them change. */
export const DeviceList = z
  .object({
    devices: z.array(PairedDevice),
    requests: z.array(PairingRequest),
  })
  .strict();
export type DeviceList = z.infer<typeof DeviceList>;

/** The list, and which device is the one asking. */
export const DeviceOverview = DeviceList.extend({
  /** This connection's device; null when it signed in with the launch link. */
  thisDeviceId: z.string().nullable(),
}).strict();
export type DeviceOverview = z.infer<typeof DeviceOverview>;

/** A one-time code, and the address to open on the new device. */
export const PairingCode = z
  .object({ code: PairingCodeText, expiresAt: z.string(), address: z.string() })
  .strict();
export type PairingCode = z.infer<typeof PairingCode>;

const EmptyArgs = z.object({}).strict();
const DeviceIdArgs = z.object({ deviceId: z.string().min(1) }).strict();
const RequestIdArgs = z.object({ requestId: z.string().min(1) }).strict();

export const DevicesPort = definePort({
  name: "A0.devices",
  methods: {
    list: { args: EmptyArgs, result: DeviceOverview },
    rename: {
      args: z.object({ deviceId: z.string().min(1), name: DeviceName }).strict(),
      result: DeviceOverview,
    },
    /** The device's key stops working at once, and its open pages are disconnected. */
    remove: { args: DeviceIdArgs, result: DeviceOverview },
    allow: { args: RequestIdArgs, result: DeviceOverview },
    deny: { args: RequestIdArgs, result: DeviceOverview },
    /** A one-time code for a new device; it replaces the one made before. */
    newCode: { args: EmptyArgs, result: PairingCode },
  },
  events: {
    changed: { payload: DeviceList },
  },
});
export type DevicesPort = typeof DevicesPort;
export type DevicesClient = PortClient<DevicesPort>;
export type DevicesHandlers<Context> = PortHandlers<DevicesPort, Context>;

/** The pairing routes, for a device with no key yet (and `omp-app pair` on the server). */
export const PAIRING_PATHS = {
  /** POST `PairingAsk` → `PairingAsked`: ask the paired devices to allow this one. */
  ask: "/pair/ask",
  /** POST `PairingClaim` → `PairingClaimed`: whether the request was allowed; when it was, the key comes as a cookie. */
  claim: "/pair/claim",
  /** POST `PairingCodeEntry` → `PairingCodeEntered`: pair with a one-time code; the key comes as a cookie. */
  code: "/pair/code",
  /** POST, the launch token as a bearer, on the server only → `PairingCode` (`omp-app pair`). */
  newCode: "/pair/new-code",
  /** GET, the launch token as a bearer, on the server only → `DeviceList` (`omp-app devices`). */
  devices: "/pair/devices",
  /** POST `{ deviceId }`, the launch token as a bearer, on the server only → `DeviceList` (`omp-app devices remove`). */
  remove: "/pair/remove",
  /** POST, no body → `PairingMachine`: the computer the page is on, to suggest the new device's name. */
  machine: "/pair/machine",
} as const;

export const PairingAsk = z.object({ name: DeviceName, kind: DeviceKind }).strict();
export type PairingAsk = z.infer<typeof PairingAsk>;

export const PairingAsked = z
  .object({
    /** The request's secret: only the device that asked knows it, and only it can collect the key. */
    requestId: z.string().min(1),
    code: z.string().regex(/^\d{6}$/),
    expiresAt: z.string(),
  })
  .strict();
export type PairingAsked = z.infer<typeof PairingAsked>;

/**
 * The name of the computer a pairing page is on, as Tailscale knows it; the server's own name for a page on the server's
 * computer; null when neither is known. The pairing screen suggests it in the new device's name ("Firefox on my-laptop").
 */
export const PairingMachine = z.strictObject({ machine: z.string().nullable() });
export type PairingMachine = z.infer<typeof PairingMachine>;

/**
 * A panel framed by another app (an extension's, an editor's) cannot keep the key's cookie: the browser keeps no
 * cookie of the app in someone else's frame. With `keep: "host"`, the answer that pairs also gives the key, which the
 * page hands to its host (the embed protocol's `credential`); the host gives it back at each load, and the page signs in
 * with it.
 */
const KeepWithHost = z.literal("host");

export const PairingClaim = z
  .object({ requestId: z.string().min(1), keep: KeepWithHost.optional() })
  .strict();
export type PairingClaim = z.infer<typeof PairingClaim>;

/** The key, only when the request asked to keep it with a host. */
const PairedKey = z.string().min(1).optional();

export const PairingClaimed = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting") }).strict(),
  z.object({ status: z.literal("paired"), deviceId: z.string().min(1), key: PairedKey }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
]);
export type PairingClaimed = z.infer<typeof PairingClaimed>;

export const PairingCodeEntry = z
  .object({
    code: z.string().min(1).max(20),
    name: DeviceName,
    kind: DeviceKind,
    keep: KeepWithHost.optional(),
  })
  .strict();
export type PairingCodeEntry = z.infer<typeof PairingCodeEntry>;

export const PairingCodeEntered = z.discriminatedUnion("status", [
  z.object({ status: z.literal("paired"), deviceId: z.string().min(1), key: PairedKey }).strict(),
  z.object({ status: z.literal("wrong"), triesLeft: z.number().int().min(0) }).strict(),
  /** No code works now: none was made, it was used, it ran out of time or of tries. */
  z.object({ status: z.literal("expired") }).strict(),
]);
export type PairingCodeEntered = z.infer<typeof PairingCodeEntered>;

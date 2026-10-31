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
  /**
   * POST `PairingAsk`, the launch token as a bearer, from the app's page at its Tailscale address → `PairingAdopted`: a
   * page signed in with the launch link becomes a paired device (it keeps its key if it is one already); the key comes
   * as a cookie.
   */
  adopt: "/pair/adopt",
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

export const PairingClaim = z.object({ requestId: z.string().min(1) }).strict();
export type PairingClaim = z.infer<typeof PairingClaim>;

export const PairingClaimed = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting") }).strict(),
  z.object({ status: z.literal("paired"), deviceId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
]);
export type PairingClaimed = z.infer<typeof PairingClaimed>;

export const PairingCodeEntry = z
  .object({ code: z.string().min(1).max(20), name: DeviceName, kind: DeviceKind })
  .strict();
export type PairingCodeEntry = z.infer<typeof PairingCodeEntry>;

export const PairingCodeEntered = z.discriminatedUnion("status", [
  z.object({ status: z.literal("paired"), deviceId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("wrong"), triesLeft: z.number().int().min(0) }).strict(),
  /** No code works now: none was made, it was used, it ran out of time or of tries. */
  z.object({ status: z.literal("expired") }).strict(),
]);
export type PairingCodeEntered = z.infer<typeof PairingCodeEntered>;

export const PairingAdopted = z.object({ deviceId: z.string().min(1) }).strict();
export type PairingAdopted = z.infer<typeof PairingAdopted>;

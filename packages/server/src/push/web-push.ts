/**
 * Web Push from the app's server to a device's push service (Apple's for an iPhone's Home Screen app, Mozilla's,
 * Google's): the message encrypted for the device (RFC 8291, `aes128gcm`) and the server's signed identity (VAPID,
 * RFC 8292), with Node's own crypto. A device subscribes in the page (`PushManager.subscribe` with this server's public
 * key) and gives the server its endpoint and keys; a push is one POST to that endpoint.
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";

/** A device's subscription as `PushSubscription.toJSON()` gives it. */
export interface PushTarget {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** The server's VAPID key pair: the private key as PKCS#8 PEM, the public key raw (65 bytes) in base64url. */
export interface VapidKeys {
  readonly privatePem: string;
  readonly publicKey: string;
}

export function newVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: rawPublicKey(publicKey.export({ format: "jwk" }) as { x: string; y: string }),
  };
}

function rawPublicKey(jwk: { readonly x: string; readonly y: string }): string {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 8291 §3.4: the message encrypted for the device, one record, with its header (salt, record size, sender key). */
export function encryptForDevice(
  payload: Buffer,
  target: PushTarget,
  sender: { readonly ecdh?: ReturnType<typeof createECDH>; readonly salt?: Buffer } = {},
): Buffer {
  const uaPublic = Buffer.from(target.keys.p256dh, "base64url");
  const authSecret = Buffer.from(target.keys.auth, "base64url");
  const ecdh = sender.ecdh ?? createECDH("prime256v1");
  if (sender.ecdh === undefined) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const salt = sender.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // One record: the payload and the last-record delimiter (2).
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
    body,
    cipher.getAuthTag(),
  ]);
}

/** RFC 8292: `vapid t=<JWT signed ES256>, k=<public key>` for the push service at `endpoint`. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: Date,
): string {
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      // Apple refuses an expiry more than a day ahead: 12 hours.
      exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
      sub: subject,
    }),
  ).toString("base64url");
  const key: KeyObject = createPrivateKey(keys.privatePem);
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `vapid t=${header}.${claims}.${signature}, k=${keys.publicKey}`;
}

export interface PushRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** The POST that delivers `payload` (at most 4 KB once encrypted, Apple's limit) to one device. */
export function pushRequest(
  target: PushTarget,
  payload: string,
  keys: VapidKeys,
  options: {
    readonly subject: string;
    readonly now: Date;
    readonly ttlSeconds?: number;
    readonly urgency?: "very-low" | "low" | "normal" | "high";
    /** Coalesces pushes with the same topic (at most 32 base64url characters). */
    readonly topic?: string;
  },
): PushRequest {
  const body = encryptForDevice(Buffer.from(payload, "utf8"), target);
  if (body.length > 4096) throw new Error("A push message is at most 4 KB.");
  return {
    url: target.endpoint,
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttlSeconds ?? 24 * 3600),
      urgency: options.urgency ?? "high",
      authorization: vapidAuthorization(target.endpoint, keys, options.subject, options.now),
      ...(options.topic === undefined ? {} : { topic: options.topic }),
    },
    body,
  };
}

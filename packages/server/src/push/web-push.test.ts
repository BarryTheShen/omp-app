import { expect, test } from "bun:test";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { newVapidKeys, pushRequest } from "./web-push";

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

/** A device: its key pair and auth secret, and its own decryption of a push body (RFC 8291 §3.4, the receiver's side). */
function device() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const target = {
    endpoint: "https://web.push.apple.com/QA1b2c3",
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
  };
  const decrypt = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    const idLength = body[20] ?? 0;
    const asPublic = body.subarray(21, 21 + idLength);
    const cipherText = body.subarray(21 + idLength);
    const prkKey = hmac(auth, ecdh.computeSecret(asPublic));
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(cipherText.subarray(-16));
    const plain = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
    expect(plain.at(-1)).toBe(2);
    return plain.subarray(0, -1).toString("utf8");
  };
  return { target, decrypt };
}

test("a push is encrypted so only the device reads it, and carries the server's identity the push service checks", () => {
  const keys = newVapidKeys();
  const phone = device();
  const message = JSON.stringify({ title: "A question waits", chat: "01a18633" });
  const now = new Date("2026-11-20T23:00:00Z");
  const request = pushRequest(phone.target, message, keys, {
    subject: "https://github.com/BarryTheShen/omp-app",
    now,
    topic: "chat-01a18633",
  });
  expect(request.url).toBe(phone.target.endpoint);
  expect(request.headers).toMatchObject({
    "content-encoding": "aes128gcm",
    urgency: "high",
    ttl: "86400",
    topic: "chat-01a18633",
  });
  expect(phone.decrypt(request.body)).toBe(message);
  // Another device cannot read it.
  expect(() => device().decrypt(request.body)).toThrow();

  // VAPID: a JWT for the push service's origin, signed with the key the device subscribed with.
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(
    request.headers.authorization ?? "",
  );
  if (match === null) throw new Error("no VAPID header");
  const [, header, claims, signature, publicKey] = match;
  expect(publicKey).toBe(keys.publicKey);
  expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
    aud: "https://web.push.apple.com",
    exp: now.getTime() / 1000 + 12 * 3600,
    sub: "https://github.com/BarryTheShen/omp-app",
  });
  const raw = Buffer.from(publicKey ?? "", "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature ?? "", "base64url"),
    ),
  ).toBe(true);
});

test("a message too long for Apple's 4 KB limit is refused before it is sent", () => {
  expect(() =>
    pushRequest(device().target, "x".repeat(5000), newVapidKeys(), {
      subject: "mailto:a@b.c",
      now: new Date(),
    }),
  ).toThrow("at most 4 KB");
});

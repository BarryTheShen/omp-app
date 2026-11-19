/** Agent access (#20): checking a machine's Ed25519 signatures, and the random ids the link uses. */
import { createPublicKey, randomBytes, verify } from "node:crypto";

/** Whether `signature` (base64url, 64 bytes) signs `text` (UTF-8) with the Ed25519 key `publicKey` (base64url, 32 bytes). */
export function ed25519Verifies(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** A challenge's nonce: 32 random bytes, base64url (43 characters). */
export const newNonce = (): string => randomBytes(32).toString("base64url");

/** A machine's id: `am_` and 16 random bytes, base64url (22 characters). */
export const newMachineId = (): string => `am_${randomBytes(16).toString("base64url")}`;

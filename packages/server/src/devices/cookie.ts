/**
 * The cookie that carries a paired device's key. The server sets it, HttpOnly so the page's scripts never read it, and
 * SameSite=Strict so it goes only with the app's own requests; Secure over HTTPS (the address other devices open). A browser
 * keeps a cookie 400 days at most, so the page's own load sets it again (`renewedDeviceCookie`): a device stays paired
 * while it is used, until it is removed.
 */
import { DEVICE_COOKIE } from "@omp-app/contracts";

/** 400 days, the longest a browser keeps a cookie. */
const COOKIE_SECONDS = 400 * 24 * 60 * 60;
/** A device key: 32 random bytes in base64url (43 characters). */
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The device key the request carries; undefined when it carries none, or something that is no key. */
export function deviceKeyOf(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== DEVICE_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return KEY_SHAPE.test(value) ? value : undefined;
  }
  return undefined;
}

/** The Set-Cookie value that gives a device its key. */
export function deviceCookie(key: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${key}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

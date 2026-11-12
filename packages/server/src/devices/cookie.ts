/**
 * The cookie that carries a paired device's key. The server sets it, HttpOnly so the page's scripts never read it, and
 * SameSite=Strict so it goes only with the app's own requests; Secure over HTTPS (the address other devices open). A browser
 * keeps a cookie 400 days at most, so the page's own load sets it again (`renewedDeviceCookie`): a device stays paired
 * while it is used, until it is removed. A panel in another app's frame, which gets no cookie of the app, offers its key
 * in its WebSocket's protocols instead (`deviceKeyOfProtocols`).
 */
import { DEVICE_COOKIE, DEVICE_KEY_SHAPE, SOCKET_DEVICE_PROTOCOL_PREFIX } from "@omp-app/contracts";

/** 400 days, the longest a browser keeps a cookie. */
const COOKIE_SECONDS = 400 * 24 * 60 * 60;

/** The device key the request carries; undefined when it carries none, or something that is no key. */
export function deviceKeyOf(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== DEVICE_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return DEVICE_KEY_SHAPE.test(value) ? value : undefined;
  }
  return undefined;
}

/** The protocols a WebSocket request offers (`Sec-WebSocket-Protocol`, comma-separated), in its order. */
export function offeredProtocols(request: Request): string[] {
  const header = request.headers.get("sec-websocket-protocol");
  if (header === null) return [];
  return header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
}

/** The device key a panel offered in its WebSocket's protocols; undefined without one, or for something that is no key. */
export function deviceKeyOfProtocols(request: Request): string | undefined {
  for (const protocol of offeredProtocols(request)) {
    if (!protocol.startsWith(SOCKET_DEVICE_PROTOCOL_PREFIX)) continue;
    const key = protocol.slice(SOCKET_DEVICE_PROTOCOL_PREFIX.length);
    return DEVICE_KEY_SHAPE.test(key) ? key : undefined;
  }
  return undefined;
}

/** The Set-Cookie value that gives a device its key. */
export function deviceCookie(key: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${key}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

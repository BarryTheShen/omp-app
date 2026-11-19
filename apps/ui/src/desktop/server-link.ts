/**
 * The link the desktop window opens for Add a server: the address as typed (`https://` added when it has no scheme,
 * the app's root when it names no path) and, when a one-time code is given, `#pair=<code>`, which the server's pairing
 * screen uses at once (as a QR code's address does). Null for an address that is not one; the window refuses other
 * shapes itself (`remote.rs`).
 */
export function serverLink(address: string, code: string): string | null {
  const typed = address.trim();
  if (typed === "") return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  url.search = "";
  const pair = code.replace(/\s+/g, "").toUpperCase();
  url.hash = pair === "" ? "" : `pair=${encodeURIComponent(pair)}`;
  return url.toString();
}

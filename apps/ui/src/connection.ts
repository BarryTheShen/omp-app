import { type AppClient, createAppClient } from "@omp-app/client";

/** Where the tab keeps the launch token; the old UI uses the same key, so both read one token. */
const TOKEN_KEY = "omp-app.websocket-token";

/**
 * On iOS, the cookie that carries the launch token into the app added to the Home Screen: Add to Home Screen copies
 * Safari's cookies into the new app and no other storage (WebKit, Safari 17.2), and the address it opens has no token.
 */
const TOKEN_COOKIE = "omp-app-token";
/** 400 days, the longest a browser keeps a cookie. */
const COOKIE_SECONDS = 400 * 24 * 60 * 60;

/** iOS, the one platform with `navigator.standalone`, whose Home Screen apps get Safari's cookies once. */
function onIos(): boolean {
  return "standalone" in window.navigator;
}

function keepForHomeScreen(token: string): void {
  if (!onIos()) return;
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_SECONDS}; SameSite=Strict; Secure`;
}

function tokenFromCookie(): string | null {
  if (!onIos()) return null;
  for (const part of document.cookie.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === TOKEN_COOKIE && value !== undefined && value.length > 0)
      return decodeURIComponent(value);
  }
  return null;
}

/**
 * The launch token: from the address (`#token=…`), which then loses it, or the one this tab kept, or on iOS the one
 * kept for the Home Screen. Null when the app was opened without its link.
 */
export function readToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const fromAddress = params.get("token");
  if (fromAddress !== null && fromAddress.length > 0) {
    try {
      window.sessionStorage.setItem(TOKEN_KEY, fromAddress);
    } catch {
      // Storage may be off; the token still works for this page.
    }
    keepForHomeScreen(fromAddress);
    params.delete("token");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${rest.length > 0 ? `#${rest}` : ""}`,
    );
    return fromAddress;
  }
  try {
    const kept = window.sessionStorage.getItem(TOKEN_KEY);
    if (kept !== null) return kept;
  } catch {
    // Storage may be off: the Home Screen's cookie is all there is.
  }
  return tokenFromCookie();
}

export function connect(token: string): AppClient {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return createAppClient({
    url: `${protocol}//${window.location.host}/ws`,
    token,
    clientName: "@omp-app/ui",
  });
}

import { type AppClient, createAppClient } from "@omp-app/client";

/** Where the tab keeps the launch token. */
const TOKEN_KEY = "omp-app.websocket-token";

/**
 * The launch token: from the address (`#token=…`), which then loses it, or the one this tab kept. Null when the app was
 * opened without its link, as every device but this computer's is: it signs in with its paired key's cookie.
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
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Storage may be off: there is no token kept.
    return null;
  }
}

/** Connects with the launch link's token, or with none: a paired device signs in with its key's cookie. */
export function connect(token: string | null): AppClient {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return createAppClient({
    url: `${protocol}//${window.location.host}/ws`,
    ...(token === null ? {} : { token }),
    clientName: "@omp-app/ui",
  });
}

import { type AppClient, createAppClient } from "@omp-app/client";

/** Where the tab keeps the launch token; the old UI uses the same key, so both read one token. */
const TOKEN_KEY = "omp-app.websocket-token";

/**
 * The launch token: from the address (`#token=…`), which then loses it, or the one this tab kept. Null when the app was
 * opened without its link.
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
    return null;
  }
}

export function connect(token: string): AppClient {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return createAppClient({
    url: `${protocol}//${window.location.host}/ws`,
    token,
    clientName: "@omp-app/ui",
  });
}

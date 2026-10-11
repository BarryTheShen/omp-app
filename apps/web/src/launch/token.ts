export const APP_TOKEN_STORAGE_KEY = "omp-app.websocket-token";

export interface LaunchLocationLike {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
  readonly protocol: string;
  readonly host: string;
}

export interface TokenStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TokenHistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export interface LaunchTokenResult {
  readonly token: string | null;
  readonly source: "url" | "session" | "missing";
}

function defaultLocation(): LaunchLocationLike | undefined {
  return typeof window === "undefined" ? undefined : window.location;
}

function defaultStorage(): TokenStorageLike | undefined {
  return typeof window === "undefined" ? undefined : window.sessionStorage;
}

function defaultHistory(): TokenHistoryLike | undefined {
  return typeof window === "undefined" ? undefined : window.history;
}

function fragmentParameters(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** The launch token in a URL fragment (`#token=…`), or null when the fragment carries none. */
export function launchTokenInFragment(hash: string): string | null {
  const token = fragmentParameters(hash).get("token");
  return token && token.length > 0 ? token : null;
}

function stripTokenFromAddressBar(
  location: LaunchLocationLike,
  history: TokenHistoryLike | undefined,
): void {
  if (!history) return;
  const parameters = fragmentParameters(location.hash);
  if (!parameters.has("token")) return;
  parameters.delete("token");
  const fragment = parameters.toString();
  const nextUrl = `${location.pathname}${location.search}${fragment ? `#${fragment}` : ""}`;
  try {
    history.replaceState(null, "", nextUrl);
  } catch {
    // A non-browser test double may not implement history mutation; the token is still safe.
  }
}

/** Reads the one-time URL token, persists it for reloads, and removes it from the address bar. */
export function readLaunchToken(
  options: {
    readonly location?: LaunchLocationLike;
    readonly storage?: TokenStorageLike;
    readonly history?: TokenHistoryLike;
  } = {},
): LaunchTokenResult {
  const location = options.location ?? defaultLocation();
  const storage = options.storage ?? defaultStorage();
  const history = options.history ?? defaultHistory();
  if (!location) return { token: null, source: "missing" };

  const parameters = fragmentParameters(location.hash);
  const urlToken = parameters.get("token");
  if (parameters.has("token")) stripTokenFromAddressBar(location, history);
  if (urlToken && urlToken.length > 0) {
    try {
      storage?.setItem(APP_TOKEN_STORAGE_KEY, urlToken);
    } catch {
      // Session storage can be disabled; this load can still use the URL token.
    }
    return { token: urlToken, source: "url" };
  }

  try {
    const storedToken = storage?.getItem(APP_TOKEN_STORAGE_KEY) ?? null;
    return storedToken && storedToken.length > 0
      ? { token: storedToken, source: "session" }
      : { token: null, source: "missing" };
  } catch {
    return { token: null, source: "missing" };
  }
}

/** Builds the WebSocket endpoint on the page's own origin; the client appends `?token=`. */
export function websocketUrl(location: Pick<LaunchLocationLike, "protocol" | "host">): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

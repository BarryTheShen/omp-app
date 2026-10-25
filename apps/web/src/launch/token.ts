// The ids entry, not the package's barrel: e2e specs import this file, and Playwright loads them in Node, which refuses
// the JSON import the barrel's inventory module makes (#2638).
import { FolderPath } from "@omp-app/contracts/ids";

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
  /** The folder the launch link asks the app to open on: only an absolute path in the address counts, else null. */
  readonly folder: FolderPath | null;
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

const LAUNCH_PARAMETERS = ["token", "folder"] as const;

function fragmentParameters(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** The launch token in a URL fragment (`#token=…`), or null when the fragment carries none. */
export function launchTokenInFragment(hash: string): string | null {
  const token = fragmentParameters(hash).get("token");
  return token && token.length > 0 ? token : null;
}

/** The folder a launch link's fragment asks for (`#…&folder=<absolute path>`); null when it has none or is not an absolute path. */
export function launchFolderInFragment(hash: string): FolderPath | null {
  const folder = FolderPath.safeParse(fragmentParameters(hash).get("folder") ?? "");
  return folder.success ? folder.data : null;
}

/** Removes the launch link's own parameters, whatever they held, and keeps any other fragment parameter. */
function stripLaunchParametersFromAddressBar(
  location: LaunchLocationLike,
  history: TokenHistoryLike | undefined,
): void {
  if (!history) return;
  const parameters = fragmentParameters(location.hash);
  if (!LAUNCH_PARAMETERS.some((name) => parameters.has(name))) return;
  for (const name of LAUNCH_PARAMETERS) parameters.delete(name);
  const fragment = parameters.toString();
  const nextUrl = `${location.pathname}${location.search}${fragment ? `#${fragment}` : ""}`;
  try {
    history.replaceState(null, "", nextUrl);
  } catch {
    // A non-browser test double may not implement history mutation; the token is still safe.
  }
}

/**
 * Reads the one-time URL token, persists it for reloads, and removes it from the address bar. The folder the link
 * asks the app to open on (`&folder=<absolute path>`) is read from the same fragment and removed with it: it comes
 * from the address alone, so a reload does not ask for it again.
 */
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
  if (!location) return { token: null, source: "missing", folder: null };

  const urlToken = fragmentParameters(location.hash).get("token");
  const folder = launchFolderInFragment(location.hash);
  stripLaunchParametersFromAddressBar(location, history);
  if (urlToken && urlToken.length > 0) {
    try {
      storage?.setItem(APP_TOKEN_STORAGE_KEY, urlToken);
    } catch {
      // Session storage can be disabled; this load can still use the URL token.
    }
    return { token: urlToken, source: "url", folder };
  }

  try {
    const storedToken = storage?.getItem(APP_TOKEN_STORAGE_KEY) ?? null;
    return storedToken && storedToken.length > 0
      ? { token: storedToken, source: "session", folder }
      : { token: null, source: "missing", folder };
  } catch {
    return { token: null, source: "missing", folder };
  }
}

/** Builds the WebSocket endpoint on the page's own origin; the client appends `?token=`. */
export function websocketUrl(location: Pick<LaunchLocationLike, "protocol" | "host">): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

const KEY = "omp-app.log-file";

/** Where the log is when this browser has never heard from the server (the app's default). */
export const DEFAULT_LOG_FILE = "~/.local/state/omp-app/omp-app.log";

/** Remembered from the server's last answer, so a screen shown while it is down can still say where to look. */
export function rememberLogFile(
  path: string | undefined,
  storage: Storage | undefined = safeStorage(),
): void {
  if (path === undefined || storage === undefined) return;
  try {
    storage.setItem(KEY, path);
  } catch {
    // A browser that refuses storage simply falls back to the default location.
  }
}

/** The log file this browser last learned about, else the app's default location. */
export function knownLogFile(storage: Storage | undefined = safeStorage()): string {
  try {
    return storage?.getItem(KEY) ?? DEFAULT_LOG_FILE;
  } catch {
    return DEFAULT_LOG_FILE;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

import { type FSWatcher, type WatchListener, watch } from "node:fs";

/** Why a watch failed: this computer has no file watchers left (ENOSPC, EMFILE), or something else went wrong. */
export type FileWatchReason = "watcher-limit" | "watch-failed";

export type FileWatchSnapshot =
  | { readonly state: "ok" }
  | { readonly state: "limited"; readonly reason: FileWatchReason; readonly failing: number };

/** Opens a watch on a directory: node:fs `watch` unless a test or an embedding replaces it. */
export type WatchDirectory = (directory: string, listener: WatchListener<string>) => FSWatcher;

export interface FileWatchRegistryOptions {
  /**
   * Opens the directory watches of every store that shares this registry. A test passes one that fails the way a
   * full computer does, so the whole server can be checked with watches that cannot run.
   */
  readonly watchDirectory?: WatchDirectory;
}

/** The reason a failed watch gives: a full computer is the case the person can act on. */
export function fileWatchReason(error: unknown): FileWatchReason {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOSPC" || code === "EMFILE" ? "watcher-limit" : "watch-failed";
}

/**
 * The watched files that cannot be watched right now, so the app checks them by polling instead. Every store
 * that watches files reports into one registry, so the person gets one message about it.
 */
export class FileWatchRegistry {
  /** Opens the directory watches for every store that shares this registry. */
  readonly watchDirectory: WatchDirectory;
  readonly #failures = new Map<
    object,
    { readonly path: string; readonly reason: FileWatchReason }
  >();

  constructor(options: FileWatchRegistryOptions = {}) {
    this.watchDirectory =
      options.watchDirectory ??
      ((directory, listener) => watch(directory, { persistent: false }, listener));
  }

  /** Records that the watch `token` cannot watch `path` right now, so the file is checked by polling. */
  fail(token: object, path: string, error: unknown): void {
    this.#failures.set(token, { path, reason: fileWatchReason(error) });
  }

  /** The watch `token` is watching again, or has been disposed. */
  clear(token: object): void {
    this.#failures.delete(token);
  }

  snapshot(): FileWatchSnapshot {
    if (this.#failures.size === 0) return { state: "ok" };
    const reasons = [...this.#failures.values()].map((failure) => failure.reason);
    return {
      state: "limited",
      reason: reasons.includes("watcher-limit") ? "watcher-limit" : "watch-failed",
      failing: this.#failures.size,
    };
  }

  /** The files that are checked by polling right now, for tests and the debug log. */
  failingPaths(): string[] {
    return [...this.#failures.values()].map((failure) => failure.path);
  }
}

/**
 * What the page says while some watched files are only checked by polling: plain words, why, and what it means for
 * the person, which is that changes still show, a little later.
 */
export function fileWatchMessage(
  snapshot: Extract<FileWatchSnapshot, { readonly state: "limited" }>,
): string {
  // Only a full computer names its cause and an action that may help; another watch failure gives no guessed remedy.
  const watcherLimit = snapshot.reason === "watcher-limit";
  const cause = watcherLimit ? ", because this computer has no file watchers left" : "";
  const remedy = watcherLimit
    ? " Closing programs that watch many files, such as editors, may free some."
    : "";
  return `omp app can't watch some of its files for changes${cause}.${remedy} It checks them every second instead, so changes still show, a little later.`;
}

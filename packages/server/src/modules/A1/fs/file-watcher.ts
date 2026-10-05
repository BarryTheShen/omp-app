import { type FSWatcher, statSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  consumeSelfWrite,
  readFileHash,
  readFileHashSync,
  registerSelfWriteConsumer,
} from "./atomic-file";

export interface FileChangeEvent {
  readonly path: string;
  readonly hash: string | null;
}

export interface FileWatcherOptions {
  /** Defaults to 100 ms, matching the app's live-config debounce budget. */
  readonly debounceMs?: number;
  /** Receives filesystem failures; required so watcher failures never escape as uncaught exceptions. */
  readonly onError: (error: unknown) => void;
}

export interface FileWatcher {
  readonly dispose: () => void;
}

export type FileChangeListener = (event: FileChangeEvent) => void | Promise<void>;

function isMissingDirectory(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function reportError(error: unknown, onError: (error: unknown) => void): void {
  onError(error);
}

function callbackResult(result: void | Promise<void>, onError: (error: unknown) => void): void {
  if (!result || typeof result !== "object" || !("then" in result)) return;
  void result.catch((error) => reportError(error, onError));
}

function nearestExistingDirectory(directory: string): string {
  let candidate = directory;
  for (;;) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch (error) {
      if (!isMissingDirectory(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

/**
 * Whether a directory event may concern the watched file. Bun's fs.watch can report no filename
 * (`undefined`, as well as `null`); the change might then be ours, so it counts (the content hash
 * decides afterwards whether anything really changed).
 */
export function mayConcernFile(
  changedFilename: string | Buffer | null | undefined,
  filename: string,
): boolean {
  return changedFilename == null || String(changedFilename) === filename;
}

/**
 * Watches the containing directory so atomic rename-over-target writes are observed reliably.
 * Changes are read back by SHA-256, debounced, and emitted only when the content hash changes.
 * The watcher is read-only: missing parent directories are never created by this function.
 */
export function watchFile(
  filePath: string,
  onChange: FileChangeListener,
  options: FileWatcherOptions,
): FileWatcher {
  const path = resolve(filePath);
  const directory = dirname(path);
  const filename = basename(path);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentHash = readFileHashSync(path);
  const debounceMs = Math.max(0, options.debounceMs ?? 100);
  const unregisterSelfWriteConsumer = registerSelfWriteConsumer(path);
  let watcher: FSWatcher | undefined;
  let watchedDirectory = nearestExistingDirectory(directory);

  const flush = async (): Promise<void> => {
    if (disposed) return;
    let nextHash: string | null;
    try {
      nextHash = await readFileHash(path);
    } catch (error) {
      reportError(error, options.onError);
      return;
    }
    const selfWrite = consumeSelfWrite(path, nextHash);
    if (nextHash === currentHash) return;
    currentHash = nextHash;
    if (selfWrite || disposed) return;
    try {
      const result = onChange({ path, hash: nextHash });
      callbackResult(result, options.onError);
    } catch (error) {
      reportError(error, options.onError);
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
  };

  const closeWatcher = (): void => {
    watcher?.close();
    watcher = undefined;
  };

  const armWatcher = (): void => {
    if (disposed) return;
    const nextDirectory = nearestExistingDirectory(directory);
    if (watcher && nextDirectory === watchedDirectory) return;
    closeWatcher();
    watchedDirectory = nextDirectory;
    try {
      watcher = watch(nextDirectory, { persistent: false }, (eventType, changedFilename) => {
        // An exception here would escape the event loop and take the whole server down, so every
        // failure goes to onError (A1.2's contract).
        try {
          if (disposed) return;
          if (directory !== watchedDirectory || eventType === "rename") {
            armWatcher();
            schedule();
            return;
          }
          if (!mayConcernFile(changedFilename, filename)) return;
          schedule();
        } catch (error) {
          reportError(error, options.onError);
        }
      });
      watcher.on("error", (error) => reportError(error, options.onError));
    } catch (error) {
      if (isMissingDirectory(error) && nextDirectory !== dirname(nextDirectory)) {
        armWatcher();
        return;
      }
      reportError(error, options.onError);
    }
  };

  try {
    armWatcher();
  } catch (error) {
    unregisterSelfWriteConsumer();
    throw error;
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      closeWatcher();
      unregisterSelfWriteConsumer();
    },
  };
}

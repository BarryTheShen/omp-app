import type { FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FolderPath,
  WatchedPath,
  WorkspaceFileChanged,
  WorkspaceRelativePath,
} from "@omp-app/contracts";
import { MAX_WATCHED_PATHS } from "@omp-app/contracts";
import { isAtomicWriteArtifact } from "../fs/atomic-file";
import type { FileWatchRegistry } from "../fs/file-watch-registry";
import { folderItself, folderRoot, followInside } from "./paths";

/** Changes to one path within this long are told once. */
export const CHANGE_DEBOUNCE_MS = 200;
/** A path that cannot be watched is checked this often instead. */
export const WATCH_POLL_MS = 5_000;

type Change = WorkspaceFileChanged["change"];

export interface WorkspaceWatchTimer {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WorkspaceWatchDeps {
  /** Opens the watches, and hears which cannot run, with every other store's. */
  readonly registry: FileWatchRegistry;
  readonly timer?: WorkspaceWatchTimer;
}

/** What a path looks like, to tell a change: its kind, size and time. */
type Signature = string;

/** One watched path of a folder, shared by every connection that watches it. */
interface Watched {
  readonly folder: FolderPath;
  readonly path: WatchedPath;
  readonly real: string;
  readonly directory: boolean;
  readonly users: Set<string>;
  /** A directory's entries by name; a file's own signature under `""`. */
  known: Map<string, Signature>;
  watcher: FSWatcher | null;
  poll: unknown;
}

const GLOBAL_TIMER: WorkspaceWatchTimer = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

async function signatureOf(path: string): Promise<Signature | null> {
  try {
    const info = await lstat(path);
    const kind = info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : info.isFile() ? "f" : "o";
    return `${kind}:${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

async function entriesOf(directory: string): Promise<Map<string, Signature>> {
  const known = new Map<string, Signature>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return known;
  }
  for (const name of names) {
    if (isAtomicWriteArtifact(name)) continue;
    const signature = await signatureOf(join(directory, name));
    if (signature !== null) known.set(name, signature);
  }
  return known;
}

/**
 * The Files panel's watches (#2782). Each connection names the paths it shows (the expanded directories and the open
 * file, `MAX_WATCHED_PATHS` at most); each folder and path is watched once for all of them, and closed when no
 * connection names it. A change is told once per path within `CHANGE_DEBOUNCE_MS`, to every listener, with its
 * folder. A path whose watch cannot open is checked every `WATCH_POLL_MS` instead, and the shared registry hears it.
 */
export class WorkspaceWatches {
  readonly #registry: FileWatchRegistry;
  readonly #timer: WorkspaceWatchTimer;
  readonly #watched = new Map<string, Watched>();
  readonly #byConnection = new Map<string, Set<string>>();
  readonly #pending = new Map<string, { change: Change; handle: unknown }>();
  readonly #listeners = new Set<(event: WorkspaceFileChanged) => void>();

  constructor(deps: WorkspaceWatchDeps) {
    this.#registry = deps.registry;
    this.#timer = deps.timer ?? GLOBAL_TIMER;
  }

  onChange(listener: (event: WorkspaceFileChanged) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The paths `connectionId` watches in `folder` from now on, in place of the ones it named before. */
  async set(
    connectionId: string,
    folder: FolderPath,
    paths: readonly WatchedPath[],
  ): Promise<void> {
    const root = await folderRoot(folder);
    const keys = new Set<string>();
    for (const path of paths.slice(0, MAX_WATCHED_PATHS)) {
      const key = `${folder}\0${path}`;
      let watched = this.#watched.get(key);
      if (watched === undefined) {
        const opened = await this.#open(root, folder, path);
        if (opened === null) continue;
        // Another call may have opened it meanwhile.
        watched = this.#watched.get(key) ?? opened;
        if (watched !== opened) this.#close(opened);
        this.#watched.set(key, watched);
      }
      watched.users.add(connectionId);
      keys.add(key);
    }
    for (const key of this.#byConnection.get(connectionId) ?? []) {
      if (!keys.has(key)) this.#release(key, connectionId);
    }
    this.#byConnection.set(connectionId, keys);
  }

  /** The connection is gone: its watches end. */
  dropConnection(connectionId: string): void {
    for (const key of this.#byConnection.get(connectionId) ?? []) this.#release(key, connectionId);
    this.#byConnection.delete(connectionId);
  }

  close(): void {
    for (const watched of this.#watched.values()) this.#close(watched);
    this.#watched.clear();
    this.#byConnection.clear();
    for (const pending of this.#pending.values()) this.#timer.clearTimeout(pending.handle);
    this.#pending.clear();
  }

  /** Paths watched now, by folder and path, for tests. */
  get watching(): readonly string[] {
    return [...this.#watched.keys()];
  }

  async #open(root: string, folder: FolderPath, path: WatchedPath): Promise<Watched | null> {
    let at: Awaited<ReturnType<typeof followInside>>;
    try {
      at = path === "" ? await folderItself(root) : await followInside(root, path);
    } catch {
      // Gone, or not inside: nothing to watch.
      return null;
    }
    const directory = at.info.isDirectory();
    const watched: Watched = {
      folder,
      path,
      real: at.real,
      directory,
      users: new Set(),
      known: directory
        ? await entriesOf(at.real)
        : new Map([["", (await signatureOf(at.real)) ?? ""]]),
      watcher: null,
      poll: null,
    };
    this.#watch(watched);
    return watched;
  }

  /** Opens the path's watch; one that cannot open is checked by polling instead. True when the watch runs. */
  #watch(watched: Watched): boolean {
    try {
      const watcher = this.#registry.watchDirectory(watched.real, (_event, name) => {
        void this.#look(watched, typeof name === "string" ? name : null);
      });
      watcher.on("error", (error) => this.#poll(watched, error));
      watched.watcher = watcher;
      return true;
    } catch (error) {
      this.#poll(watched, error);
      return false;
    }
  }

  /**
   * The watch cannot run: the path is checked every `WATCH_POLL_MS`, and the registry hears it. Each check tries the
   * watch again first; once it opens, polling stops and the registry hears the path is watched again.
   */
  #poll(watched: Watched, error: unknown): void {
    watched.watcher?.close();
    watched.watcher = null;
    this.#registry.fail(watched, watched.real, error);
    if (watched.poll !== null) return;
    watched.poll = this.#timer.setInterval(() => {
      void this.#look(watched, null);
      if (watched.watcher !== null || !this.#watch(watched)) return;
      this.#timer.clearInterval(watched.poll);
      watched.poll = null;
      this.#registry.clear(watched);
    }, WATCH_POLL_MS);
  }

  /** Compares what is there now with what was, for one entry (`name`) or the whole path (null). */
  async #look(watched: Watched, name: string | null): Promise<void> {
    if (!watched.directory) {
      const now = await signatureOf(watched.real);
      const was = watched.known.get("") ?? null;
      if (now === was) return;
      watched.known.set("", now ?? "");
      if (watched.path !== "")
        this.#tell(watched.folder, watched.path, now === null ? "deleted" : "modified");
      return;
    }
    if (name !== null && isAtomicWriteArtifact(name)) return;
    const names = name === null ? null : [name];
    const now = name === null ? await entriesOf(watched.real) : null;
    const candidates = names ?? [...new Set([...watched.known.keys(), ...(now?.keys() ?? [])])];
    for (const entry of candidates) {
      const was = watched.known.get(entry) ?? null;
      const is =
        now === null ? await signatureOf(join(watched.real, entry)) : (now.get(entry) ?? null);
      if (was === is) continue;
      if (is === null) watched.known.delete(entry);
      else watched.known.set(entry, is);
      const path = (
        watched.path === "" ? entry : `${watched.path}/${entry}`
      ) as WorkspaceRelativePath;
      this.#tell(
        watched.folder,
        path,
        was === null ? "created" : is === null ? "deleted" : "modified",
      );
    }
  }

  /** Tells a change once per path within the debounce: a creation stays a creation through later writes. */
  #tell(folder: FolderPath, path: WorkspaceRelativePath, change: Change): void {
    const key = `${folder}\0${path}`;
    const pending = this.#pending.get(key);
    if (pending !== undefined) this.#timer.clearTimeout(pending.handle);
    const told = pending?.change === "created" && change === "modified" ? "created" : change;
    const handle = this.#timer.setTimeout(() => {
      this.#pending.delete(key);
      for (const listener of this.#listeners) listener({ folder, path, change: told });
    }, CHANGE_DEBOUNCE_MS);
    this.#pending.set(key, { change: told, handle });
  }

  #release(key: string, connectionId: string): void {
    const watched = this.#watched.get(key);
    if (watched === undefined) return;
    watched.users.delete(connectionId);
    if (watched.users.size > 0) return;
    this.#close(watched);
    this.#watched.delete(key);
  }

  #close(watched: Watched): void {
    watched.watcher?.close();
    watched.watcher = null;
    if (watched.poll !== null) this.#timer.clearInterval(watched.poll);
    watched.poll = null;
    this.#registry.clear(watched);
  }
}

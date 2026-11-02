import type { AppClient } from "@omp-app/client";
import {
  type FolderPath,
  MAX_WATCHED_PATHS,
  type WatchedPath,
  type WorkspaceFileChanged,
  WorkspaceFilesPort,
} from "@omp-app/contracts";

/**
 * What a page watches in a folder (#2782). The server keeps one set of watched paths per connection, and each `watch`
 * replaces it; so the Files panel and every file opened as a tab say what they want here, and one call names them
 * all. The `changed` stream is shared the same way.
 */
class WatchHub {
  readonly #client: AppClient;
  readonly #folder: FolderPath;
  readonly #wants = new Map<object, readonly WatchedPath[]>();
  readonly #listeners = new Set<(event: WorkspaceFileChanged) => void>();
  #sent = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #subscription: Promise<{ unsubscribe(): Promise<void> }> | null = null;

  constructor(client: AppClient, folder: FolderPath) {
    this.#client = client;
    this.#folder = folder;
  }

  /** `owner` watches `paths` from now on (none: it stops); the call to the server follows shortly after. */
  want(owner: object, paths: readonly WatchedPath[]): void {
    if (paths.length === 0) this.#wants.delete(owner);
    else this.#wants.set(owner, paths);
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#send(), 100);
  }

  /** Hears changes in the folder; returns the stop. */
  listen(listener: (event: WorkspaceFileChanged) => void): () => void {
    this.#listeners.add(listener);
    if (this.#subscription === null) {
      this.#subscription = this.#client
        .subscribe(WorkspaceFilesPort, "changed", { scope: this.#folder })
        .then((subscription) => {
          subscription.onEvent((event) => {
            for (const each of this.#listeners) each(event);
          });
          return subscription;
        });
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0 || this.#subscription === null) return;
      const ending = this.#subscription;
      this.#subscription = null;
      void ending.then((subscription) => subscription.unsubscribe()).catch(() => undefined);
    };
  }

  #send(): void {
    this.#timer = null;
    const paths = [...new Set([...this.#wants.values()].flat())].slice(0, MAX_WATCHED_PATHS);
    const key = paths.join("\0");
    if (key === this.#sent) return;
    this.#sent = key;
    void this.#client
      .port(WorkspaceFilesPort)
      .watch({ folder: this.#folder, paths })
      .catch(() => {
        // Not watched: the next want tries again.
        this.#sent = "";
      });
  }
}

const hubs = new WeakMap<AppClient, Map<string, WatchHub>>();

export function watchHub(client: AppClient, folder: FolderPath): WatchHub {
  let byFolder = hubs.get(client);
  if (byFolder === undefined) {
    byFolder = new Map();
    hubs.set(client, byFolder);
  }
  let hub = byFolder.get(folder);
  if (hub === undefined) {
    hub = new WatchHub(client, folder);
    byFolder.set(folder, hub);
  }
  return hub;
}

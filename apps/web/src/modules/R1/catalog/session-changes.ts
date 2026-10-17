import type { AppClient, AppClientSubscription } from "@omp-app/client";
import type { FolderPath, SessionFileChanged, SessionRunningChanged } from "@omp-app/contracts";
import { SessionFileStore } from "@omp-app/contracts";
import { type SessionCatalogModel, sessionFolderInScope } from "./catalog";

type SessionSubscriptionArgs =
  | [AppClient, "changed", (change: SessionFileChanged) => void]
  | [AppClient, "runningChanged", (change: SessionRunningChanged) => void];

function watchTypedSubscription<Payload>(
  pending: Promise<AppClientSubscription<Payload>>,
  listener: (change: Payload) => void,
): () => void {
  let active = true;
  let remove: (() => void) | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  const subscribed = pending
    .then((next) => {
      if (!active) {
        void next.unsubscribe().catch(() => undefined);
        return;
      }
      unsubscribe = () => next.unsubscribe();
      remove = next.onEvent(listener);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    remove?.();
    void subscribed.then(() => unsubscribe?.()).catch(() => undefined);
  };
}

function watchSubscription(
  client: AppClient,
  event: "changed",
  listener: (change: SessionFileChanged) => void,
): () => void;
function watchSubscription(
  client: AppClient,
  event: "runningChanged",
  listener: (change: SessionRunningChanged) => void,
): () => void;
function watchSubscription(...args: SessionSubscriptionArgs): () => void {
  if (args[1] === "changed")
    return watchTypedSubscription(args[0].subscribe(SessionFileStore, "changed"), args[2]);
  return watchTypedSubscription(args[0].subscribe(SessionFileStore, "runningChanged"), args[2]);
}

/**
 * Calls `listener` for each session file change the server reports, until the returned function runs. File-backed
 * turns are reconciled from the changed file.
 */
export function watchSessionFileChanges(
  client: AppClient,
  listener: (change: SessionFileChanged) => void,
): () => void {
  return watchSubscription(client, "changed", listener);
}

function refreshCatalog(catalog: SessionCatalogModel): void {
  const snapshot = catalog.getSnapshot();
  void catalog.list({ filter: snapshot.filter, limit: 50 }).catch(() => undefined);
}

/** Re-read only held catalogs whose scope contains the folder from this file-less turn event. */
export function refreshCatalogsForRunningChange(
  catalogs: ReadonlyMap<FolderPath, SessionCatalogModel>,
  change: SessionRunningChanged,
): void {
  for (const catalog of catalogs.values()) {
    if (sessionFolderInScope(catalog.getSnapshot().scope, change.folder)) refreshCatalog(catalog);
  }
}

/** A resync or a reopened connection can mean a running flip was missed; reload every held catalog. */
export function refreshCatalogsAfterReconnect(
  catalogs: ReadonlyMap<FolderPath, SessionCatalogModel>,
): void {
  for (const catalog of catalogs.values()) refreshCatalog(catalog);
}

/** Watches file-less turn changes and closes the gap when a window resyncs or reconnects. */
export function watchSessionRunningChanges(
  client: AppClient,
  catalogs: ReadonlyMap<FolderPath, SessionCatalogModel>,
): () => void {
  const stopEvent = watchSubscription(client, "runningChanged", (change) =>
    refreshCatalogsForRunningChange(catalogs, change),
  );
  const stopResync = client.onResync(() => refreshCatalogsAfterReconnect(catalogs));
  let wasOpen = client.connectionState === "open";
  const stopConnection = client.onConnectionState(({ state }) => {
    const reopened = state === "open" && !wasOpen;
    wasOpen = state === "open";
    if (reopened) refreshCatalogsAfterReconnect(catalogs);
  });
  return () => {
    stopEvent();
    stopResync();
    stopConnection();
  };
}

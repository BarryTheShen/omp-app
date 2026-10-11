import type { AppClient } from "@omp-app/client";
import type { SessionFileChanged } from "@omp-app/contracts";
import { SessionFileStore } from "@omp-app/contracts";

/**
 * Calls `listener` for each session file change the server reports, until the returned function runs. The server
 * reports a chat's turn starting or settling this way, so a row's running state follows the chat. When the
 * subscription fails the list keeps what it has: it reads each chat again when a chat is opened and when a turn
 * settles, so it does not stop.
 */
export function watchSessionFileChanges(
  client: AppClient,
  listener: (change: SessionFileChanged) => void,
): () => void {
  let active = true;
  let remove: (() => void) | undefined;
  let subscription: { readonly unsubscribe: () => Promise<void> } | undefined;
  const pending = client
    .subscribe(SessionFileStore, "changed")
    .then((next) => {
      // A watch ended before the subscription arrived releases it here, once; the cleanup below then has nothing to release.
      if (!active) {
        void next.unsubscribe().catch(() => undefined);
        return;
      }
      subscription = next;
      remove = next.onEvent(listener);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    remove?.();
    void pending.then(() => subscription?.unsubscribe()).catch(() => undefined);
  };
}

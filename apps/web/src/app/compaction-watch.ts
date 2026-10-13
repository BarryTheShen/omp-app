import type { AppClient, AppClientSubscription } from "@omp-app/client";
import { type CompactionEvent, OmpCommandGateway, type ThreadId } from "@omp-app/contracts";

/**
 * Calls `onSaved` each time omp saves a compaction that a `/compact` command finished in the background. The server
 * reads omp's words and sends the typed outcome, so the browser listens for that outcome and never reads omp's text.
 * Returns the way to stop listening. A subscription that fails leaves the transcript as it was, to be read at the next
 * turn.
 */
export function watchSavedCompactions(
  client: Pick<AppClient, "subscribe">,
  threadId: ThreadId,
  onSaved: () => void,
): () => void {
  let stopped = false;
  let subscription: AppClientSubscription<CompactionEvent> | undefined;
  let stopListening: (() => void) | undefined;
  void client.subscribe(OmpCommandGateway, "compaction", { scope: threadId }).then(
    (opened) => {
      if (stopped) {
        void opened.unsubscribe();
        return;
      }
      subscription = opened;
      stopListening = opened.onEvent((event) => {
        if (event.outcome === "saved") onSaved();
      });
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    stopListening?.();
    void subscription?.unsubscribe();
  };
}

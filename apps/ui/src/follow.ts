import type { AppClientSubscription } from "@omp-app/client";

/** Follows one subscription until the returned function runs; one that fails to start is left alone. */
export function follow<Payload>(
  pending: Promise<AppClientSubscription<Payload>>,
  listener: (payload: Payload) => void,
): () => void {
  let active = true;
  let detach: (() => void) | undefined;
  let subscription: AppClientSubscription<Payload> | undefined;
  void pending
    .then((started) => {
      if (!active) {
        void started.unsubscribe().catch(() => undefined);
        return;
      }
      subscription = started;
      detach = started.onEvent(listener);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    detach?.();
    void subscription?.unsubscribe().catch(() => undefined);
  };
}

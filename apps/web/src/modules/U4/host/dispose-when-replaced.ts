import { useEffect, useRef } from "react";

/**
 * Disposes a host when it is replaced or when its owner unmounts. React's StrictMode runs an effect's
 * cleanup and then its setup again on mount, with the same host, so a dispose is only queued here: the
 * setup that follows takes the host back before the queued dispose runs.
 */
export function useDisposeWhenReplaced<T extends { dispose(): void }>(host: T): void {
  const queued = useRef(new Set<T>());
  useEffect(() => {
    queued.current.delete(host);
    return () => {
      queued.current.add(host);
      queueMicrotask(() => {
        if (queued.current.delete(host)) host.dispose();
      });
    };
  }, [host]);
}

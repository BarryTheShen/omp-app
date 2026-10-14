import { useEffect, useSyncExternalStore } from "react";
import type { WorkersController, WorkersPanelSnapshot } from "./controller";

const TICK_MS = 1_000;

/**
 * The workers panel's state, read from a controller that lives outside React. While a worker runs the
 * controller is ticked once a second, so the worker's time keeps moving between omp's reports.
 */
export function useWorkersPanel(controller: WorkersController): WorkersPanelSnapshot {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
  }, [controller]);
  const running = snapshot.model.activeCount > 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(controller.tick, TICK_MS);
    return () => clearInterval(timer);
  }, [controller, running]);
  return snapshot;
}

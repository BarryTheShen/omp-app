import { useEffect, useSyncExternalStore } from "react";
import type { AgentHubController, AgentHubState } from "./controller";

const TICK_MS = 1_000;

/**
 * The panel's state, read from a controller that lives outside React, so a re-render keeps it. While a worker runs
 * the controller is ticked once a second, so the worker's time keeps moving between omp's reports.
 */
export function useAgentHub(controller: AgentHubController): AgentHubState {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const running = state.model.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(controller.tick, TICK_MS);
    return () => clearInterval(timer);
  }, [controller, running]);
  return state;
}

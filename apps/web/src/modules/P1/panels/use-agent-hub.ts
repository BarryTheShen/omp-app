import { useSyncExternalStore } from "react";
import type { AgentHubController, AgentHubState } from "./controller";

/** The panel's state, read from a controller that lives outside React, so a re-render keeps it. */
export function useAgentHub(controller: AgentHubController): AgentHubState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

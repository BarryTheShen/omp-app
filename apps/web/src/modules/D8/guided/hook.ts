import { useSyncExternalStore } from "react";
import type { GuidedGoalController, GuidedGoalSnapshot } from "./controller";

export interface GuidedGoalControllerView {
  readonly snapshot: GuidedGoalSnapshot;
  readonly start: () => void;
  readonly retry: () => void;
}

/** The interview's snapshot and its actions. The actions return at once; the dialogs carry on. */
export function useGuidedGoal(controller: GuidedGoalController): GuidedGoalControllerView {
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  return {
    snapshot,
    start: () => void controller.start(),
    retry: () => void controller.retry(),
  };
}

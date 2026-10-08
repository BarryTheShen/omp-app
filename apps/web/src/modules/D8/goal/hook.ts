import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { GoalController, GoalPanelSnapshot } from "./controller";

export interface GoalPanelControllerView {
  readonly snapshot: GoalPanelSnapshot;
  readonly onRefresh: () => void;
  readonly onCreate: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDrop: () => void;
}

/** Starts the caller-owned controller and exposes its snapshot and actions to a placement-owned view. */
export function useGoalPanel(controller: GoalController): GoalPanelControllerView {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
  }, [controller]);
  const onRefresh = useCallback(() => void controller.refresh(), [controller]);
  const onCreate = useCallback(() => void controller.create(), [controller]);
  const onPause = useCallback(() => void controller.pause(), [controller]);
  const onResume = useCallback(() => void controller.resume(), [controller]);
  const onDrop = useCallback(() => void controller.drop(), [controller]);
  return { snapshot, onRefresh, onCreate, onPause, onResume, onDrop };
}

import type { OmpRuntimeStore } from "../../R0/store";
import { type GoalModeState, GoalModeStateSchema } from "../contract";
import type { GuidedGoalSource } from "./controller";

/** The session's goal-mode state as the runtime holds it now; `null` when there is none or it cannot be read. */
function goalStateOf(runtime: OmpRuntimeStore): GoalModeState | null {
  const snapshot = runtime.getSnapshot();
  if (snapshot.session.goal === null) return null;
  const parsed = GoalModeStateSchema.safeParse(snapshot.session.goal);
  return parsed.success ? parsed.data : null;
}

/** The session's goal state for the guided interview, told whenever the runtime changes. */
export function goalSourceOf(runtime: OmpRuntimeStore): GuidedGoalSource {
  return {
    getSnapshot: () => goalStateOf(runtime),
    subscribe: (listener) => runtime.subscribe(() => listener()),
  };
}

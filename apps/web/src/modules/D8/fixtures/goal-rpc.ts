import type { GoalRpcResult, GoalUpdatedEvent } from "../contract";

/**
 * Real omp/18.8.9 RPC capture from 2026-10-16, recorded by a throwaway script that is not committed. It started this
 * repo's `packages/omp-rpc/scripts/fake-openai-server.ts`, then omp with `--mode rpc-ui --cwd <workspace>
 * --model fake/fake-model --approval-mode yolo --no-rules --no-skills --no-extensions` under a temporary HOME and
 * agent directory. It sent goal create/get/pause/resume, a `stream_steady` prompt, an abort, get, drop and get. The
 * dropped goal had been paused by that abort. The objective is synthetic; ids and timestamps are the scrubbed
 * recording values.
 */
const ACTIVE_GOAL = {
  id: "15a90d8b4693ac72",
  objective: "Measure the reliable response path.",
  status: "active" as const,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1792192601370,
  updatedAt: 1792192601370,
};

const PAUSED_GOAL = {
  ...ACTIVE_GOAL,
  status: "paused" as const,
  updatedAt: 1792192601378,
};

const RESUMED_GOAL = {
  ...ACTIVE_GOAL,
  updatedAt: 1792192601382,
};

const ABORTED_GOAL = {
  ...RESUMED_GOAL,
  status: "paused" as const,
  updatedAt: 1792192601852,
};

// The dropped goal keeps GoalModeState.mode as "active" while goal.status becomes "dropped" (raw goal_updated frame).
const DROPPED_GOAL = {
  ...ACTIVE_GOAL,
  status: "dropped" as const,
  updatedAt: 1792192602161,
};

const activeState = { enabled: true, mode: "active" as const, goal: ACTIVE_GOAL };
const pausedState = { enabled: false, mode: "active" as const, goal: PAUSED_GOAL };
const resumedState = { enabled: true, mode: "active" as const, goal: RESUMED_GOAL };
const abortedState = { enabled: false, mode: "active" as const, goal: ABORTED_GOAL };
const droppedState = { enabled: false, mode: "active" as const, goal: DROPPED_GOAL };

export const RECORDED_GOAL_RPC = {
  create: { goal: ACTIVE_GOAL, state: activeState },
  get: { goal: ACTIVE_GOAL, state: activeState },
  pause: { goal: PAUSED_GOAL, state: pausedState },
  resume: { goal: RESUMED_GOAL, state: resumedState },
  afterAbort: { goal: ABORTED_GOAL, state: abortedState },
  drop: { goal: null, state: null },
  afterDrop: { goal: null, state: null },
} satisfies Record<string, GoalRpcResult>;

export const RECORDED_GOAL_UPDATED: readonly GoalUpdatedEvent[] = [
  { type: "goal_updated", goal: ACTIVE_GOAL, state: activeState },
  { type: "goal_updated", goal: PAUSED_GOAL, state: pausedState },
  { type: "goal_updated", goal: RESUMED_GOAL, state: resumedState },
  { type: "goal_updated", goal: ABORTED_GOAL, state: abortedState },
  { type: "goal_updated", goal: DROPPED_GOAL, state: droppedState },
];

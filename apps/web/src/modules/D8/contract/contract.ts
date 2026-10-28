import type { CapabilityKey, PortCallOptions, ThreadId } from "@omp-app/contracts";
import { AppFailure, D8_AP6_UNAVAILABLE_REASONS } from "@omp-app/contracts";
import { z } from "zod";

const OptionalText = z.string().optional();
const UnknownRecord = z.record(z.string(), z.unknown());

/** omp's goal operations (18.12.6 `modes/rpc/rpc-goal.ts:21`), which the chat host's `goal` method keeps. */
export const GoalOperationSchema = z.enum(["get", "create", "resume", "pause", "drop"]);
export type GoalOperation = z.infer<typeof GoalOperationSchema>;

export const GoalStatusSchema = z.enum([
  "active",
  "paused",
  "budget-limited",
  "complete",
  "dropped",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalSchema = z.looseObject({
  id: z.string().min(1),
  objective: z.string(),
  status: GoalStatusSchema,
  tokensUsed: z.number().finite().nonnegative(),
  timeUsedSeconds: z.number().finite().nonnegative(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  tokenBudget: z.number().finite().positive().optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const GoalModeStateSchema = z.looseObject({
  enabled: z.boolean(),
  mode: z.enum(["active", "exiting"]),
  goal: GoalSchema,
  reason: z.literal("completed").optional(),
});
export type GoalModeState = z.infer<typeof GoalModeStateSchema>;

export const GoalStateSchema = z.looseObject({
  goal: GoalSchema.nullable(),
  state: GoalModeStateSchema.nullable(),
  source: z.enum(["request", "event", "reconciled"]),
  sessionSettled: z.boolean(),
});
export type GoalState = z.infer<typeof GoalStateSchema>;

export const GoalArgsSchema = z.looseObject({
  op: GoalOperationSchema,
  objective: z.string().min(1).optional(),
  token_budget: z.number().int().positive().optional(),
});
export type GoalArgs = z.infer<typeof GoalArgsSchema>;

export const GoalResultSchema = z.looseObject({
  goal: GoalSchema.nullable(),
  state: GoalModeStateSchema.nullable(),
});
export type GoalResult = z.infer<typeof GoalResultSchema>;

export const GoalUpdatedEventSchema = z.looseObject({
  type: z.literal("goal_updated"),
  goal: GoalSchema.nullable(),
  state: GoalModeStateSchema.optional(),
});
export type GoalUpdatedEvent = z.infer<typeof GoalUpdatedEventSchema>;

export const GoalCreateRequestSchema = z.strictObject({
  objective: z.string().trim().min(1),
  token_budget: z.number().int().positive().optional(),
});
export type GoalCreateRequest = z.infer<typeof GoalCreateRequestSchema>;

/** AP6 seams for autonomy features omp offers only in its terminal, which the app cannot represent exactly. */
export const D8_AP6_CAPABILITIES = {
  goalLaunch: "upstream.goal-launch",
  goalUpdate: "upstream.goal-update",
  loop: "upstream.loop",
  tanDispatch: "upstream.tan-dispatch",
  vibeWorker: "upstream.vibe-worker",
} as const satisfies Record<string, CapabilityKey>;

export type D8Ap6Capability = (typeof D8_AP6_CAPABILITIES)[keyof typeof D8_AP6_CAPABILITIES];
/** D8 field names mapped to the shared, server/browser capability detail strings. */
export const AP6_UNAVAILABLE_REASONS = {
  goalLaunch: D8_AP6_UNAVAILABLE_REASONS["upstream.goal-launch"],
  goalUpdate: D8_AP6_UNAVAILABLE_REASONS["upstream.goal-update"],
  loop: D8_AP6_UNAVAILABLE_REASONS["upstream.loop"],
  tanDispatch: D8_AP6_UNAVAILABLE_REASONS["upstream.tan-dispatch"],
  vibeWorker: D8_AP6_UNAVAILABLE_REASONS["upstream.vibe-worker"],
} as const satisfies Record<keyof typeof D8_AP6_CAPABILITIES, string>;

/** What omp does with an open goal once a turn ends, as a plain sentence. */
export interface ContinuationStatus {
  readonly label: string;
}

/**
 * omp decides this from its own setting, `goal.continuationModes`: a goal continues in a chat the app runs only when
 * the list includes "rpc" (omp's name for hosts like the app's chat host). `modes` is that value, or `null` when the app cannot read it.
 * A finished or dropped goal has nothing to continue, so it has no status.
 */
export function continuationStatus(
  goal: Goal | null,
  modes: readonly string[] | null,
): ContinuationStatus | null {
  if (goal === null || goal.status === "complete" || goal.status === "dropped") return null;
  if (goal.status === "budget-limited") {
    return { label: "omp stops continuing this goal because it reached its token budget." };
  }
  if (modes === null) {
    return { label: "The app cannot tell whether omp continues this goal by itself." };
  }
  if (!modes.includes("rpc")) {
    return {
      label:
        'omp will not continue this goal by itself. Add "rpc" to Goal Continuation Modes in Settings, Tasks, to let it.',
    };
  }
  return {
    label: goal.status === "paused" ? "Paused" : "omp keeps working on this goal by itself.",
  };
}

export interface AutonomyPort {
  goal(threadId: ThreadId, args: GoalArgs, options?: PortCallOptions): Promise<GoalResult>;
  /** `null` marks an update omp sent that this app could not read; the caller should read the goal again. */
  subscribeGoal(threadId: ThreadId, listener: (event: GoalUpdatedEvent | null) => void): () => void;
}

export const WorkerKindSchema = z.enum(["tan", "vibe", "subagent"]);
export type WorkerKind = z.infer<typeof WorkerKindSchema>;

export const WorkerStatusSchema = z.enum([
  "queued",
  "running",
  "idle",
  "paused",
  "completed",
  "failed",
  "aborted",
]);
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const WorkerObservationSchema = z.looseObject({
  id: z.string().min(1),
  kind: WorkerKindSchema,
  status: WorkerStatusSchema,
  description: OptionalText,
  goalId: OptionalText,
  parentId: OptionalText,
  progress: z.number().finite().min(0).max(1).optional(),
  usage: UnknownRecord.optional(),
  lineage: z.array(z.string()).optional(),
  transcriptRef: UnknownRecord.optional(),
  startedAt: z.number().finite().optional(),
  updatedAt: z.number().finite().optional(),
});
export type WorkerObservation = z.infer<typeof WorkerObservationSchema>;

export const WorkerDispatchRequestSchema = z.strictObject({
  objective: z.string().trim().min(1),
  goalId: z.string().min(1).optional(),
});
export type WorkerDispatchRequest = z.infer<typeof WorkerDispatchRequestSchema>;

export interface WorkerPort {
  observe(threadId: ThreadId, options?: PortCallOptions): Promise<readonly WorkerObservation[]>;
  subscribe(threadId: ThreadId, listener: (worker: WorkerObservation) => void): () => void;
  dispatchTan(
    threadId: ThreadId,
    request: WorkerDispatchRequest,
    options?: PortCallOptions,
  ): Promise<WorkerObservation>;
  startVibe(
    threadId: ThreadId,
    request: WorkerDispatchRequest,
    options?: PortCallOptions,
  ): Promise<WorkerObservation>;
  stop(threadId: ThreadId, workerId: string, options?: PortCallOptions): Promise<void>;
}

export function unavailableAutonomy(capability: D8Ap6Capability, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

export function goalStateFromResult(
  result: GoalResult,
  source: GoalState["source"] = "request",
  sessionSettled = false,
): GoalState {
  return GoalStateSchema.parse({
    goal: result.goal,
    state: result.state,
    source,
    sessionSettled,
  });
}

export function goalStateFromEvent(event: GoalUpdatedEvent, sessionSettled = false): GoalState {
  return goalStateFromResult(
    { goal: event.goal, state: event.state ?? null },
    "event",
    sessionSettled,
  );
}

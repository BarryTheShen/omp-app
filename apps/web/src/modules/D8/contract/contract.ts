import type { CapabilityKey, PortCallOptions, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";

const OptionalText = z.string().optional();
const UnknownRecord = z.record(z.string(), z.unknown());

/** Released goal RPC operations in omp 18.6.1. */
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
  /** Present in newer omp builds; absent at the 18.6.1 wire floor. */
  continuationModes: z.array(z.string()).optional(),
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
  source: z.enum(["rpc", "event", "reconciled"]),
  sessionSettled: z.boolean(),
});
export type GoalState = z.infer<typeof GoalStateSchema>;

export const GoalRpcArgsSchema = z.looseObject({
  op: GoalOperationSchema,
  objective: z.string().min(1).optional(),
  token_budget: z.number().int().positive().optional(),
});
export type GoalRpcArgs = z.infer<typeof GoalRpcArgsSchema>;

export const GoalRpcResultSchema = z.looseObject({
  goal: GoalSchema.nullable(),
  state: GoalModeStateSchema.nullable(),
});
export type GoalRpcResult = z.infer<typeof GoalRpcResultSchema>;

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

/** AP6 seams for terminal-only autonomy features that released RPC cannot represent exactly. */
export const D8_AP6_CAPABILITIES = {
  goalLaunch: "upstream.goal-launch",
  goalUpdate: "upstream.goal-update",
  loop: "upstream.loop",
  tanDispatch: "upstream.tan-dispatch",
  vibeWorker: "upstream.vibe-worker",
} as const satisfies Record<string, CapabilityKey>;

export type D8Ap6Capability = (typeof D8_AP6_CAPABILITIES)[keyof typeof D8_AP6_CAPABILITIES];

export const ContinuationModeSchema = z.enum(["manual", "rpc", "unavailable"]);
export type ContinuationMode = z.infer<typeof ContinuationModeSchema>;

export interface ContinuationPolicy {
  readonly mode: ContinuationMode;
  readonly label: string;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly reason?: string;
}

/** Projects typed goal state and settlement into the controls the UI may honestly expose. */
export function continuationPolicy(
  state: GoalState,
  sessionSettled: boolean = state.sessionSettled,
): ContinuationPolicy {
  const goal = state.goal;
  if (goal === null || goal.status === "complete" || goal.status === "dropped") {
    return {
      mode: "manual",
      label: "Manual continuation",
      canPause: false,
      canResume: false,
    };
  }
  const supportsRpc = goal.continuationModes?.includes("rpc") === true;
  if (!supportsRpc) {
    return {
      mode: "unavailable",
      label: "Autonomous continuation unavailable",
      canPause: false,
      canResume: false,
      reason: "This omp release does not report typed RPC goal continuation.",
    };
  }
  if (goal.status === "paused") {
    return {
      mode: "rpc",
      label: sessionSettled ? "Goal paused" : "Goal pausing",
      canPause: false,
      canResume: true,
    };
  }
  return {
    mode: "rpc",
    label: sessionSettled ? "Goal will continue through omp" : "Goal is settling",
    canPause: true,
    canResume: false,
  };
}

export interface AutonomyPort {
  goal(threadId: ThreadId, args: GoalRpcArgs, options?: PortCallOptions): Promise<GoalRpcResult>;
  subscribeGoal(threadId: ThreadId, listener: (event: GoalUpdatedEvent) => void): () => void;
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

export const AP6_UNAVAILABLE_REASONS = {
  goalLaunch: "Goal launch flags require a typed startup goal seam from omp.",
  goalUpdate: "Editing an active goal or budget requires a typed goal-update seam.",
  loop: "Loop continuation requires a typed loop lifecycle seam; prompts are not resubmitted locally.",
  tanDispatch: "Tan dispatch requires a typed upstream worker command.",
  vibeWorker: "Persistent vibe workers require a typed upstream worker lifecycle.",
} as const satisfies Record<keyof typeof D8_AP6_CAPABILITIES, string>;

export function unavailableAutonomy(capability: D8Ap6Capability, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

export function goalStateFromResult(
  result: GoalRpcResult,
  source: GoalState["source"] = "rpc",
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

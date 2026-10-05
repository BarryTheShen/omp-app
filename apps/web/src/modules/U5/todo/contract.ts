import type { PortCallOptions } from "@omp-app/contracts";
import { AppError as AppErrorSchema, ThreadId } from "@omp-app/contracts";
import { z } from "zod";

/** Canonical todo statuses from omp's released todo/set_todos wire shapes. */
export const TodoStatus = z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]);
export type TodoStatus = z.infer<typeof TodoStatus>;

export const TodoTaskSchema = z.strictObject({
  content: z.string(),
  status: TodoStatus,
  blocker: z.string().optional(),
  details: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
export type TodoTask = z.infer<typeof TodoTaskSchema>;

export const TodoPhaseSchema = z.strictObject({
  name: z.string(),
  tasks: z.array(TodoTaskSchema),
});
export type TodoPhase = z.infer<typeof TodoPhaseSchema>;
export const TodoPhasesSchema = z.array(TodoPhaseSchema);
export type TodoPhases = z.infer<typeof TodoPhasesSchema>;

/** Why R0's immutable todo snapshot most recently changed. */
export const TodoSnapshotSource = z.enum(["state", "set_todos", "tool", "reminder"]);
export type TodoSnapshotSource = z.infer<typeof TodoSnapshotSource>;

export const TodoReminderMetadata = z.strictObject({
  todos: z.array(TodoTaskSchema),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  afterMessage: z.string().min(1).nullable(),
});
export type TodoReminderMetadata = z.infer<typeof TodoReminderMetadata>;

/** U5's immutable projection of R0.1; this is not a second reducer or source of truth. */
export const TodoSnapshot = z.strictObject({
  threadId: ThreadId,
  phases: TodoPhasesSchema,
  source: TodoSnapshotSource,
  sequence: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  reminder: TodoReminderMetadata.nullable(),
  error: AppErrorSchema.nullable(),
});
export type TodoSnapshot = z.infer<typeof TodoSnapshot>;

/** Typed action result: R0's server-returned canonical phase ordering/statuses win. */
export const TodoActionResult = z.strictObject({
  phases: TodoPhasesSchema,
  source: z.literal("set_todos"),
});
export type TodoActionResult = z.infer<typeof TodoActionResult>;

export const TodoActionFailure = z.strictObject({
  error: AppErrorSchema,
  mutated: z.literal(false),
});
export type TodoActionFailure = z.infer<typeof TodoActionFailure>;

/** U5 only consumes this adapter; it never subscribes to A0 or owns a competing todo list. */
export interface TodoStore {
  readonly getSnapshot: () => TodoSnapshot;
  readonly subscribe: (listener: (snapshot: TodoSnapshot) => void) => () => void;
  readonly setTodos: (
    phases: readonly TodoPhase[],
    options?: PortCallOptions,
  ) => Promise<readonly TodoPhase[]>;
}

export interface TodoStoreScope {
  readonly threadId: ThreadId;
}

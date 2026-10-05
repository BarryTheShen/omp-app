import type { AppError, PortCallOptions, ThreadId } from "@omp-app/contracts";
import {
  AppError as AppErrorSchema,
  AppFailure,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import type { OmpRuntimeStore, RuntimeSnapshot, ToolCallState } from "../../../R0/store";
import type {
  TodoPhase,
  TodoReminderMetadata,
  TodoSnapshotSource as TodoSnapshotSourceType,
  TodoStore,
  TodoSnapshot as TodoStoreSnapshot,
  TodoTask,
} from "../contract";
import { TodoPhaseSchema, TodoTaskSchema } from "../contract";

export type TodoRuntimeSource = Pick<OmpRuntimeStore, "getSnapshot" | "subscribe" | "setTodos">;

export interface TodoStoreAdapterOptions {
  readonly store: TodoRuntimeSource;
  readonly now?: () => Date;
}

const UNKNOWN_THREAD_ID = "unknown-thread" as ThreadId;
const MALFORMED_STATE_MESSAGE = "The omp todo state was malformed.";
const MALFORMED_RESULT_MESSAGE = "omp returned malformed todo phases.";

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function internalFailure(message: string, cause?: unknown): AppFailure {
  return new AppFailure(
    { code: "internal", message, retryable: true },
    cause === undefined ? undefined : { cause },
  );
}

function asFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return internalFailure(fallback, error);
}
function withTodoCapability(error: AppFailure): AppFailure {
  if (error.appError.code !== "unavailable" || error.appError.capability !== undefined)
    return error;
  return new AppFailure({ ...error.appError, capability: "omp.cmd.set_todos" });
}

function validThreadId(value: unknown): ThreadId {
  const result = ThreadIdSchema.safeParse(value);
  return result.success ? result.data : UNKNOWN_THREAD_ID;
}

function validSequence(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function timestamp(now: () => Date): string {
  const value = now();
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : new Date(0).toISOString();
}

function sameTask(left: TodoPhase["tasks"][number], right: TodoPhase["tasks"][number]): boolean {
  if (
    left.content !== right.content ||
    left.status !== right.status ||
    left.blocker !== right.blocker ||
    left.details !== right.details
  ) {
    return false;
  }
  if (left.notes === undefined || right.notes === undefined) return left.notes === right.notes;
  return (
    left.notes.length === right.notes.length &&
    left.notes.every((note, index) => note === right.notes?.[index])
  );
}
function freezeTask(task: TodoTask): TodoTask {
  return Object.freeze({
    content: task.content,
    status: task.status,
    ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
    ...(task.details === undefined ? {} : { details: task.details }),
    ...(task.notes === undefined ? {} : { notes: Object.freeze([...task.notes]) }),
  }) as unknown as TodoTask;
}

function samePhases(left: readonly TodoPhase[], right: readonly TodoPhase[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((phase, phaseIndex) => {
    const candidate = right[phaseIndex];
    if (
      !candidate ||
      phase.name !== candidate.name ||
      phase.tasks.length !== candidate.tasks.length
    ) {
      return false;
    }
    return phase.tasks.every((task, taskIndex) => {
      const candidateTask = candidate.tasks[taskIndex];
      return candidateTask !== undefined && sameTask(task, candidateTask);
    });
  });
}

function freezePhases(phases: readonly TodoPhase[]): TodoPhase[] {
  return Object.freeze(
    phases.map((phase) =>
      Object.freeze({
        name: phase.name,
        tasks: Object.freeze(phase.tasks.map((task) => freezeTask(task))),
      }),
    ),
  ) as unknown as TodoPhase[];
}

function parsePhases(value: unknown): { readonly phases: TodoPhase[]; readonly valid: boolean } {
  const parsed = Array.isArray(value) ? TodoPhaseSchema.array().safeParse(value) : undefined;
  if (!parsed?.success) {
    return { phases: Object.freeze([]) as unknown as TodoPhase[], valid: false };
  }
  return { phases: freezePhases(parsed.data), valid: true };
}

function parseReminder(value: unknown): {
  readonly reminder: TodoReminderMetadata | null;
  readonly valid: boolean;
} {
  if (!Array.isArray(value)) return { reminder: null, valid: false };
  const latest = value.at(-1);
  if (latest === undefined) return { reminder: null, valid: true };
  if (typeof latest !== "object" || latest === null || Array.isArray(latest)) {
    return { reminder: null, valid: false };
  }
  const candidate = latest as Record<string, unknown>;
  const todos = Array.isArray(candidate.todos)
    ? candidate.todos.map((task) => TodoTaskSchema.safeParse(task))
    : [];
  if (
    !Array.isArray(candidate.todos) ||
    todos.some((task) => !task.success) ||
    typeof candidate.attempt !== "number" ||
    !Number.isInteger(candidate.attempt) ||
    candidate.attempt < 0 ||
    typeof candidate.maxAttempts !== "number" ||
    !Number.isInteger(candidate.maxAttempts) ||
    candidate.maxAttempts < 0
  ) {
    return { reminder: null, valid: false };
  }
  const afterMessage = candidate.afterMessage;
  const validTodos = todos.flatMap((task) => (task.success ? [task.data] : []));
  const reminder = Object.freeze({
    todos: Object.freeze(validTodos.map((task) => freezeTask(task))),
    attempt: candidate.attempt as number,
    maxAttempts: candidate.maxAttempts as number,
    afterMessage: typeof afterMessage === "string" && afterMessage.length > 0 ? afterMessage : null,
  }) as unknown as TodoReminderMetadata;
  return { reminder, valid: true };
}

function parseError(value: unknown): AppError | null {
  if (value === null || value === undefined) return null;
  const parsed = AppErrorSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

function todoToolChanged(previous: RuntimeSnapshot, next: RuntimeSnapshot): boolean {
  const previousTools = previous.tools as Readonly<Record<string, ToolCallState>>;
  const nextTools = next.tools as Readonly<Record<string, ToolCallState>>;
  const keys = new Set([...Object.keys(previousTools), ...Object.keys(nextTools)]);
  for (const key of keys) {
    const tool = nextTools[key];
    if (
      tool &&
      tool !== previousTools[key] &&
      tool.toolName === "todo" &&
      tool.status === "success"
    ) {
      return true;
    }
  }
  return false;
}

function sourceFor(
  previous: RuntimeSnapshot | undefined,
  next: RuntimeSnapshot,
  phasesChanged: boolean,
): TodoSnapshotSourceType {
  if (previous === undefined) return "state";
  if (next.todoReminders !== previous.todoReminders) return "reminder";
  if (phasesChanged && todoToolChanged(previous, next)) return "tool";
  return "state";
}

function reminderEqual(
  left: TodoReminderMetadata | null,
  right: TodoReminderMetadata | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (
    left.attempt !== right.attempt ||
    left.maxAttempts !== right.maxAttempts ||
    left.afterMessage !== right.afterMessage ||
    left.todos.length !== right.todos.length
  ) {
    return false;
  }
  return left.todos.every((task, index) => {
    const rightTask = right.todos[index];
    return rightTask !== undefined && sameTask(task, rightTask);
  });
}
function sameError(left: AppError | null, right: AppError | null): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.retryable === right.retryable &&
    left.capability === right.capability
  );
}

function freezeReminder(reminder: TodoReminderMetadata | null): TodoReminderMetadata | null {
  if (reminder === null) return null;
  return Object.freeze({
    todos: Object.freeze(reminder.todos.map((task) => freezeTask(task))),
    attempt: reminder.attempt,
    maxAttempts: reminder.maxAttempts,
    afterMessage: reminder.afterMessage,
  }) as unknown as TodoReminderMetadata;
}

/** Adapts R0.1's immutable runtime snapshot without creating a second todo reducer. */
export type TodoSnapshotListener = (snapshot: TodoStoreSnapshot) => void;

export class TodoStoreAdapter implements TodoStore {
  private readonly store: TodoRuntimeSource;
  private readonly now: () => Date;
  private readonly listeners = new Set<TodoSnapshotListener>();
  private readonly unsubscribeRuntime: () => void;
  private runtimeSnapshot: RuntimeSnapshot;
  private snapshot: TodoStoreSnapshot | undefined;
  private sourceHint: TodoSnapshotSourceType = "state";
  private localError: AppError | null = null;

  public constructor(options: TodoStoreAdapterOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.runtimeSnapshot = options.store.getSnapshot();
    this.snapshot = this.toSnapshot(this.runtimeSnapshot, "state");
    this.unsubscribeRuntime = options.store.subscribe(this.onRuntimeSnapshot);
  }

  public getSnapshot(): TodoStoreSnapshot {
    const snapshot = this.snapshot;
    if (!snapshot) throw new Error("TodoStoreAdapter has not initialized its snapshot");
    return snapshot;
  }

  public subscribe(listener: TodoSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    this.unsubscribeRuntime();
    this.listeners.clear();
  }

  public async setTodos(
    phases: readonly TodoPhase[],
    options?: PortCallOptions,
  ): Promise<readonly TodoPhase[]> {
    const parsed = TodoPhaseSchema.array().safeParse(phases);
    if (!parsed.success) throw invalidArgs("Todo phases are malformed");

    this.sourceHint = "set_todos";
    try {
      const result = await this.store.setTodos(parsed.data, options);
      const canonical = TodoPhaseSchema.array().safeParse(result);
      if (!canonical.success) {
        const failure = internalFailure(MALFORMED_RESULT_MESSAGE);
        this.localError = failure.appError;
        this.refresh(this.store.getSnapshot(), "set_todos");
        throw failure;
      }
      this.localError = null;
      this.refresh(this.store.getSnapshot(), "set_todos");
      return freezePhases(canonical.data);
    } catch (error) {
      this.sourceHint = "state";
      const failure = withTodoCapability(asFailure(error, "Setting todos failed"));
      if (error !== failure) {
        this.localError = failure.appError;
        this.refresh(this.store.getSnapshot(), "state");
      }
      throw failure;
    }
  }

  private readonly onRuntimeSnapshot = (snapshot: RuntimeSnapshot): void => {
    const source = this.sourceHint;
    this.sourceHint = "state";
    this.refresh(snapshot, source);
  };

  private refresh(runtime: RuntimeSnapshot, sourceHint: TodoSnapshotSourceType): void {
    const previousRuntime = this.runtimeSnapshot;
    this.runtimeSnapshot = runtime;
    const phasesChanged = runtime.todoPhases !== previousRuntime.todoPhases;
    const source =
      sourceHint !== "state" ? sourceHint : sourceFor(previousRuntime, runtime, phasesChanged);
    const next = this.toSnapshot(runtime, source);
    const previousSnapshot = this.getSnapshot();
    if (
      next.phases === previousSnapshot.phases &&
      reminderEqual(next.reminder, previousSnapshot.reminder) &&
      next.error === previousSnapshot.error &&
      next.source === previousSnapshot.source &&
      next.sequence === previousSnapshot.sequence &&
      next.updatedAt === previousSnapshot.updatedAt
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private toSnapshot(runtime: RuntimeSnapshot, source: TodoSnapshotSourceType): TodoStoreSnapshot {
    const parsedPhases = parsePhases(runtime.todoPhases);
    const parsedReminder = parseReminder(runtime.todoReminders);
    const previousSnapshot = this.snapshot;
    const phases =
      previousSnapshot && samePhases(previousSnapshot.phases, parsedPhases.phases)
        ? previousSnapshot.phases
        : parsedPhases.phases;
    const reminder =
      previousSnapshot && reminderEqual(previousSnapshot.reminder, parsedReminder.reminder)
        ? previousSnapshot.reminder
        : freezeReminder(parsedReminder.reminder);
    const malformed = !parsedPhases.valid || !parsedReminder.valid;
    const candidateError =
      this.localError ??
      parseError(runtime.error) ??
      (malformed
        ? Object.freeze({
            code: "internal" as const,
            message: MALFORMED_STATE_MESSAGE,
            retryable: true,
          })
        : null);
    const previousError = previousSnapshot?.error ?? null;
    const error = sameError(previousError, candidateError)
      ? (previousSnapshot?.error ?? null)
      : candidateError;
    const sequence = validSequence(runtime.revision);
    const unchanged =
      previousSnapshot !== undefined &&
      previousSnapshot.phases === phases &&
      previousSnapshot.reminder === reminder &&
      previousSnapshot.source === source &&
      previousSnapshot.sequence === sequence &&
      sameError(previousError, error);
    return Object.freeze({
      threadId: validThreadId(runtime.threadId),
      phases,
      source,
      sequence,
      updatedAt: unchanged ? previousSnapshot.updatedAt : timestamp(this.now),
      reminder,
      error,
    }) as unknown as TodoStoreSnapshot;
  }
}

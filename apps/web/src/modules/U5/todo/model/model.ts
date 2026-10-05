import type { ThreadId } from "@omp-app/contracts";
import type { TodoPhase, TodoSnapshot, TodoStatus, TodoTask } from "../contract";
import { TodoPhaseSchema, TodoSnapshot as TodoSnapshotSchema } from "../contract";

export interface TodoProgress {
  readonly done: number;
  readonly total: number;
}

export interface TodoTaskModel {
  readonly id: string;
  readonly phaseId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly blocker?: string;
  readonly details?: string;
  readonly notes?: readonly string[];
}

export interface TodoPhaseModel {
  readonly id: string;
  readonly name: string;
  readonly tasks: readonly TodoTaskModel[];
  readonly progress: TodoProgress;
}

export interface TodoModel {
  readonly threadId: ThreadId;
  readonly phases: readonly TodoPhaseModel[];
  readonly progress: TodoProgress;
  readonly currentTask: TodoTaskModel | null;
  readonly source: TodoSnapshot["source"];
  readonly sequence: number;
  readonly updatedAt: string;
  readonly reminder: TodoSnapshot["reminder"];
  readonly error: TodoSnapshot["error"];
}

function hashIdentity(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function phaseId(name: string, occurrence: number): string {
  return `phase-${hashIdentity(`${name}\u0000${occurrence}`)}`;
}

function taskId(phase: TodoPhase, phaseKey: string, content: string, occurrence: number): string {
  return `task-${hashIdentity(`${phase.name}\u0000${phaseKey}\u0000${content}\u0000${occurrence}`)}`;
}

function sameTask(left: TodoTaskModel, right: TodoTask): boolean {
  if (
    left.content !== right.content ||
    left.status !== right.status ||
    left.blocker !== right.blocker ||
    left.details !== right.details
  ) {
    return false;
  }
  const leftNotes = left.notes;
  const rightNotes = right.notes;
  if (leftNotes === undefined || rightNotes === undefined) return leftNotes === rightNotes;
  return (
    leftNotes.length === rightNotes.length &&
    leftNotes.every((note, index) => note === rightNotes[index])
  );
}

function samePhase(left: TodoPhaseModel, right: TodoPhase): boolean {
  if (left.name !== right.name || left.tasks.length !== right.tasks.length) return false;
  return right.tasks.every((task, index) => {
    const previous = left.tasks[index];
    return previous !== undefined && sameTask(previous, task);
  });
}

function progressFor(tasks: readonly TodoTaskModel[]): TodoProgress {
  let done = 0;
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "abandoned") done += 1;
  }
  return Object.freeze({ done, total: tasks.length });
}

function copyTask(
  task: TodoTask,
  phase: TodoPhase,
  phaseKey: string,
  occurrence: number,
  previous: TodoTaskModel | undefined,
): TodoTaskModel {
  const id = taskId(phase, phaseKey, task.content, occurrence);
  if (previous && previous.id === id && sameTask(previous, task)) return previous;
  return Object.freeze({
    id,
    phaseId: phaseKey,
    content: task.content,
    status: task.status,
    ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
    ...(task.details === undefined ? {} : { details: task.details }),
    ...(task.notes === undefined ? {} : { notes: Object.freeze([...task.notes]) }),
  });
}

function projectPhase(
  phase: TodoPhase,
  occurrence: number,
  previous: TodoPhaseModel | undefined,
): TodoPhaseModel {
  const id = phaseId(phase.name, occurrence);
  if (previous?.id === id && samePhase(previous, phase)) return previous;

  const taskOccurrences = new Map<string, number>();
  const previousTasks = new Map(previous?.tasks.map((task) => [task.id, task]));
  const tasks = phase.tasks.map((task) => {
    const occurrenceForContent = taskOccurrences.get(task.content) ?? 0;
    taskOccurrences.set(task.content, occurrenceForContent + 1);
    const idForTask = taskId(phase, id, task.content, occurrenceForContent);
    return copyTask(task, phase, id, occurrenceForContent, previousTasks.get(idForTask));
  });
  const frozenTasks = Object.freeze(tasks);
  return Object.freeze({
    id,
    name: phase.name,
    tasks: frozenTasks,
    progress: progressFor(frozenTasks),
  });
}

function isTodoPhase(value: unknown): value is TodoPhase {
  return TodoPhaseSchema.safeParse(value).success;
}

/** Returns valid omp phases without throwing when a runtime snapshot is malformed. */
export function normalizeTodoPhases(value: unknown): readonly TodoPhase[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const phases: TodoPhase[] = [];
  for (const candidate of value) {
    if (isTodoPhase(candidate)) phases.push(candidate);
  }
  return Object.freeze(phases);
}

/** Projects canonical phases into stable render models while sharing unchanged phase/task objects. */
export function projectTodoPhases(
  value: unknown,
  previous: readonly TodoPhaseModel[] = [],
): readonly TodoPhaseModel[] {
  const phases = normalizeTodoPhases(value);
  const previousById = new Map(previous.map((phase) => [phase.id, phase]));
  const occurrences = new Map<string, number>();
  const projected = phases.map((phase) => {
    const occurrence = occurrences.get(phase.name) ?? 0;
    occurrences.set(phase.name, occurrence + 1);
    const id = phaseId(phase.name, occurrence);
    return projectPhase(phase, occurrence, previousById.get(id));
  });
  return Object.freeze(projected);
}

function aggregateProgress(phases: readonly TodoPhaseModel[]): TodoProgress {
  return Object.freeze({
    done: phases.reduce((sum, phase) => sum + phase.progress.done, 0),
    total: phases.reduce((sum, phase) => sum + phase.progress.total, 0),
  });
}

function currentTaskFor(phases: readonly TodoPhaseModel[]): TodoTaskModel | null {
  for (const status of ["in_progress", "pending"] as const) {
    for (const phase of phases) {
      const current = phase.tasks.find((task) => task.status === status);
      if (current) return current;
    }
  }
  return null;
}

function copyReminder(snapshot: TodoSnapshot): TodoSnapshot["reminder"] {
  if (snapshot.reminder === null) return null;
  return Object.freeze({
    todos: Object.freeze(
      snapshot.reminder.todos.map((task) =>
        Object.freeze({
          content: task.content,
          status: task.status,
          ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
          ...(task.details === undefined ? {} : { details: task.details }),
          ...(task.notes === undefined ? {} : { notes: Object.freeze([...task.notes]) }),
        }),
      ),
    ),
    attempt: snapshot.reminder.attempt,
    maxAttempts: snapshot.reminder.maxAttempts,
    afterMessage: snapshot.reminder.afterMessage,
  }) as unknown as TodoSnapshot["reminder"];
}

/** Projects one validated U5 snapshot without adding a second mutable todo state owner. */
export function projectTodoSnapshot(snapshot: TodoSnapshot, previous?: TodoModel): TodoModel {
  const validated = TodoSnapshotSchema.parse(snapshot);
  const phases = projectTodoPhases(validated.phases, previous?.phases);
  return Object.freeze({
    threadId: validated.threadId,
    phases,
    progress: aggregateProgress(phases),
    currentTask: currentTaskFor(phases),
    source: validated.source,
    sequence: validated.sequence,
    updatedAt: validated.updatedAt,
    reminder: copyReminder(validated),
    error: validated.error,
  });
}

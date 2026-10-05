import { AppFailure } from "@omp-app/contracts";
import type { TodoActionResult, TodoPhase, TodoStore, TodoTask } from "../contract";
import { TodoActionResult as TodoActionResultSchema, TodoPhaseSchema } from "../contract";

export interface TodoTaskSelector {
  readonly kind: "task";
  readonly query: string;
}

export interface TodoPhaseSelector {
  readonly kind: "phase";
  readonly query: string;
}

export type TodoSelector = TodoTaskSelector | TodoPhaseSelector;

export interface TodoAddInput {
  readonly phase: string;
  readonly content: string;
  readonly index?: number;
}

export interface TodoReorderInput {
  readonly phase: string;
  readonly from: number;
  readonly to: number;
}

export interface TodoMutationAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface TodoActionsOptions {
  readonly store: TodoStore;
  readonly canMutate?: () => TodoMutationAvailability;
}

function failure(
  code: "invalid_args" | "not_found" | "conflict" | "unavailable",
  message: string,
): AppFailure {
  return new AppFailure({
    code,
    message,
    retryable: false,
    ...(code === "unavailable" ? { capability: "omp.cmd.set_todos" } : {}),
  });
}

function cloneTask(task: TodoTask, patch: Partial<TodoTask> = {}): TodoTask {
  return { ...task, ...patch, ...(task.notes === undefined ? {} : { notes: [...task.notes] }) };
}

function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => cloneTask(task)),
  }));
}

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function exactOrFuzzy<T extends { readonly name?: string; readonly content?: string }>(
  values: readonly T[],
  query: string,
  label: string,
  field: "name" | "content",
): T {
  const normalized = normalizedQuery(query);
  if (normalized.length === 0) throw failure("invalid_args", `${label} query cannot be empty.`);
  const exact = values.filter((value) => normalizedQuery(value[field] ?? "") === normalized);
  if (exact.length === 1) return exact[0] as T;
  if (exact.length > 1) throw failure("conflict", `${label} query is ambiguous.`);
  const fuzzy = values.filter((value) => normalizedQuery(value[field] ?? "").includes(normalized));
  if (fuzzy.length === 0)
    throw failure("not_found", `No ${label.toLowerCase()} matched "${query}".`);
  if (fuzzy.length > 1) throw failure("conflict", `${label} query is ambiguous.`);
  return fuzzy[0] as T;
}

function phaseIndex(phases: readonly TodoPhase[], query: string): number {
  const match = exactOrFuzzy(phases, query, "Phase", "name");
  return phases.indexOf(match);
}

function taskLocation(
  phases: readonly TodoPhase[],
  query: string,
): { phaseIndex: number; taskIndex: number } {
  const candidates = phases.flatMap((phase, phaseIndex) =>
    phase.tasks.map((task, taskIndex) => ({ ...task, phaseIndex, taskIndex })),
  );
  const match = exactOrFuzzy(candidates, query, "Task", "content");
  return { phaseIndex: match.phaseIndex, taskIndex: match.taskIndex };
}

function checkMutation(options: TodoActionsOptions): void {
  const availability = options.canMutate?.();
  if (availability && !availability.available) {
    throw failure(
      "unavailable",
      availability.reason ?? "Todo edits are unavailable for this runtime.",
    );
  }
}

/** Structured todo mutations. Every successful operation is admitted through R0's setTodos. */
export class TodoActions {
  private readonly store: TodoStore;
  private readonly canMutate: (() => TodoMutationAvailability) | undefined;

  public constructor(options: TodoActionsOptions) {
    this.store = options.store;
    this.canMutate = options.canMutate;
  }

  public async done(selector: TodoSelector): Promise<TodoActionResult> {
    return this.apply(selector.kind === "phase" ? "phase" : "task", selector.query, "completed");
  }

  public async reopen(selector: TodoSelector): Promise<TodoActionResult> {
    return this.apply(selector.kind === "phase" ? "phase" : "task", selector.query, "pending");
  }

  public async add(input: TodoAddInput): Promise<TodoActionResult> {
    checkMutation({ store: this.store, canMutate: this.canMutate });
    const parsed = TodoPhaseSchema.array().safeParse(this.store.getSnapshot().phases);
    if (!parsed.success) throw failure("invalid_args", "The current todo state is malformed.");
    const content = input.content.trim();
    if (content.length === 0) throw failure("invalid_args", "Todo task content cannot be empty.");
    const phases = clonePhases(parsed.data);
    const index = phaseIndex(phases, input.phase);
    const tasks = phases[index]?.tasks;
    if (!tasks) throw failure("not_found", `No phase matched "${input.phase}".`);
    const insertion = input.index ?? tasks.length;
    if (!Number.isInteger(insertion) || insertion < 0 || insertion > tasks.length) {
      throw failure("invalid_args", "Todo insertion index is out of range.");
    }
    tasks.splice(insertion, 0, { content, status: "pending" });
    return this.commit(phases);
  }

  public async remove(selector: TodoSelector): Promise<TodoActionResult> {
    checkMutation({ store: this.store, canMutate: this.canMutate });
    const phases = clonePhases(this.store.getSnapshot().phases);
    if (selector.kind === "phase") {
      const index = phaseIndex(phases, selector.query);
      phases.splice(index, 1);
    } else {
      const location = taskLocation(phases, selector.query);
      phases[location.phaseIndex]?.tasks.splice(location.taskIndex, 1);
    }
    return this.commit(phases);
  }

  public async reorder(input: TodoReorderInput): Promise<TodoActionResult> {
    checkMutation({ store: this.store, canMutate: this.canMutate });
    const phases = clonePhases(this.store.getSnapshot().phases);
    const index = phaseIndex(phases, input.phase);
    const tasks = phases[index]?.tasks;
    if (!tasks || !Number.isInteger(input.from) || !Number.isInteger(input.to)) {
      throw failure("invalid_args", "Todo reorder indices must be integers.");
    }
    if (input.from < 0 || input.from >= tasks.length || input.to < 0 || input.to >= tasks.length) {
      throw failure("invalid_args", "Todo reorder index is out of range.");
    }
    const [task] = tasks.splice(input.from, 1);
    if (!task) throw failure("not_found", "Todo task was not found.");
    tasks.splice(input.to, 0, task);
    return this.commit(phases);
  }

  private async apply(
    kind: "phase" | "task",
    query: string,
    status: TodoTask["status"],
  ): Promise<TodoActionResult> {
    checkMutation({ store: this.store, canMutate: this.canMutate });
    const phases = clonePhases(this.store.getSnapshot().phases);
    if (kind === "phase") {
      const index = phaseIndex(phases, query);
      const phase = phases[index];
      if (!phase) throw failure("not_found", `No phase matched "${query}".`);
      phase.tasks = phase.tasks.map((task) => cloneTask(task, { status }));
    } else {
      const location = taskLocation(phases, query);
      const phase = phases[location.phaseIndex];
      if (!phase) throw failure("not_found", `No phase matched "${query}".`);
      const task = phase.tasks[location.taskIndex];
      if (!task) throw failure("not_found", `No task matched "${query}".`);
      phase.tasks[location.taskIndex] = cloneTask(task, { status });
    }
    return this.commit(phases);
  }

  private async commit(phases: readonly TodoPhase[]): Promise<TodoActionResult> {
    const canonical = await this.store.setTodos(phases);
    return TodoActionResultSchema.parse({ phases: canonical, source: "set_todos" });
  }
}

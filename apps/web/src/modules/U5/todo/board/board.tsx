import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TODO_TASK_STATUS_PRESENTATION, TodoChecklist, TodoTaskStatusIcon } from "../checklist";
import type { TodoModel, TodoPhaseModel, TodoTaskModel } from "../model";

export type TodoPresentationMode = "list" | "board";

export interface TodoViewPreferenceStore {
  readonly get: (threadId: string) => TodoPresentationMode | undefined;
  readonly set: (threadId: string, mode: TodoPresentationMode) => void;
}

const rememberedModes = new Map<string, TodoPresentationMode>();

export const memoryTodoViewPreferences: TodoViewPreferenceStore = {
  get: (threadId) => rememberedModes.get(threadId),
  set: (threadId, mode) => rememberedModes.set(threadId, mode),
};

export interface TodoBoardProps {
  readonly model: TodoModel;
  readonly preferences?: TodoViewPreferenceStore;
}

export function TodoBoard({ model, preferences = memoryTodoViewPreferences }: TodoBoardProps) {
  const [mode, setMode] = useState<TodoPresentationMode>(
    () => preferences.get(String(model.threadId)) ?? "list",
  );
  const changeMode = (next: TodoPresentationMode): void => {
    setMode(next);
    preferences.set(String(model.threadId), next);
  };
  return (
    <section aria-label="Todo presentation" data-testid="todo-board-surface">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Todos</h3>
          <p className="text-muted-foreground text-xs">
            {model.progress.done} of {model.progress.total} done
          </p>
        </div>
        <fieldset className="flex gap-1">
          <legend className="sr-only">Todo presentation mode</legend>
          <Button
            aria-pressed={mode === "list"}
            data-testid="todo-mode-list"
            size="sm"
            type="button"
            variant={mode === "list" ? "secondary" : "ghost"}
            onClick={() => changeMode("list")}
          >
            List
          </Button>
          <Button
            aria-pressed={mode === "board"}
            data-testid="todo-mode-board"
            size="sm"
            type="button"
            variant={mode === "board" ? "secondary" : "ghost"}
            onClick={() => changeMode("board")}
          >
            Board
          </Button>
        </fieldset>
      </div>
      {mode === "list" ? <TodoChecklist model={model} /> : <BoardColumns model={model} />}
    </section>
  );
}

function BoardColumns({ model }: { readonly model: TodoModel }) {
  return (
    <ul
      aria-label="Todo board columns"
      className="grid min-w-0 gap-3 md:grid-cols-2"
      data-testid="todo-board-columns"
    >
      {model.phases.map((phase) => (
        <li key={phase.id}>
          <BoardColumn phase={phase} currentTaskId={model.currentTask?.id} />
        </li>
      ))}
    </ul>
  );
}

function BoardColumn({
  currentTaskId,
  phase,
}: {
  readonly currentTaskId: string | undefined;
  readonly phase: TodoPhaseModel;
}) {
  return (
    <section
      aria-label={`${phase.name}: ${phase.progress.done} of ${phase.progress.total} done`}
      className="border-border bg-card/60 min-w-0 rounded-lg border p-3"
      data-phase-id={phase.id}
    >
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="truncate text-sm font-medium text-foreground">{phase.name}</h4>
        <span className="shrink-0 text-xs text-muted-foreground">
          {phase.progress.done}/{phase.progress.total}
        </span>
      </header>
      <ul className="space-y-1.5">
        {phase.tasks.map((task) => (
          <BoardTask current={task.id === currentTaskId} key={task.id} task={task} />
        ))}
      </ul>
    </section>
  );
}

function BoardTask({ current, task }: { readonly current: boolean; readonly task: TodoTaskModel }) {
  const presentation = TODO_TASK_STATUS_PRESENTATION[task.status];
  return (
    <li
      className={`border-border/70 flex min-w-0 items-start gap-2 rounded-md border px-2 py-2 text-xs ${current ? "bg-info-surface ring-1 ring-info/40" : "bg-background"}`}
      data-current={current ? "true" : "false"}
      data-status={task.status}
    >
      <TodoTaskStatusIcon className="size-3.5" status={task.status} />
      <span className="sr-only">{presentation.label}</span>
      <span className="min-w-0 break-words text-foreground">{task.content}</span>
    </li>
  );
}

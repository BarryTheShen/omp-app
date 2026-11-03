import { ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { currentTask, finished, TodoList, type TodoPhases } from "./TodoList";

/**
 * Above the message box while omp keeps a todo list: how many tasks are done and the one it works on; it opens the
 * whole list, phase by phase.
 */
export function TodoPill({ phases }: { readonly phases: TodoPhases }): ReactNode {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) return null;
  const done = tasks.filter(finished).length;
  const now = currentTask(phases);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            data-tour="todos"
            type="button"
            className="flex h-6 max-w-80 min-w-0 items-center gap-1.5 rounded-full border border-l2 px-2.5 text-xs text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Todos: ${done} of ${tasks.length} done${now === null ? "" : `, now: ${now.content}`}`}
          />
        }
      >
        <ListChecks className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 tabular-nums">
          {done}/{tasks.length}
        </span>
        {now !== null && <span className="min-w-0 truncate">{now.content}</span>}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="max-h-[min(24rem,var(--available-height))] w-96 overflow-y-auto p-3"
      >
        <TodoList phases={phases} />
      </PopoverContent>
    </Popover>
  );
}

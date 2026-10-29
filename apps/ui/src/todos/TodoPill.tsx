import type { ChatHostState } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { Circle, CircleCheck, CircleDot, CircleMinus, CircleSlash, ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type TodoPhases = ChatHostState["todoPhases"];
type TodoTask = TodoPhases[number]["tasks"][number];

/** Each of omp's todo statuses: its word for a screen reader, its icon, and how its text is drawn. */
const STATUS = {
  in_progress: { said: "Now", Icon: CircleDot, icon: "text-accent-ink", text: "text-t1" },
  pending: { said: "To do", Icon: Circle, icon: "text-t3", text: "text-t2" },
  blocked: { said: "Blocked", Icon: CircleSlash, icon: "text-warn-ink", text: "text-t2" },
  completed: { said: "Done", Icon: CircleCheck, icon: "text-ok-ink", text: "text-t3 line-through" },
  abandoned: { said: "Dropped", Icon: CircleMinus, icon: "text-t3", text: "text-t3 line-through" },
} as const satisfies Record<TodoTask["status"], unknown>;

const finished = (task: TodoTask): boolean =>
  task.status === "completed" || task.status === "abandoned";

/** The task omp works on: the first in progress, else the first not finished; null once every task is. */
function currentTask(phases: TodoPhases): TodoTask | null {
  const tasks = phases.flatMap((phase) => phase.tasks);
  return (
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => !finished(task)) ??
    null
  );
}

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
      <PopoverContent align="start" side="top" className="max-h-96 w-96 overflow-y-auto p-3">
        <section aria-label="Todos" className="flex flex-col gap-3">
          {phases.map((phase) => (
            <div key={phase.name}>
              <h3 className="pb-1 text-xs font-medium text-t3">{phase.name}</h3>
              <ul className="flex flex-col gap-1">
                {phase.tasks.map((task) => {
                  const status = STATUS[task.status];
                  return (
                    <li
                      key={task.content}
                      className="flex items-start gap-2 text-sm"
                      aria-label={`${status.said}: ${task.content}`}
                    >
                      <status.Icon
                        className={cn("mt-0.5 size-4 shrink-0", status.icon)}
                        aria-hidden
                      />
                      <span className={cn("min-w-0", status.text)}>
                        {task.content}
                        {task.status === "blocked" && task.blocker !== undefined && (
                          <span className="block text-xs text-t3">{task.blocker}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      </PopoverContent>
    </Popover>
  );
}

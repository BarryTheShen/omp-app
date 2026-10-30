import type { ChatHostState } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { Circle, CircleCheck, CircleDot, CircleMinus, CircleSlash } from "lucide-react";
import type { ReactNode } from "react";

export type TodoPhases = ChatHostState["todoPhases"];
type TodoTask = TodoPhases[number]["tasks"][number];

/** Each of omp's todo statuses: its word for a screen reader, its icon, and how its text is drawn. */
const STATUS = {
  in_progress: { said: "Now", Icon: CircleDot, icon: "text-accent-ink", text: "text-t1" },
  pending: { said: "To do", Icon: Circle, icon: "text-t3", text: "text-t2" },
  blocked: { said: "Blocked", Icon: CircleSlash, icon: "text-warn-ink", text: "text-t2" },
  completed: { said: "Done", Icon: CircleCheck, icon: "text-ok-ink", text: "text-t3 line-through" },
  abandoned: { said: "Dropped", Icon: CircleMinus, icon: "text-t3", text: "text-t3 line-through" },
} as const satisfies Record<TodoTask["status"], unknown>;

export const finished = (task: TodoTask): boolean =>
  task.status === "completed" || task.status === "abandoned";

/** The task omp works on: the first in progress, else the first not finished; null once every task is. */
export function currentTask(phases: TodoPhases): TodoTask | null {
  const tasks = phases.flatMap((phase) => phase.tasks);
  return (
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => !finished(task)) ??
    null
  );
}

/** omp's todo list, phase by phase, each task with its state: the todo pill's popover and the side panel show it. */
export function TodoList({ phases }: { readonly phases: TodoPhases }): ReactNode {
  return (
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
                  <status.Icon className={cn("mt-0.5 size-4 shrink-0", status.icon)} aria-hidden />
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
  );
}

import { ThreadId } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { TodoBoard } from "../board";
import type { TodoSnapshot } from "../contract";
import { projectTodoSnapshot } from "../model";
import { TodoReminderBadge, TodoReminderNotice, type TodoReminderSnapshot } from "./index";

const phases = [
  {
    name: "Build",
    tasks: [
      { content: "Prepare fixture", status: "completed" as const },
      { content: "Run review", status: "in_progress" as const },
      { content: "Publish", status: "pending" as const },
    ],
  },
  { name: "Review", tasks: [{ content: "Approve", status: "pending" as const }] },
];

function makeModel() {
  const snapshot: TodoSnapshot = {
    threadId: ThreadId.parse("u5-reminder-playground"),
    phases,
    source: "state",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  return projectTodoSnapshot(snapshot);
}

function Playground() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement?.classList.contains("dark") ? "dark" : "light",
  );
  const [cleared, setCleared] = useState(false);
  const model = makeModel();
  const reminder: TodoReminderSnapshot = {
    reminder: cleared
      ? null
      : {
          todos: [{ content: "Run review", status: "in_progress" }],
          attempt: 1,
          maxAttempts: 3,
          afterMessage: null,
        },
    badgeCount: cleared ? 0 : 1,
    cleared,
    previousPhases: cleared ? phases : null,
    sequence: cleared ? 2 : 1,
  };

  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);

  return (
    <main
      className="min-h-screen bg-background text-foreground"
      data-testid="todo-reminder-playground"
    >
      <header className="border-border flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">U5.6</p>
          <h1 className="text-sm font-semibold">Todo reminders and board</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TodoReminderBadge count={reminder.badgeCount} />
          <Button
            data-testid="theme-light"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTheme("light")}
          >
            Light
          </Button>
          <Button
            data-testid="theme-dark"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTheme("dark")}
          >
            Dark
          </Button>
          <Button
            data-testid="simulate-clear"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setCleared(true)}
          >
            Simulate clear
          </Button>
        </div>
      </header>
      <section
        className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]"
        data-testid="todo-reminder-surfaces"
      >
        <div className="border-border bg-card min-w-0 rounded-xl border p-4 shadow-sm">
          <TodoReminderNotice
            snapshot={reminder}
            onDismissCleared={() => setCleared(false)}
            onViewPrevious={() => setCleared(false)}
          />
          <div className="mt-4">
            <TodoBoard model={model} />
          </div>
        </div>
        <aside
          className="border-sidebar-border bg-sidebar min-w-0 rounded-xl border p-4"
          data-testid="reminder-panel-toggle"
        >
          <p className="text-sm font-medium">Todo panel</p>
          <p className="text-muted-foreground mt-1 text-xs">Reminder badge stays passive.</p>
          <div className="mt-3">
            <TodoReminderBadge count={reminder.badgeCount} />
          </div>
        </aside>
      </section>
    </main>
  );
}

const root = document.getElementById("u5-todo-reminder-playground-root");
if (!root) throw new Error("U5.6 reminder playground root is missing.");
createRoot(root).render(<Playground />);

import { ThreadId, type ToolCallId } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { ToolRendererProps } from "@/modules/U3/tool-card/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import { projectTodoSnapshot } from "@/modules/U5/todo/model";
import type { TodoSnapshot } from "../contract";
import { TodoToolRenderer } from "../tool-card";
import { TodoChecklist } from "./checklist";

const phases = [
  {
    name: "Build",
    tasks: [
      { content: "Prepare the fixture", status: "completed" as const },
      { content: "Render the checklist", status: "completed" as const },
      { content: "Check the narrow layout", status: "in_progress" as const },
      { content: "Review the screenshot", status: "pending" as const },
    ],
  },
  {
    name: "Ship",
    tasks: [
      { content: "Confirm styles", status: "completed" as const },
      { content: "Publish the change", status: "pending" as const },
      { content: "Announce the result", status: "pending" as const },
    ],
  },
];

function makeModel() {
  const snapshot: TodoSnapshot = {
    threadId: ThreadId.parse("u5-checklist-playground"),
    phases,
    source: "tool",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  return projectTodoSnapshot(snapshot);
}

const toolProps = {
  toolCallId: "todo-playground" as ToolCallId,
  toolName: "todo",
  args: { op: "replace" },
  argsText: '{"op":"replace"}',
  result: { content: [], details: { op: "replace", phases } },
  status: { type: "complete" },
} as unknown as ToolRendererProps;

function Playground() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const root = document.documentElement;
    return root?.classList.contains("dark") ? "dark" : "light";
  });
  const model = makeModel();

  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="todo-playground">
      <header className="border-border flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">U5.4</p>
          <h1 className="text-sm font-semibold">Todo checklist and tool card</h1>
        </div>
        <div className="flex gap-2">
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
          ></Button>
        </div>
      </header>
      <section
        className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]"
        data-testid="todo-surfaces"
      >
        <div className="border-border bg-card min-w-0 rounded-xl border p-4 shadow-sm">
          <TodoChecklist model={model} />
        </div>
        <div className="border-border bg-card min-w-0 rounded-xl border p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold">Todo tool call</h2>
          <TodoToolRenderer {...toolProps} />
        </div>
      </section>
      <aside
        className="border-sidebar-border bg-sidebar fixed inset-y-14 end-0 flex w-full max-w-md border-s shadow-overlay"
        data-u0-right-sidebar="true"
      >
        <PanelShell
          body={<TodoChecklist model={model} />}
          onOpenChange={() => undefined}
          state={{
            open: true,
            lifecycle: "populated",
            position: "right",
            title: "Todo panel",
            description: "Current work",
            error: null,
            readOnly: false,
            pendingUpdates: 0,
          }}
        />
      </aside>
    </main>
  );
}

const root = document.getElementById("u5-todo-playground-root");
if (!root) throw new Error("U5.4 todo playground root is missing.");
createRoot(root).render(<Playground />);

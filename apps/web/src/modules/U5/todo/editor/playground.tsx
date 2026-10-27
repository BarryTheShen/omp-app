import { type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { renderDialogRequest } from "@/modules/U4/dialogs";
import { DialogHostController } from "@/modules/U4/host";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { TodoSnapshot, TodoStore } from "../contract";
import { TodoEditorController } from "./editor";

const threadId = ThreadId.parse("u5-editor-playground");
const capabilities: CapabilityMap = { "omp.ui": { state: "available", via: "rpc" } };

function createStore(): TodoStore {
  let snapshot: TodoSnapshot = {
    threadId,
    phases: [
      {
        name: "Build",
        tasks: [
          { content: "Prepare the fixture", status: "completed" },
          { content: "Edit the Markdown", status: "pending" },
        ],
      },
      { name: "Review", tasks: [{ content: "Confirm replacement", status: "pending" }] },
    ],
    source: "state",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  const listeners = new Set<(next: TodoSnapshot) => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTodos: async (phases) => {
      snapshot = {
        ...snapshot,
        phases: [...phases],
        source: "set_todos",
        sequence: snapshot.sequence + 1,
      };
      for (const listener of listeners) listener(snapshot);
      return phases;
    },
  };
}
function EditorPlayground() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement?.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  const storeRef = useRef<TodoStore | null>(null);
  const controllerRef = useRef<TodoEditorController | null>(null);
  const [status, setStatus] = useState("No edit submitted");
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerDialog: async () => undefined,
      render: renderDialogRequest,
    });
    storeRef.current = createStore();
    controllerRef.current = new TodoEditorController({
      store: storeRef.current,
      dialogs: hostRef.current,
      threadId,
    });
  }
  useEffect(() => () => hostRef.current?.dispose(), []);

  return (
    <main
      className="min-h-screen bg-background text-foreground"
      data-testid="todo-editor-playground"
    >
      <header className="border-border flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">U5.5</p>
          <h1 className="text-sm font-semibold">Todo Markdown editor</h1>
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
          >
            Dark
          </Button>
          <Button
            data-testid="open-todo-editor"
            type="button"
            onClick={() => {
              const controller = controllerRef.current;
              if (!controller) return;
              void controller.open().then((result) => setStatus(result.status));
            }}
          >
            Edit todos
          </Button>
        </div>
      </header>
      <section className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="border-border bg-card rounded-xl border p-5 shadow-sm">
          <p className="text-muted-foreground text-sm">Edit the canonical list as Markdown.</p>
          <p className="mt-2 text-sm" data-testid="editor-status">
            {status}
          </p>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("u5-todo-editor-playground-root");
if (!root) throw new Error("U5.5 todo editor playground root is missing.");
createRoot(root).render(
  <OverlayHost>
    <EditorPlayground />
  </OverlayHost>,
);

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { PanelShell } from "./shell";

function Playground() {
  const [lifecycle, setLifecycle] = useState<"loading" | "empty" | "populated" | "error">(
    "populated",
  );
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const [open, setOpen] = useState(true);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return () => document.documentElement.classList.remove("dark");
  }, [theme]);

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="u5-panel-playground">
      <header className="border-border flex min-h-12 items-center justify-between border-b px-4">
        <h1 className="text-sm font-semibold">U5.2 PanelShell playground</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="state-ready"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setLifecycle("populated")}
          >
            Ready
          </Button>
          <Button
            data-testid="state-loading"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setLifecycle("loading")}
          >
            Loading
          </Button>
          <Button
            data-testid="state-error"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setLifecycle("error")}
          >
            Error
          </Button>
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
        </div>
      </header>
      <aside
        className="border-sidebar-border bg-sidebar fixed inset-y-12 end-0 flex w-full max-w-md border-s shadow-overlay"
        data-u0-right-sidebar="true"
      >
        <PanelShell
          body={
            lifecycle === "populated" ? (
              <div className="space-y-3" data-testid="panel-ready-content">
                <p>Panel content remains readable while live updates arrive.</p>
                <p>Retry count: {retryCount}</p>
              </div>
            ) : lifecycle === "empty" ? (
              <p data-testid="panel-empty-content">No items yet.</p>
            ) : (
              <p>Panel body</p>
            )
          }
          footer={<span className="text-muted-foreground text-xs">U5.2 playground</span>}
          onOpenChange={setOpen}
          onRetry={() => {
            setRetryCount((count) => count + 1);
            setLifecycle("populated");
          }}
          state={{
            open,
            lifecycle,
            position: "right",
            title: "Todo panel",
            description: "Live checklist surface",
            error:
              lifecycle === "error"
                ? { code: "internal", message: "Panel data failed to load.", retryable: true }
                : null,
            readOnly: false,
            pendingUpdates: 0,
          }}
        />
      </aside>
    </main>
  );
}

const root = document.getElementById("u5-panel-playground-root");
if (!root) throw new Error("U5.2 panel playground root is missing.");
createRoot(root).render(<Playground />);

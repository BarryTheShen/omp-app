import type { ToolCallId } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T7ToolFallback } from "./fallback";

const hostProps = {
  toolCallId: "t7-playground" as ToolCallId,
  toolName: "host_tool",
  args: { operation: "read", path: "skill://demo", requestId: "redacted" },
  argsText: '{"operation":"read"}',
  result: {
    status: "unavailable",
    capability: "omp.host-tools",
    available: false,
    reason: "Host tools are unavailable for this runtime.",
    nested: { long: "A recorded value ".repeat(25), type: "string" },
  },
  status: { type: "complete" },
} as unknown as ToolRendererProps;

function Playground() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement?.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);
  return (
    <main
      className="min-h-screen bg-background text-foreground"
      data-testid="t7-fallback-playground"
    >
      <header className="border-border flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">T7.2</p>
          <h1 className="text-sm font-semibold">Host/custom/MCP fallback</h1>
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
        </div>
      </header>
      <section className="mx-auto w-full max-w-3xl px-4 py-8">
        <div className="border-border bg-card rounded-xl border p-5 shadow-sm">
          <T7ToolFallback {...hostProps} />
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("t7-fallback-playground-root");
if (!root) throw new Error("T7 fallback playground root is missing.");
createRoot(root).render(<Playground />);

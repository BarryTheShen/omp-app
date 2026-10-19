import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { BrowserToolCard } from "./browser";
import { BROWSER_RESULT } from "./fixtures/v18.9.1-results";

const rendererProps = {
  type: "tool-call",
  toolCallId: "browser-playground",
  toolName: "browser",
  args: {
    action: "run",
    name: "docs",
    url: "https://bun.sh/docs",
    code: "return document.title",
  },
  argsText: JSON.stringify({ action: "run", name: "docs", url: "https://bun.sh/docs" }),
  result: BROWSER_RESULT,
  status: { type: "complete" },
} as unknown as ToolRendererProps;

export function T4BrowserPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t4-browser-playground"
    >
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header>
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-widest">
            T4 browser
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Browser action</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Render-only action, returned value and screenshot metadata.
          </p>
        </header>
        <BrowserToolCard {...rendererProps} />
      </div>
    </main>
  );
}

const root = document.getElementById("t4-browser-playground-root");
if (root) createRoot(root).render(<T4BrowserPlayground />);

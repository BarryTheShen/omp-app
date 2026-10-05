import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { BrowserToolCard } from "./browser";

function mockBrowserScreenshot(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "royalblue";
  context.fillRect(0, 0, canvas.width, 34);
  context.fillStyle = "white";
  context.fillText("example.test", 16, 22);
  context.fillStyle = "black";
  context.fillText("Retrieved documentation", 16, 70);
  context.fillStyle = "slategray";
  context.fillRect(16, 106, 210, 8);
  context.fillRect(16, 126, 180, 8);
  return canvas.toDataURL("image/png");
}

const browserResult = {
  kind: "browser",
  action: "run",
  name: "docs",
  url: "https://example.test/docs",
  observations: [{ text: "Navigation complete" }, { value: { title: "Retrieved docs" } }],
  screenshots: [
    {
      data: mockBrowserScreenshot(),
    },
  ],
};
const rendererProps = {
  type: "tool-call",
  toolCallId: "browser-playground",
  toolName: "browser",
  args: {
    action: "run",
    name: "docs",
    url: "https://example.test/docs",
    code: "return document.title",
  },
  argsText: JSON.stringify({ action: "run", name: "docs", url: "https://example.test/docs" }),
  result: browserResult,
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
            T4.3 browser
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Browser action</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Render-only action, observation and screenshot state.
          </p>
        </header>
        <BrowserToolCard {...rendererProps} />
      </div>
    </main>
  );
}

const root = document.getElementById("t4-browser-playground-root");
if (root) createRoot(root).render(<T4BrowserPlayground />);

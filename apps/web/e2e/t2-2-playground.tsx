import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GrepCard } from "../src/modules/T2/grep";
import type { ToolRendererProps } from "../src/modules/U3/tool-card/contract";

const props = {
  toolCallId: "grep-e2e" as never,
  toolName: "grep",
  args: { pattern: "TODO", path: "src", case: true, gitignore: true },
  argsText: '{"pattern":"TODO","path":"src"}',
  result: {
    content: [{ type: "text", text: "Found matches" }],
    details: {
      scopePath: "src",
      searchPath: "/repo/src",
      cwd: "/repo",
      matchCount: 3,
      fileCount: 2,
      files: ["src/main.tsx", "src/utils.ts"],
      fileMatches: [
        { path: "src/main.tsx", count: 2 },
        { path: "src/utils.ts", count: 1 },
      ],
      displayContent:
        "# src/\n## main.tsx\n*12│TODO: wire\n*24│TODO: remove\n## utils.ts\n*4│TODO: remove",
      truncated: false,
    },
  },
  status: { type: "complete", reason: "stop" },
} as unknown as ToolRendererProps;

const root = document.getElementById("t2-grep-playground-root");
if (!root) throw new Error("T2 grep playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <main className="min-h-dvh bg-background px-(--space-xl) py-(--space-2xl) text-foreground">
      <h1 className="mx-auto mb-(--space-lg) max-w-3xl text-lg font-semibold">Grep results</h1>
      <div className="mx-auto max-w-3xl">
        <GrepCard {...props} />
      </div>
    </main>
  </StrictMode>,
);

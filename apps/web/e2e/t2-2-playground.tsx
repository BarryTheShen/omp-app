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
      matchCount: 3,
      fileCount: 2,
      meta: { total: 47 },
      fileMatches: [
        {
          path: "src/main.tsx",
          count: 2,
          matches: [
            { line: 12, snippet: "TODO: wire" },
            { line: 24, snippet: "TODO: remove" },
          ],
          snippets: [{ line: 11, snippet: "context before" }],
        },
        { path: "src/utils.ts", count: 1, matches: [{ line: 4, snippet: "TODO: remove" }] },
      ],
      truncated: true,
      fileLimitReached: false,
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

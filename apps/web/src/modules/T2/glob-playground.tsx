import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GlobCard } from "./glob";

function props(
  toolCallId: string,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  pattern = "**/*.ts",
): ToolRendererProps {
  const args = { pattern, path: "src", hidden: false, gitignore: true, limit: 20 };
  return {
    type: "tool-call",
    toolCallId,
    toolName: "glob",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function GlobPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t2-glob-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T2.3 Glob renderer</h1>
        <p className="text-muted-foreground text-sm">
          Matched files, missing scopes and bounded results
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <GlobCard
          rendererProps={props("glob-success", {
            fileCount: 3,
            files: ["src/app.ts", "src/index.ts", "src/lib/util.ts"],
          })}
        />
        <GlobCard
          rendererProps={props(
            "glob-limit",
            {
              fileCount: 57,
              files: Array.from({ length: 20 }, (_, index) => `src/generated-${index + 1}.ts`),
              missingPaths: ["packages/missing"],
              resultLimitReached: 20,
            },
            { type: "complete" },
            "**/*.ts",
          )}
        />
        <GlobCard
          rendererProps={props(
            "glob-empty",
            { fileCount: 0, files: [] },
            { type: "complete" },
            "**/*.does-not-exist",
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t2-glob-playground-root");
if (!root) throw new Error("T2.3 glob playground root is missing.");
createRoot(root).render(<GlobPlayground />);

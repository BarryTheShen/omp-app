import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstEditCard } from "./ast-edit";

function props(
  toolCallId: string,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  const args = {
    ops: [{ pat: "console.log($A)", out: "logger.info($A)" }],
    paths: ["src", "tests"],
  };
  return {
    type: "tool-call",
    toolCallId,
    toolName: "ast_edit",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function AstEditPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t1-ast-edit-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T1.5 AST edit renderer</h1>
        <p className="text-muted-foreground text-sm">
          Structural replacements, parse errors and safety limits
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <AstEditCard
          rendererProps={props("ast-edit-success", {
            totalReplacements: 3,
            filesTouched: 2,
            filesSearched: 14,
            applied: true,
            fileReplacements: [
              { path: "src/logger.ts", before: "console.log(value)", after: "logger.info(value)" },
              {
                path: "tests/logger.test.ts",
                before: "console.log(value)",
                after: "logger.info(value)",
              },
            ],
          })}
        />
        <AstEditCard
          rendererProps={props("ast-edit-limit", {
            totalReplacements: 0,
            filesTouched: 0,
            filesSearched: 50,
            applied: false,
            limitReached: true,
            parseErrors: [{ path: "src/broken.ts", message: "Unexpected token" }],
          })}
        />
        <AstEditCard rendererProps={props("ast-edit-running", undefined, { type: "running" })} />
      </section>
    </main>
  );
}

const root = document.getElementById("t1-ast-edit-playground-root");
if (!root) throw new Error("T1.5 AST edit playground root is missing.");
createRoot(root).render(<AstEditPlayground />);

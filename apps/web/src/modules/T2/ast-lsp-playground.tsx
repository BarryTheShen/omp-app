import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstGrepCard } from "./ast-grep";
import { LspCard } from "./lsp";

function props(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function lspAnswer(action: string, text: string) {
  return {
    content: [{ type: "text", text }],
    details: { serverName: "typescript-language-server", action, success: true },
  };
}

const references = Array.from(
  { length: 27 },
  (_, index) =>
    `  src/services/service-${index + 1}.ts:${index + 4}:9\n    ${index + 4}│const budget = retryBudget(config);`,
);

function AstLspPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t2-ast-lsp-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">AST grep and language server cards</h1>
        <p className="text-muted-foreground text-sm">
          Structural matches, hover, diagnostics, references and a running request
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <AstGrepCard
          rendererProps={props(
            "ast-matches",
            "ast_grep",
            { pat: "console.log($$$ARGS)", path: "src" },
            {
              content: [{ type: "text", text: "3 matches" }],
              details: {
                matchCount: 3,
                fileCount: 2,
                filesSearched: 48,
                limitReached: false,
                parseErrors: [
                  "src/legacy/broken.ts: parse error (syntax tree contains error nodes)",
                ],
                parseErrorsTotal: 1,
                scopePath: "src",
                files: ["src/app.ts", "src/lib/logger.ts"],
                fileMatches: [
                  { path: "src/app.ts", count: 2 },
                  { path: "src/lib/logger.ts", count: 1 },
                ],
                displayContent: [
                  "# src/",
                  "## app.ts",
                  " *14│  console.log(user.id);",
                  " *31│  console.log(",
                  "  32│    total,",
                  "  33│  );",
                  "## lib/",
                  "### logger.ts",
                  "  *8│    console.log(`[${level}]`, message);",
                ].join("\n"),
              },
            },
          )}
        />
        <AstGrepCard
          rendererProps={props(
            "ast-empty",
            "ast_grep",
            { pat: "eval($CODE)", path: "packages" },
            {
              content: [{ type: "text", text: "No matches found" }],
              details: { matchCount: 0, fileCount: 0, filesSearched: 212, limitReached: false },
            },
          )}
        />
        <LspCard
          rendererProps={props(
            "lsp-hover",
            "lsp",
            { action: "hover", file: "src/app.ts", line: 12, symbol: "retryBudget" },
            lspAnswer(
              "hover",
              "```typescript\nfunction retryBudget(config: RetryConfig): number\n```\nReturns how many retries are left for this request.",
            ),
          )}
        />
        <LspCard
          rendererProps={props(
            "lsp-diagnostics",
            "lsp",
            { action: "diagnostics", file: "src/app.ts" },
            lspAnswer(
              "diagnostics",
              [
                "1 error(s), 1 warning(s), 1 info(s):",
                "# src/",
                "## app.ts",
                "  4:7 [error] [typescript] Cannot find name 'retry'. (2304)",
                "  9:1 [warning] [eslint] 'unused' is assigned a value but never used.",
                "  12:3 [info] Consider a const declaration.",
              ].join("\n"),
            ),
          )}
        />
        <LspCard
          rendererProps={props(
            "lsp-references",
            "lsp",
            { action: "references", file: "src/app.ts", line: 12, symbol: "retryBudget" },
            lspAnswer("references", `Found 27 reference(s):\n${references.join("\n")}`),
          )}
        />
        <LspCard
          rendererProps={props(
            "lsp-running",
            "lsp",
            { action: "definition", file: "src/app.ts", line: 40, symbol: "RetryConfig" },
            undefined,
            { type: "running" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t2-ast-lsp-playground-root");
if (!root) throw new Error("The AST grep and language server playground root is missing.");
createRoot(root).render(<AstLspPlayground />);

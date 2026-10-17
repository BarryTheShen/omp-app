import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstEditCard } from "./ast-edit";
import { EditCard } from "./edit";

/** omp's real result is `{ content: [{ type: "text", text }], details }`; a string is raw text from a call that is still streaming. */
function envelope(result: unknown): unknown {
  if (typeof result === "object" && result !== null && "content" in result && "details" in result) {
    return result;
  }
  return typeof result === "string"
    ? result
    : { content: [{ type: "text", text: "" }], details: result };
}

function props(
  toolCallId: string,
  toolName: string,
  result: unknown,
  args: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  isError = false,
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result: envelope(result),
    isError,
    status,
  } as unknown as ToolRendererProps;
}

function EditPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t1-edit-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-5xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">File changes</h1>
        <p className="text-muted-foreground text-sm">Review changed lines and diagnostics.</p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-5xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <EditCard
          rendererProps={props(
            "edit-success",
            "edit",
            {
              path: "src/math.ts",
              op: "update",
              firstChangedLine: 2,
              diff: "@@ -1,3 +1,3 @@\n const first = 1;\n-const second = 2;\n+const second = 3;",
            },
            { path: "src/math.ts", oldText: "const second = 2;", newText: "const second = 3;" },
          )}
        />
        <EditCard
          rendererProps={props(
            "apply-multi",
            "apply_patch",
            {
              perFileResults: [
                {
                  path: "src/a.ts",
                  op: "update",
                  diff: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;",
                },
                {
                  path: "src/b.ts",
                  op: "create",
                  diff: "@@ -0,0 +1,2 @@\n+export const b = true;\n+export default b;",
                  diagnostics: {
                    server: "patch",
                    messages: ["patch: Review generated export"],
                    summary: "Patch warnings: 1",
                    errored: false,
                  },
                },
              ],
              snapshotsPruned: true,
            },
            {
              path: "src/a.ts",
              patch: "*** Begin Patch\n*** Update File: src/a.ts",
              edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
            },
          )}
        />
        <EditCard
          rendererProps={props(
            "apply-failed",
            "apply_patch",
            {
              content: [
                {
                  type: "text",
                  text: "[src/components/main.ts]: Failed to find expected lines in src/components/main.ts:\nold\nNo files were modified — sections apply atomically.",
                },
              ],
              details: {},
            },
            {
              input:
                "*** Begin Patch\n*** Update File: src/components/main.ts\n@@\n-old\n+new\n*** Add File: src/generated.ts\n+export const value = 1;\n*** End Patch",
            },
            { type: "complete" },
            true,
          )}
        />
        <AstEditCard
          rendererProps={props(
            "ast-failed",
            "ast_edit",
            {
              content: [{ type: "text", text: "Duplicate rewrite pattern: legacyCall($A)" }],
              details: {},
            },
            {
              ops: [
                { pat: "legacyCall($A)", out: "modernCall($A)" },
                { pat: "legacyCall($A)", out: "modernCall($A)" },
              ],
              paths: ["src"],
            },
            { type: "complete" },
            true,
          )}
        />
        <EditCard
          rendererProps={props(
            "edit-streaming",
            "edit",
            "@@ -1 +1 @@\n-old value\n+new value",
            { path: "src/live.ts", patch: "@@ -1 +1 @@\n-old value\n+new value" },
            { type: "running" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t1-edit-playground-root");
if (!root) throw new Error("T1.3 edit playground root is missing.");
createRoot(root).render(<EditPlayground />);

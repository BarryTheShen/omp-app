import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { ReadCard } from "./read";

/** omp's real result: `{ content: [{ type: "text", text }], details }`. */
function props(
  toolCallId: string,
  details: unknown,
  args: unknown = { path: "src/index.ts" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "read",
    args,
    argsText: JSON.stringify(args),
    result: { content: [{ type: "text", text: "" }], details },
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

function ReadPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t1-read-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T1.2 Read renderer</h1>
        <p className="text-muted-foreground text-sm">File, URL and image read states</p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <ReadCard
          rendererProps={props("read-text", {
            kind: "file",
            displayTarget: "src/index.ts",
            displayContent: {
              text: "export const answer = 42;\nexport default answer;",
              startLine: 12,
              lineNumbers: true,
            },
          })}
        />
        <ReadCard
          rendererProps={props("read-url", {
            kind: "url",
            url: "skill://review",
            displayTarget: "skill://review",
          })}
        />
        <ReadCard
          rendererProps={props("read-image", {
            kind: "file",
            displayTarget: "assets/logo.png",
            contentType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYAQMAAADaua+7AAAAA1BMVEUlY+vg9LpFAAAADElEQVQI12NgoC0AAABgAAE3kBd4AAAAAElFTkSuQmCC",
          })}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t1-read-playground-root");
if (!root) throw new Error("T1.2 read playground root is missing.");
createRoot(root).render(<ReadPlayground />);

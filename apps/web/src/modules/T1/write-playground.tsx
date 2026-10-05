import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { WriteCard } from "./write";

function props(
  toolCallId: string,
  args: unknown,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "write",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const longSource = Array.from(
  { length: 26 },
  (_, index) => `export const generatedLine${index + 1} = ${index + 1};`,
).join("\n");

function WritePlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t1-write-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T1.4 Write renderer</h1>
        <p className="text-muted-foreground text-sm">
          Streaming source, executable metadata, diagnostics, SVG safety and artifact states
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <WriteCard
          rendererProps={props(
            "write-streaming",
            { path: "src/generated.ts", content: longSource },
            undefined,
            { type: "running" },
          )}
        />
        <WriteCard
          rendererProps={props(
            "write-script",
            { path: "scripts/run.sh", content: "#!/bin/sh\necho ready\n" },
            {
              madeExecutable: true,
              xdev: true,
              message: "Write completed",
              diagnostics: [
                {
                  severity: "warning",
                  path: "scripts/run.sh",
                  line: 2,
                  message: "shellcheck warning",
                },
              ],
              meta: {
                artifactId: "artifact-script-1",
                artifactElidedBytes: 48,
              },
            },
          )}
        />
        <WriteCard
          rendererProps={props(
            "write-svg",
            {
              path: "assets/mark.svg",
              content:
                '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" /></svg>',
            },
            { message: "SVG written" },
          )}
        />
        <WriteCard
          rendererProps={props(
            "write-error",
            { path: "src/blocked.ts", content: "export const retained = true;" },
            { code: "permission", message: "Write denied by host", retryable: false },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t1-write-playground-root");
if (!root) throw new Error("T1.4 write playground root is missing.");
createRoot(root).render(<WritePlayground />);

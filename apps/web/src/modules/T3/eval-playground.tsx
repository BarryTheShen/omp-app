import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { EvalCard } from "./eval";

const CHART_IMAGE = createChartImage();

function createChartImage(): string {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return "";
  const styles = getComputedStyle(document.documentElement);
  context.fillStyle = styles.getPropertyValue("--card").trim() || context.fillStyle;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = styles.getPropertyValue("--primary").trim() || context.strokeStyle;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(16, 96);
  context.lineTo(72, 62);
  context.lineTo(126, 78);
  context.lineTo(184, 32);
  context.lineTo(224, 48);
  context.stroke();
  return canvas.toDataURL("image/png");
}

function props(toolCallId: string, result: unknown, status: unknown): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "eval",
    args: { language: "py", code: "print('hello')", title: "Eval preview" },
    argsText: '{"language":"py","code":"print(hello)"}',
    result,
    status,
  } as unknown as ToolRendererProps;
}

function result(details: Record<string, unknown>, text = "hello") {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function EvalPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t3-eval-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-5xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T3.2 Eval card</h1>
        <p className="text-muted-foreground text-sm">
          Runtime cells, streamed output, async jobs and result images
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-5xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <EvalCard
          rendererProps={props(
            "eval-running",
            result(
              {
                language: "py",
                cells: [
                  {
                    index: 0,
                    code: "print('streaming')",
                    language: "py",
                    status: "running",
                    output: "streaming…",
                  },
                ],
                async: { state: "running", jobId: "job-running", type: "eval" },
                statusEvents: [{ status: "running", message: "Kernel is executing" }],
              },
              "streaming…",
            ),
            { type: "running" },
          )}
        />
        <EvalCard
          rendererProps={props(
            "eval-partial",
            result(
              {
                language: "py",
                cells: [
                  {
                    index: 0,
                    code: "print('partial')",
                    language: "py",
                    status: "running",
                    output: "partial",
                  },
                ],
                statusEvents: [{ status: "running", message: "Receiving output" }],
              },
              "partial output",
            ),
            { type: "requires-action", reason: "tool-calls" },
          )}
        />
        <EvalCard
          rendererProps={props(
            "eval-success",
            result({
              language: "py",
              cells: [
                {
                  index: 0,
                  code: "print('done')",
                  language: "py",
                  status: "complete",
                  output: "done",
                  durationMs: 18,
                  exitCode: 0,
                },
              ],
              jsonOutputs: [{ ok: true, value: 42 }],
              images: [
                {
                  image: CHART_IMAGE,
                },
              ],
              async: { state: "completed", jobId: "job-success", type: "eval" },
            }),
            { type: "complete" },
          )}
        />
        <EvalCard
          rendererProps={props(
            "eval-error",
            result(
              {
                language: "js",
                cells: [
                  {
                    index: 0,
                    code: "throw new Error()",
                    language: "js",
                    status: "error",
                    output: "partial before failure",
                  },
                ],
                isError: true,
                error: {
                  message: "Error: boom",
                  traceback: "Traceback (most recent call last):\\n  Error: boom",
                },
              },
              "partial before failure",
            ),
            { type: "complete" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t3-eval-playground-root");
if (!root) throw new Error("T3.2 eval playground root is missing.");
createRoot(root).render(<EvalPlayground />);

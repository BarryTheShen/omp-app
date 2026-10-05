import { createRoot } from "react-dom/client";
import "../../../index.css";
import { BashCard } from "./bash";
import type { ToolRendererProps } from "./contract";

function props(toolCallId: string, result: unknown, status: unknown): ToolRendererProps {
  const command = toolCallId === "bash-running" ? "printf 'running'" : "printf 'bash output'";
  const cwd = "~/code";
  return {
    type: "tool-call",
    toolCallId,
    toolName: "bash",
    args: { command, cwd },
    argsText: JSON.stringify({ command, cwd }),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function bashResult(output: string, extra: Record<string, unknown> = {}) {
  return {
    output,
    cancelled: false,
    truncated: false,
    totalLines: output.split("\n").length,
    totalBytes: output.length,
    outputLines: output.split("\n").length,
    outputBytes: output.length,
    ...extra,
  };
}

function BashPlayground() {
  const longOutput = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="u3-bash-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">U3.5 Bash renderer</h1>
        <p className="text-muted-foreground text-sm">Running, success and non-zero exit states</p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <BashCard rendererProps={props("bash-running", undefined, { type: "running" })} />
        <BashCard
          rendererProps={props(
            "bash-success",
            bashResult(`\u001b[32mcompleted\u001b[0m\n${longOutput}`, {
              exitCode: 0,
              truncated: true,
            }),
            { type: "complete" },
          )}
        />
        <BashCard
          rendererProps={props(
            "bash-failure",
            bashResult("\u001b[31mfailed\u001b[0m", { exitCode: 2, stderr: "permission denied" }),
            { type: "complete" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("u3-bash-playground-root");
if (!root) throw new Error("U3.5 bash playground root is missing.");
createRoot(root).render(<BashPlayground />);

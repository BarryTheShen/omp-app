import type { ToolCallId } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { ToolCard } from "./card";
import type { ToolCardPhase, ToolCardState } from "./contract";

function cardState(phase: ToolCardPhase, id: string): ToolCardState {
  const result = phase === "success" ? "Command completed successfully" : undefined;
  return {
    toolCallId: id as ToolCallId,
    toolName: "bash",
    label: phase === "error" ? "Run deployment" : "Run bash",
    phase,
    argsText: '{"command":"echo hello","cwd":"~/code"}',
    argsComplete: phase !== "running",
    executionStarted: phase !== "running",
    partialResult: phase === "partial" ? "streamed output…" : undefined,
    result,
    isError: phase === "error",
    error:
      phase === "error"
        ? {
            message: "Command timed out while waiting for the service.",
            retryable: true,
            timeout: true,
          }
        : undefined,
    timedOut: phase === "error",
    outputMeta:
      phase === "partial"
        ? {
            truncation: {
              direction: "tail",
              reason: "lines",
              omittedLines: 18,
              totalLines: 30,
              shownLines: 12,
            },
          }
        : undefined,
  };
}

function CardPlayground() {
  return (
    <div data-testid="u3-card-playground">
      <main className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8">
        <header className="border-border bg-card mx-auto flex w-full max-w-4xl items-center justify-between gap-4 rounded-xl border p-4 shadow-xs">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">U3.2 ToolCard</h1>
            <p className="text-muted-foreground text-sm">
              Shared tool-card lifecycle and disclosure grammar
            </p>
          </div>
        </header>
        <section className="mx-auto mt-6 flex w-full max-w-4xl flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs sm:p-5">
          {(["running", "partial", "success", "error", "cancelled", "unrecorded"] as const).map(
            (phase) => (
              <ToolCard key={phase} state={cardState(phase, `playground-${phase}`)} />
            ),
          )}
        </section>
      </main>
    </div>
  );
}

const root = document.getElementById("u3-card-playground-root");
if (!root) throw new Error("U3.2 card playground root is missing.");
createRoot(root).render(<CardPlayground />);

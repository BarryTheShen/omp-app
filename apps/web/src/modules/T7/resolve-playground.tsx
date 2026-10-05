import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { ResolveCard } from "./resolve";

function props(
  toolCallId: string,
  toolName: "resolve" | "reject",
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args: { action: toolName === "resolve" ? "apply" : "discard" },
    argsText: JSON.stringify({ action: toolName }),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function ResolvePlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t7-resolve-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-3xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T7.3 Resolve and reject renderer</h1>
        <p className="text-muted-foreground text-sm">
          Staged actions, source labels and typed outcomes
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-3xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <ResolveCard
          rendererProps={props(
            "resolve-pending",
            "resolve",
            {
              action: "apply",
              reason: "Waiting for the operator to approve device access",
              sourceToolName: "host_tool",
            },
            { type: "running" },
          )}
        />
        <ResolveCard
          rendererProps={props("resolve-approved", "resolve", {
            action: "apply",
            reason: "Approved by policy",
            label: "URI access",
          })}
        />
        <ResolveCard
          rendererProps={props("reject-rejected", "reject", {
            action: "discard",
            reason: "Operator rejected the request",
            label: "URI access",
          })}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t7-resolve-playground-root");
if (!root) throw new Error("T7.3 resolve playground root is missing.");
createRoot(root).render(<ResolvePlayground />);

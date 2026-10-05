import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { HubCard } from "./hub";
import { WaitCard } from "./wait";

function rendererProps(toolName: string, result: unknown): ToolRendererProps {
  return {
    toolCallId: `${toolName}-playground`,
    toolName,
    args: {},
    argsText: "{}",
    result,
  } as unknown as ToolRendererProps;
}

const hubResult = {
  op: "send",
  target: "agent-1",
  status: "delivered",
  durationMs: 1_250,
  jobs: [{ id: "job-1", type: "task", status: "running", label: "Analyze", completion: 40 }],
  messages: [
    { id: "msg-1", from: "alice", to: "bob", text: "Please inspect the failing fixture." },
  ],
  receipts: [{ id: "receipt-1", accepted: true, delivered: true, messageId: "msg-1" }],
};

const waitResult = {
  op: "wait",
  sealed: true,
  durationMs: 2_000,
  summary: { estimate: "soon", total: 3 },
  jobs: [
    { id: "running", type: "task", status: "running", model: "model-a", thinking: "high" },
    { id: "done", type: "task", status: "completed", result: "fixture complete" },
    { id: "failed", type: "task", status: "failed", result: "worker failed" },
    { id: "cancelled", type: "task", status: "cancelled" },
  ],
};

function Playground() {
  const [showWait, setShowWait] = useState(true);
  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="t5-playground">
      <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">T5.3 Coordination cards</h1>
          <p className="text-muted-foreground text-sm">
            Hub jobs, IRC receipts, polling counts, sealing, and artifacts
          </p>
        </div>
        <button
          className="border-border rounded border px-3 py-1.5 text-xs"
          data-testid="toggle-wait"
          type="button"
          onClick={() => setShowWait((value) => !value)}
        >
          {showWait ? "Hide wait" : "Show wait"}
        </button>
      </header>
      <section className="mx-auto grid w-full max-w-3xl gap-6 px-6 py-12">
        <HubCard rendererProps={rendererProps("hub", hubResult)} />
        {showWait && <WaitCard rendererProps={rendererProps("wait", waitResult)} />}
      </section>
    </main>
  );
}

const root = document.getElementById("t5-playground-root");
if (!root) throw new Error("T5.3 playground root is missing.");
createRoot(root).render(<Playground />);

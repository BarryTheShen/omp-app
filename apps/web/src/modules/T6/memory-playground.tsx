import { createRoot } from "react-dom/client";
import { AppShell } from "@/shell";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { RecallRenderer } from "./recall";
import { ReflectRenderer } from "./reflect";

const RECALL_PROPS = {
  toolCallId: "call-recall-fixture",
  toolName: "recall",
  args: { query: "prior release decision" },
  argsText: '{"query":"prior release decision"}',
  result: {
    content: [
      {
        type: "text",
        text: "Release decision: keep the browser client read-only.\nFollow-up: gate upstream collaboration.",
      },
    ],
    details: { count: 2 },
  },
  status: { type: "complete", reason: "stop" },
} as unknown as ToolRendererProps;

const REFLECT_PROPS = {
  toolCallId: "call-reflect-fixture",
  toolName: "reflect",
  args: { query: "What changed?", context: "release" },
  argsText: '{"query":"What changed?","context":"release"}',
  result: {
    content: [
      {
        type: "text",
        text: "# Synthesis\n\nThe release kept the browser client read-only.\n\n- Collaboration remains capability-gated.\n- Memory text stays bounded.",
      },
    ],
    details: {},
  },
  status: { type: "complete", reason: "stop" },
} as unknown as ToolRendererProps;

function MemoryPlayground() {
  return (
    <AppShell
      leftSidebar={<div className="p-4 text-xs">T6 memory fixture</div>}
      rightSidebar={<div className="p-4 text-xs">Memory handoff</div>}
      threadHeader={<div className="text-sm font-medium">Memory tools</div>}
      transcript={
        <div className="h-full overflow-y-auto px-6 py-6">
          <RecallRenderer {...RECALL_PROPS} />
          <ReflectRenderer {...REFLECT_PROPS} />
        </div>
      }
    />
  );
}

const root = document.getElementById("t6-memory-playground-root");
if (!root) throw new Error("T6 memory playground root is missing.");
createRoot(root).render(<MemoryPlayground />);

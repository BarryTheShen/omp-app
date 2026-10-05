import { createRoot } from "react-dom/client";
import { AppShell } from "@/shell";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { LearnRenderer } from "./learn";
import { ManageSkillRenderer } from "./manage-skill";
import { MemoryEditRenderer } from "./memory-edit";
import { RecallRenderer } from "./recall";
import { ReflectRenderer } from "./reflect";
import { RetainRenderer } from "./retain";

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
const RETAIN_PROPS = {
  toolCallId: "call-retain-fixture",
  toolName: "retain",
  args: {
    items: [
      { content: "Keep the browser client read-only.", scope: "project" },
      { content: "Collaboration remains capability-gated.", scope: "global" },
      { content: "A third item failed", scope: "project" },
    ],
  },
  argsText: '{"items":[{"content":"Keep the browser client read-only."}]}',
  result: {
    content: [],
    details: {
      count: 3,
      stored: 2,
      failed: [{ reason: "backend rejected item 3" }],
    },
  },
  status: { type: "complete", reason: "stop" },
} as unknown as ToolRendererProps;
const LEARN_PROPS = {
  toolCallId: "call-learn-fixture",
  toolName: "learn",
  args: {
    memory: "Keep the browser client read-only.",
    scope: "project",
    skill: { action: "create", name: "release" },
  },
  argsText: '{"memory":"Keep the browser client read-only."}',
  result: {
    content: [{ type: "text", text: "Lesson stored." }],
    details: { skill: "created" },
  },
  status: { type: "complete", reason: "stop" },
} as unknown as ToolRendererProps;

const MANAGE_SKILL_PROPS = {
  toolCallId: "call-manage-skill-fixture",
  toolName: "manage_skill",
  args: {
    action: "update",
    name: "release",
    body: `# Release

Keep reviews compact.`,
  },
  argsText: '{"action":"update","name":"release"}',
  result: {
    content: [{ type: "text", text: "Updated managed skill" }],
    details: { action: "update", name: "release" },
  },
  status: { type: "complete", reason: "stop" },
} as unknown as ToolRendererProps;

const MEMORY_EDIT_PROPS = {
  toolCallId: "call-memory-edit-fixture",
  toolName: "memory_edit",
  args: { op: "forget", id: "memory-1" },
  argsText: '{"op":"forget","id":"memory-1"}',
  result: {
    content: [{ type: "text", text: "Memory memory-1 forgotten." }],
    details: { status: "forgotten", id: "memory-1" },
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
          <RetainRenderer {...RETAIN_PROPS} />
          <LearnRenderer {...LEARN_PROPS} />
          <ManageSkillRenderer {...MANAGE_SKILL_PROPS} />
          <MemoryEditRenderer {...MEMORY_EDIT_PROPS} />
        </div>
      }
    />
  );
}

const root = document.getElementById("t6-memory-playground-root");
if (!root) throw new Error("T6 memory playground root is missing.");
createRoot(root).render(<MemoryPlayground />);

import type { ThreadMessage, ThreadMessageLike } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  fromThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ToolCallId } from "@omp-app/contracts";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { Section } from "@/components/blocks";
import { convertMessage } from "@/modules/R0/runtime/runtime";
import type { ToolRendererMap } from "@/modules/U1/tool-slots";
import { BashToolRenderer } from "./bash";
import type { ToolRenderer } from "./contract";
import { NestedTranscript } from "./nested";

const COMPLETE: Parameters<typeof fromThreadMessageLike>[2] = {
  type: "complete",
  reason: "stop",
};

function threadMessage(message: ThreadMessageLike, fallbackId: string): ThreadMessage {
  return fromThreadMessageLike(message, fallbackId, COMPLETE);
}

const greatGrandchildMessage = threadMessage(
  { id: "great-grandchild-assistant", role: "assistant", content: "Great-grandchild response." },
  "great-grandchild-assistant",
);
const grandchildMessage = threadMessage(
  {
    id: "grandchild-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "Deepest response." },
      {
        type: "tool-call",
        toolCallId: "bash-third-level",
        toolName: "bash",
        args: { command: "echo nested" },
        result: {
          content: [{ type: "text", text: "Nested bash output." }],
          details: { exitCode: 0 },
        },
      },
      {
        type: "tool-call",
        toolCallId: "fallback-third-level",
        toolName: "some_mcp_tool",
        args: { operation: "read" },
        result: { content: [{ type: "text", text: "Fallback result." }] },
      },
      {
        type: "tool-call",
        toolCallId: "great-grandchild-call",
        toolName: "probe",
        args: { task: "great-grandchild" },
        messages: [greatGrandchildMessage],
      },
    ],
  },
  "grandchild-assistant",
);
const childMessage = threadMessage(
  {
    id: "child-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "Nested response." },
      {
        type: "tool-call",
        toolCallId: "grandchild-call",
        toolName: "probe",
        args: { task: "grandchild" },
        messages: [grandchildMessage],
      },
    ],
  },
  "child-assistant",
);
const parentMessages: readonly ThreadMessageLike[] = [
  { id: "parent-user", role: "user", content: "Read the nested transcript." },
  {
    id: "parent-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "The parent task called a child." },
      {
        type: "tool-call",
        toolCallId: "child-call",
        toolName: "probe",
        args: { task: "child" },
        messages: [childMessage],
      },
    ],
  },
];

const firstTaskMessage = threadMessage(
  { id: "first-task-message", role: "assistant", content: "First task transcript." },
  "first-task-message",
);
const secondTaskMessage = threadMessage(
  { id: "second-task-message", role: "assistant", content: "Second task transcript." },
  "second-task-message",
);
const multipleTaskMessages: readonly ThreadMessageLike[] = [
  threadMessage(
    {
      id: "multiple-task-assistant",
      role: "assistant",
      content: [
        { type: "text", text: "The parent started two tasks." },
        {
          type: "tool-call",
          toolCallId: "task-a",
          toolName: "probe",
          args: { task: "first" },
          messages: [firstTaskMessage],
        },
        { type: "text", text: "Between the two tasks." },
        {
          type: "tool-call",
          toolCallId: "task-b",
          toolName: "probe",
          args: { task: "second" },
          messages: [secondTaskMessage],
        },
      ],
    },
    "multiple-task-assistant",
  ),
];

const pairedResultMessages: readonly ThreadMessageLike[] = [
  convertMessage({
    role: "assistant",
    id: "paired-call-message",
    content: [
      {
        type: "toolCall",
        id: "paired-bash-call",
        name: "bash",
        arguments: { command: "echo paired" },
      },
    ],
    stopReason: "toolUse",
  }),
  convertMessage({
    role: "toolResult",
    id: "paired-result-message",
    toolCallId: "paired-bash-call",
    toolName: "bash",
    content: [{ type: "text", text: "Paired bash output." }],
    isError: false,
  }),
];

const repeatedTaskMessages: readonly ThreadMessageLike[] = [
  threadMessage(
    {
      id: "repeated-task-assistant",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "cycle-parent",
          toolName: "probe",
          args: { task: "repeat" },
          messages: [greatGrandchildMessage],
        },
      ],
    },
    "repeated-task-assistant",
  ),
];
const deepTaskMessages: readonly ThreadMessageLike[] = [
  threadMessage(
    {
      id: "deep-task-assistant",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "depth-child",
          toolName: "probe",
          args: { task: "deep" },
          messages: [greatGrandchildMessage],
        },
      ],
    },
    "deep-task-assistant",
  ),
];
const fanoutCycleMessages: ThreadMessage[] = [];
fanoutCycleMessages.push(
  threadMessage(
    {
      id: "fanout-cycle-assistant",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "cycle-first",
          toolName: "probe",
          args: { task: "first cycle" },
          messages: fanoutCycleMessages,
        },
        {
          type: "tool-call",
          toolCallId: "cycle-second",
          toolName: "probe",
          args: { task: "second cycle" },
          messages: fanoutCycleMessages,
        },
      ],
    },
    "fanout-cycle-assistant",
  ),
);
const rejectedMessages: readonly ThreadMessageLike[] = [
  {
    id: "rejected-system-message",
    role: "system",
    content: [
      { type: "text", text: "The first unsupported part." },
      { type: "text", text: "The second unsupported part." },
    ],
  },
];

const probeRenderer: ToolRenderer = ({ toolCallId, toolName }) => (
  <div data-testid={`nested-tool-renderer-${toolCallId}`}>{toolName} renderer from the parent</div>
);
const toolRenderers: ToolRendererMap = { bash: BashToolRenderer, probe: probeRenderer };
const cycleParentTaskId = ToolCallId.parse("cycle-parent");

function NestedPlayground() {
  const runtime = useExternalStoreRuntime({
    messages: useMemo<readonly ThreadMessage[]>(() => [], []),
    isRunning: false,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
        data-testid="u3-nested-playground"
      >
        <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4">
          <Section
            description="Nested messages reuse the parent tool renderer and stay read-only."
            heading="Nested transcript"
          >
            <div data-testid="nested-recursion-case">
              <NestedTranscript
                depth={0}
                messages={parentMessages}
                parentTaskId={ToolCallId.parse("parent-task")}
                toolRenderers={toolRenderers}
              />
            </div>
          </Section>
          <Section heading="Empty transcript" variant="plain">
            <NestedTranscript depth={0} messages={[]} toolRenderers={toolRenderers} />
          </Section>
          <Section heading="Multiple tasks" variant="plain">
            <div data-testid="multiple-task-case">
              <NestedTranscript
                depth={0}
                messages={multipleTaskMessages}
                toolRenderers={toolRenderers}
              />
            </div>
          </Section>
          <Section heading="Paired tool result" variant="plain">
            <div data-testid="paired-tool-result-case">
              <NestedTranscript
                depth={0}
                messages={pairedResultMessages}
                toolRenderers={toolRenderers}
              />
            </div>
          </Section>
          <Section heading="Repeated task" variant="plain">
            <NestedTranscript
              depth={0}
              messages={repeatedTaskMessages}
              parentTaskId={cycleParentTaskId}
              toolRenderers={toolRenderers}
            />
          </Section>
          <Section heading="Circular transcript with multiple tasks" variant="plain">
            <NestedTranscript
              depth={0}
              messages={fanoutCycleMessages}
              toolRenderers={toolRenderers}
            />
          </Section>
          <Section heading="Unsupported message" variant="plain">
            <NestedTranscript depth={0} messages={rejectedMessages} toolRenderers={toolRenderers} />
          </Section>
          <Section heading="Deep transcript" variant="plain">
            <NestedTranscript
              depth={31}
              messages={deepTaskMessages}
              toolRenderers={toolRenderers}
            />
          </Section>
        </div>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("u3-nested-playground-root");
if (!root) throw new Error("The nested transcript playground root is missing.");
createRoot(root).render(<NestedPlayground />);

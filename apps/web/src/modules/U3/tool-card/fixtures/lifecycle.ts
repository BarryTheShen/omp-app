import type { NestedTranscriptSource, NormalizeToolCallInput, ToolCardState } from "../contract";

/** One call as the chat delivers it, and the state the normalizer must give it. */
export interface ToolCardFixture {
  /** The lifecycle state or shape the fixture stands for. */
  readonly name: string;
  readonly input: NormalizeToolCallInput;
  /** Fields the normalized `ToolCardState` must carry. */
  readonly expect: Partial<ToolCardState>;
  /** The header label of the generic card (the phase's word), when the generic card shows one. */
  readonly label?: string;
}

/** A nested task whose transcript has no messages yet. */
const EMPTY_NESTED: NestedTranscriptSource = { depth: 1, messages: [] };

/**
 * Every lifecycle state the card grammar has to show, each built as omp delivers it. Renderers for T1 to T7 are checked
 * against this list through the same normalizer, so a state is shown the same way in every module.
 */
export const TOOL_CARD_FIXTURES: readonly ToolCardFixture[] = [
  {
    name: "running: the call has started and has no result",
    input: {
      toolCallId: "call-running",
      toolName: "custom_tool",
      args: { path: "src/app.ts" },
      argsText: '{"path":"src/app.ts"}',
      status: { type: "running" },
    },
    expect: { phase: "running" },
    label: "Running",
  },
  {
    name: "partial: args and output are still arriving",
    input: {
      toolCallId: "call-partial",
      toolName: "custom_tool",
      args: { path: "src/app.ts" },
      argsText: '{"path":"src/app.ts"}',
      result: "partial output",
      status: { type: "requires-action", reason: "interrupt" },
    },
    expect: { phase: "partial", partialResult: "partial output" },
    label: "Streaming",
  },
  {
    name: "success: a finished call, shown collapsed",
    input: {
      toolCallId: "call-success",
      toolName: "custom_tool",
      args: { path: "src/app.ts" },
      argsText: '{"path":"src/app.ts"}',
      result: { ok: true, text: "done" },
      status: { type: "complete" },
    },
    expect: { phase: "success", isError: false },
    label: "Complete",
  },
  {
    name: "non-zero error: omp reported the call as failed",
    input: {
      toolCallId: "call-error",
      toolName: "custom_tool",
      args: { path: "src/app.ts" },
      argsText: '{"path":"src/app.ts"}',
      result: { ok: false, text: "exit 2" },
      isError: true,
      status: { type: "incomplete", reason: "error", error: "exit 2" },
    },
    expect: { phase: "error", isError: true },
    label: "Error",
  },
  {
    // The result omp's bash tool sends when the command times out: the output with omp's notice in `content`, `details.timedOut`
    // and an error result (packages/coding-agent/src/tools/bash.ts:748-762, omp v18.8.9). Only the bash card reads `details.timedOut`;
    // the generic normalizer reads a top-level `timedOut`, which omp's tool result does not carry, so it reports the error alone.
    name: "timeout: omp's bash result says the command timed out",
    input: {
      toolCallId: "call-timeout",
      toolName: "bash",
      args: { command: "sleep 600" },
      argsText: '{"command":"sleep 600"}',
      result: {
        content: [
          { type: "text", text: "partial output\n\n[Command timed out after 600 seconds]" },
        ],
        details: { timeoutSeconds: 600, timedOut: true },
      },
      isError: true,
      status: { type: "complete" },
    },
    expect: { phase: "error", isError: true },
  },
  {
    name: "cancellation: the person stopped the call",
    input: {
      toolCallId: "call-cancelled",
      toolName: "custom_tool",
      args: { path: "src/app.ts" },
      argsText: '{"path":"src/app.ts"}',
      status: { type: "incomplete", reason: "cancelled" },
    },
    expect: { phase: "cancelled", cancelled: true },
    label: "Cancelled",
  },
  {
    name: "background bash: omp moved the command to a background job",
    input: {
      toolCallId: "call-background",
      toolName: "bash",
      args: { command: "sleep 300" },
      argsText: '{"command":"sleep 300"}',
      result: {
        content: [
          { type: "text", text: "Backgrounded as job bg_1; its output is injected later." },
        ],
        details: { async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 300 },
      },
      isError: false,
      status: { type: "complete" },
    },
    expect: { phase: "success", isError: false },
  },
  {
    name: "large output with an artifact: the shown part is truncated and the full output is stored",
    input: {
      toolCallId: "call-large",
      toolName: "bash",
      args: { command: "cat big.log" },
      argsText: '{"command":"cat big.log"}',
      result: { content: [{ type: "text", text: "line 1\nline 2" }], details: {} },
      outputMeta: {
        truncation: {
          direction: "tail",
          reason: "lines",
          totalLines: 90000,
          shownLines: 2,
          omittedLines: 89998,
          artifactId: "artifact-1",
          artifactElidedBytes: 4096,
        },
        artifactId: "artifact-1",
      },
      status: { type: "complete" },
    },
    expect: {
      phase: "success",
      isError: false,
      outputMeta: {
        artifactId: "artifact-1",
        truncation: { direction: "tail", reason: "lines", shownLines: 2, omittedLines: 89998 },
      },
    },
  },
  {
    name: "generic fallback: a tool with no renderer of its own",
    input: {
      toolCallId: "call-generic",
      toolName: "custom_tool",
      args: { anything: "at all" },
      argsText: '{"anything":"at all"}',
      result: { ok: true },
      status: { type: "complete" },
    },
    expect: { phase: "success" },
    label: "Complete",
  },
  {
    name: "attached tool-result image: the result carries a picture",
    input: {
      toolCallId: "call-image",
      toolName: "custom_tool",
      args: { target: "screen" },
      argsText: '{"target":"screen"}',
      result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
      status: { type: "complete" },
    },
    expect: { phase: "success" },
    label: "Complete",
  },
  {
    name: "nested empty: a task whose transcript has no messages",
    input: {
      toolCallId: "call-nested-empty",
      toolName: "task",
      args: { task: "check" },
      argsText: '{"task":"check"}',
      nested: EMPTY_NESTED,
      status: { type: "running" },
    },
    expect: { phase: "running", nested: EMPTY_NESTED },
  },
  {
    name: "nested deep: a task at the depth limit",
    input: {
      toolCallId: "call-nested-deep",
      toolName: "task",
      args: { task: "deep" },
      argsText: '{"task":"deep"}',
      nested: { depth: 32, messages: [] },
      status: { type: "running" },
    },
    expect: { phase: "running", nested: { depth: 32, messages: [] } },
  },
  {
    name: "nested cycle: a task whose parent is already on its path (the transcript shows it as unavailable)",
    input: {
      toolCallId: "call-nested-cycle",
      toolName: "task",
      args: { task: "loop" },
      argsText: '{"task":"loop"}',
      nested: {
        parentTaskId: "task-root" as NestedTranscriptSource["parentTaskId"],
        depth: 2,
        messages: [],
      },
      status: { type: "running" },
    },
    expect: {
      phase: "running",
      nested: {
        parentTaskId: "task-root" as NestedTranscriptSource["parentTaskId"],
        depth: 2,
        messages: [],
      },
    },
  },
  {
    name: "stable concurrent ids: the first of two calls that run at once",
    input: {
      toolCallId: "call-concurrent-a",
      toolName: "custom_tool",
      args: { lane: "a" },
      argsText: '{"lane":"a"}',
      status: { type: "running" },
    },
    expect: { phase: "running" },
    label: "Running",
  },
  {
    name: "stable concurrent ids: the second of two calls that run at once",
    input: {
      toolCallId: "call-concurrent-b",
      toolName: "custom_tool",
      args: { lane: "b" },
      argsText: '{"lane":"b"}',
      status: { type: "running" },
    },
    expect: { phase: "running" },
    label: "Running",
  },
];

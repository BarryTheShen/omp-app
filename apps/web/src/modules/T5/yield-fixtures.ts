import type { ToolRendererProps } from "../U3/tool-card/contract";

/*
 * Yield results in the shapes omp returns. The details shapes come from 1,696 real yield results in the sessions on
 * this machine. The text and data are replaced, so no chat content is in the repository. The texts of skipped and
 * stopped calls are omp's own, from packages/agent/src/agent-loop.ts (line numbers in each fixture). Two states are in
 * no real result: a schema-override acceptance and a workpool completion; their shapes come from omp's yield.ts.
 */

export interface YieldFixture {
  readonly id: string;
  readonly title: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: "running" | "complete";
  /** The call failed: omp threw, so the result text is the reason (assistant-ui's `isError`). */
  readonly isError?: boolean;
  /** omp's tool result; absent while the call runs. */
  readonly result?: unknown;
}

/** omp's words for a call a steering message skipped (agent-loop.ts:4021; the reason is "pending parent steering message"). */
const STEERING_SKIP_TEXT =
  "Skipped due to pending parent steering message. Do not count this skipped result as completed work or verification. After the steering message is handled on the next step, retry the skipped tool if it is still needed.";

export const YIELD_FIXTURES: readonly YieldFixture[] = [
  // Real shape: content "Result submitted.", details { data, status: "success" } (yield.ts:656-667).
  {
    id: "success-data",
    title: "Structured result submitted",
    args: { data: { summary: "Three findings", count: 3 } },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Result submitted." }],
      details: { data: { summary: "Three findings", count: 3 }, status: "success" },
    },
  },
  // Real shape: an incremental section, details { data, status, type: [label] } (type is an array of one label).
  {
    id: "section",
    title: "One section of an incremental submission",
    args: { type: ["findings"], data: { id: "F-1", severity: "low" } },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Result submitted." }],
      details: { data: { id: "F-1", severity: "low" }, status: "success", type: ["findings"] },
    },
  },
  // Real shape: details { status: "success", type: "result", useLastTurn: true } with no data (yield.ts:501, 664).
  {
    id: "last-turn",
    title: "The last assistant response is the result",
    args: { type: "result" },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Result submitted." }],
      details: { status: "success", type: "result", useLastTurn: true },
    },
  },
  // Real shape: content "Task aborted: <reason>", details { status: "aborted", error } (yield.ts:501, :648-649, :657-667).
  // omp's own card shows it as an error with that reason (packages/tui/src/tools/yield.ts:77-79).
  {
    id: "aborted",
    title: "A submission the worker could not deliver",
    args: { error: "The shard is missing a row." },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Task aborted: The shard is missing a row." }],
      details: { status: "aborted", error: "The shard is missing a row.", type: "rows" },
    },
  },
  // Real shape: thrown by the tool (isError), details {} (yield.ts:611-623).
  {
    id: "schema-error",
    title: "A section that does not match the schema",
    args: { type: ["findings"], data: ["not", "an", "object"] },
    status: "complete",
    isError: true,
    result: {
      content: [
        {
          type: "text",
          text: 'Section "findings" does not match schema: expected object, received array. Call yield again with the corrected shape — 2 retry attempt(s) remain before the schema constraint is dropped.',
        },
      ],
      details: {},
    },
  },
  // Source only (yield.ts:626-628, 654-655, 665): the retry budget ran out, and the data was accepted.
  {
    id: "validation-override",
    title: "Accepted after the schema check was overridden",
    args: { data: { answer: "ready" } },
    status: "complete",
    result: {
      content: [
        {
          type: "text",
          text: "Result submitted (schema validation overridden after 3 failed attempt(s)).",
        },
      ],
      details: { data: { answer: "ready" }, status: "success", schemaOverridden: true },
    },
  },
  // Workpool item, not the last one (yield.ts:225-245 takes `key`; :466 records type [item id]; :648-652 the text).
  {
    id: "workpool-item",
    title: "A workpool item, with items still to come",
    args: { key: 2, data: { answer: "second" } },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Item 2 submitted. Remaining item(s): 3." }],
      details: { data: { answer: "second" }, status: "success", type: ["item-2"] },
    },
  },
  // The last workpool item: `complete` is set (yield.ts:663, :665).
  {
    id: "workpool-complete",
    title: "The last workpool item was submitted",
    args: { key: 3, data: { answer: "third" } },
    status: "complete",
    result: {
      content: [
        {
          type: "text",
          text: "Item 3 submitted. All workpool items are complete; ending this turn.",
        },
      ],
      details: { data: { answer: "third" }, status: "success", type: ["item-3"], complete: true },
    },
  },
  // A workpool item that could not be done: status aborted with its error (yield.ts:501, :648-649).
  {
    id: "workpool-item-error",
    title: "A workpool item the worker could not do",
    args: { key: 1, error: "The shard is missing a row." },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Task aborted: The shard is missing a row." }],
      details: { status: "aborted", error: "The shard is missing a row.", type: ["item-1"] },
    },
  },
  // Real shape: a steering message skipped the call before it ran; omp's result is an error (isError), details
  // { __synthetic, source "interrupt_skipped", executed false } (agent-loop.ts:4026).
  {
    id: "steering-skip",
    title: "A steering message skipped the submission",
    args: { type: ["summary"], data: "Partial summary" },
    status: "complete",
    isError: true,
    result: {
      content: [{ type: "text", text: STEERING_SKIP_TEXT }],
      details: { __synthetic: true, source: "interrupt_skipped", executed: false },
    },
  },
  // Source only (agent-loop.ts:4025): a steering message interrupted the call after it had started.
  {
    id: "interrupted-skip",
    title: "A steering message interrupted the submission after it started",
    args: { data: "Partial summary" },
    status: "complete",
    result: {
      content: [{ type: "text", text: STEERING_SKIP_TEXT }],
      details: { __interrupted: true, source: "interrupt_skipped", execution: "started" },
    },
  },
  // Source only (agent-loop.ts:3927 and :3896-3907): the person stopped the run.
  {
    id: "stop-aborted",
    title: "The person stopped the run",
    args: { data: "Partial summary" },
    status: "complete",
    isError: true,
    result: {
      content: [{ type: "text", text: "Tool execution was aborted." }],
      details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
    },
  },
  // Source only (agent-loop.ts:3931-3932, 3903-3904): the provider stream failed before the call ran.
  {
    id: "stop-error",
    title: "The provider stream failed before the submission ran",
    args: { data: "Partial summary" },
    status: "complete",
    isError: true,
    result: {
      content: [
        {
          type: "text",
          text: "Tool call was not executed because the provider stream ended with an error before the tool could run: The socket connection was closed unexpectedly.",
        },
      ],
      details: {
        __synthetic: true,
        source: "assistant_stop_error",
        executed: false,
        upstreamError: "The socket connection was closed unexpectedly.",
      },
    },
  },
  // Real shape: the arguments were not valid JSON; the details carry the same reason (isError, error).
  {
    id: "parse-error",
    title: "The arguments were not valid JSON",
    args: { data: "unterminated" },
    status: "complete",
    isError: true,
    result: {
      content: [
        {
          type: "text",
          text: 'Validation failed for tool "yield": Tool call arguments are not valid JSON.\nParse Error: Unexpected trailing characters at position 1848',
        },
      ],
      details: {
        isError: true,
        error:
          'Validation failed for tool "yield": Tool call arguments are not valid JSON.\nParse Error: Unexpected trailing characters at position 1848',
      },
    },
  },
  // Long output: the card shows the first lines and says how much was cut.
  {
    id: "large-text",
    title: "A long text result",
    args: { data: "line 1" },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Result submitted." }],
      details: {
        data: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
        status: "success",
      },
    },
  },
  {
    id: "running",
    title: "A submission still arriving",
    args: { data: { partial: true } },
    status: "running",
  },
  // A status the schema does not know: the details are malformed, and the raw result is kept.
  {
    id: "malformed",
    title: "Details with an unknown status",
    args: { data: { answer: 42 } },
    status: "complete",
    result: {
      content: [{ type: "text", text: "Result submitted." }],
      details: { status: "unknown", data: { answer: 42 } },
    },
  },
];

/** The renderer props a fixture stands for, as assistant-ui passes them to a tool renderer. */
export function yieldRendererProps(fixture: YieldFixture): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `yield-${fixture.id}`,
    toolName: "yield",
    args: fixture.args,
    argsText: JSON.stringify(fixture.args),
    status: fixture.status === "running" ? { type: "running" } : { type: "complete" },
    isError: fixture.isError === true,
    result: fixture.result,
  } as unknown as ToolRendererProps;
}

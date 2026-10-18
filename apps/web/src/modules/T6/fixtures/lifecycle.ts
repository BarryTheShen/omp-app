import type { NormalizeToolCallInput, ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T6_TOOL_DESCRIPTORS, type T6ToolDescriptor } from "../descriptor";
import { T6_REAL_RESULTS } from "./real-results";
import { T6_SOURCE_RESULTS } from "./source-results";

export type T6FixtureBasis = "recorded" | "omp-source" | "scripted";
export interface T6LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T6ToolDescriptor["id"];
  readonly basis: T6FixtureBasis;
  readonly size: "normal" | "large";
  readonly shows: readonly string[];
}
interface Sample {
  readonly sample: RealToolResult;
  readonly basis: Exclude<T6FixtureBasis, "scripted">;
}
const SAMPLES: readonly Sample[] = [
  ...T6_REAL_RESULTS.map((sample) => ({ sample, basis: "recorded" as const })),
  ...T6_SOURCE_RESULTS.map((sample) => ({ sample, basis: "omp-source" as const })),
];

function descriptorFor(toolName: string): T6ToolDescriptor {
  const descriptor = T6_TOOL_DESCRIPTORS.find(
    (item) => item.match.by === "name" && item.match.name === toolName,
  );
  if (descriptor === undefined) throw new Error(`No T6 descriptor matches ${toolName}`);
  return descriptor;
}

function largeFor(sample: RealToolResult): boolean {
  const text = sample.result.content
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  return JSON.stringify(sample.args).length + text.length > 4_000;
}

function scriptedError(
  descriptor: T6ToolDescriptor,
  call: NormalizeToolCallInput,
  index: number,
  sampleName: string,
): T6LifecycleFixture {
  const text = `Scripted ${descriptor.title.toLowerCase()} failure.`;
  return {
    name: `error: scripted ${descriptor.id} for ${sampleName}`,
    descriptor: descriptor.id,
    basis: "scripted",
    size: "normal",
    shows: [text],
    input: {
      ...call,
      toolCallId: `${call.toolCallId}-scripted-error-${index}`,
      isError: true,
      result: { content: [{ type: "text", text }], details: {} },
      status: { type: "complete" },
    },
    expect: {
      phase: "error",
      isError: true,
      result: { content: [{ type: "text", text }], details: {} },
    },
  };
}

/** A scripted success fixture pairs a recorded error with the same renderer's success branch. */
function scriptedSuccess(
  descriptor: T6ToolDescriptor,
  call: NormalizeToolCallInput,
  index: number,
  sampleName: string,
): T6LifecycleFixture {
  const text = "Scripted successful result.";
  return {
    name: `success: scripted ${descriptor.id} for ${sampleName}`,
    descriptor: descriptor.id,
    basis: "scripted",
    size: "normal",
    shows: [],
    input: {
      ...call,
      toolCallId: `${call.toolCallId}-scripted-success-${index}`,
      isError: false,
      result: { content: [{ type: "text", text }], details: {} },
      status: { type: "complete" },
    },
    expect: {
      phase: "success",
      isError: false,
      result: { content: [{ type: "text", text }], details: {} },
    },
  };
}

function lifecycleOf(sample: Sample, index: number): T6LifecycleFixture[] {
  const descriptor = descriptorFor(sample.sample.toolName);
  const size = largeFor(sample.sample) ? "large" : "normal";
  const call = {
    toolCallId: `t6-${index}-${descriptor.id.replaceAll(".", "-")}`,
    toolName: sample.sample.toolName,
    args: sample.sample.args,
    argsText: JSON.stringify(sample.sample.args),
  };
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
    shows: readonly string[] = [],
  ): T6LifecycleFixture => ({
    name: `${state}: ${sample.sample.name}`,
    descriptor: descriptor.id,
    basis: sample.basis,
    size,
    shows,
    input,
    expect: expected,
  });
  const settled = fixture(
    sample.sample.isError ? "error" : "success",
    {
      ...call,
      result: sample.sample.result,
      isError: sample.sample.isError,
      status: { type: "complete" },
    },
    {
      phase: sample.sample.isError ? "error" : "success",
      isError: sample.sample.isError,
      result: sample.sample.result,
    },
    sample.sample.shows,
  );
  const lifecycle = [
    fixture("running", { ...call, status: { type: "running" } }, { phase: "running" }),
    fixture(
      "partial",
      {
        ...call,
        result: sample.sample.result,
        status: { type: "requires-action", reason: "interrupt" },
      },
      { phase: "partial", partialResult: sample.sample.result },
    ),
    fixture(
      "cancelled",
      {
        ...call,
        result: sample.sample.result,
        status: { type: "incomplete", reason: "cancelled" },
      },
      { phase: "cancelled", cancelled: true, result: sample.sample.result },
    ),
    settled,
  ];
  if (sample.sample.isError) {
    return [...lifecycle, scriptedSuccess(descriptor, call, index, sample.sample.name)];
  }
  return [...lifecycle, scriptedError(descriptor, call, index, sample.sample.name)];
}

export const T6_LIFECYCLE_FIXTURES: readonly T6LifecycleFixture[] = SAMPLES.flatMap(lifecycleOf);
/**
 * These are scripted renderer inputs with no persisted result, not omp result envelopes. The empty retain
 * item list is only a defensive UI state; omp rejects it before execution.
 */
const EMPTY_STATE_CALLS: readonly {
  readonly descriptor: T6ToolDescriptor["id"];
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}[] = [
  { descriptor: "T6.recall", toolName: "recall", args: { query: "" } },
  { descriptor: "T6.reflect", toolName: "reflect", args: { query: "" } },
  { descriptor: "T6.retain", toolName: "retain", args: { items: [] } },
  { descriptor: "T6.learn", toolName: "learn", args: { memory: "" } },
  { descriptor: "T6.manage-skill", toolName: "manage_skill", args: { action: "delete", name: "" } },
  {
    descriptor: "T6.memory-edit",
    toolName: "memory_edit",
    args: { op: "update", id: "memory-empty", content: "" },
  },
];

export const T6_EMPTY_STATE_FIXTURES: readonly T6LifecycleFixture[] = EMPTY_STATE_CALLS.map(
  ({ descriptor, toolName, args }) => ({
    name: `empty: scripted resultless renderer input for ${descriptor}`,
    descriptor,
    basis: "scripted",
    size: "normal",
    shows: [],
    input: {
      toolCallId: `t6-empty-${descriptor.replaceAll(".", "-")}`,
      toolName,
      args,
      argsText: JSON.stringify(args),
      status: { type: "complete" },
    },
    expect: { phase: "unrecorded" },
  }),
);

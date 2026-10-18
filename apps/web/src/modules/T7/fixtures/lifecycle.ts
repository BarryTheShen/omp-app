import type { NormalizeToolCallInput, ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T7_TOOL_DESCRIPTORS, type T7ToolDescriptor } from "../descriptor";
import { T7_REAL_RESULTS } from "./real-results";
import { T7_SOURCE_RESULTS } from "./source-results";

export type T7FixtureBasis = "recorded" | "scripted";

export interface T7LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T7ToolDescriptor["id"];
  readonly basis: T7FixtureBasis;
  readonly size: "normal" | "large";
  readonly shows: readonly string[];
}

interface Sample {
  readonly sample: RealToolResult;
  readonly basis: T7FixtureBasis;
}

const RECORDED_SAMPLES: readonly Sample[] = T7_REAL_RESULTS.map((sample) => ({
  sample,
  basis: "recorded",
}));
const SCRIPTED_SAMPLES: readonly Sample[] = T7_SOURCE_RESULTS.map((sample) => ({
  sample,
  basis: "scripted",
}));

function descriptorFor(toolName: string): T7ToolDescriptor {
  const exact = T7_TOOL_DESCRIPTORS.find(
    (item) => item.match.by === "name" && item.match.name === toolName,
  );
  if (exact !== undefined) return exact;
  const prefix = T7_TOOL_DESCRIPTORS.find(
    (item) => item.match.by === "prefix" && toolName.startsWith(item.match.prefix),
  );
  if (prefix !== undefined) return prefix;
  const fallback = T7_TOOL_DESCRIPTORS.find((item) => item.match.by === "fallback");
  if (fallback === undefined) throw new Error(`No T7 fallback descriptor for ${toolName}`);
  return fallback;
}

function textOf(result: RealToolResult["result"]): string {
  return result.content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function isLargeResult(sample: Sample): boolean {
  const text = textOf(sample.sample.result);
  return text.split("\n").length >= 24 || text.length > 240;
}

function largeScriptedSample(sample: Sample): Sample {
  if (isLargeResult(sample)) return sample;
  const text = Array.from(
    { length: 24 },
    (_, index) => `${sample.sample.name} result line ${index + 1}`,
  ).join("\n");
  return {
    basis: "scripted",
    sample: {
      ...sample.sample,
      name: `[scripted large] ${sample.sample.name}`,
      result: { ...sample.sample.result, content: [{ type: "text", text }] },
      shows: [],
    },
  };
}

const SAMPLES: readonly Sample[] = [
  ...RECORDED_SAMPLES,
  ...SCRIPTED_SAMPLES,
  ...RECORDED_SAMPLES.map(largeScriptedSample),
  ...SCRIPTED_SAMPLES.map(largeScriptedSample),
];

function scriptedStateResult(
  sample: Sample,
  state: "partial" | "cancelled",
): RealToolResult["result"] {
  const firstLine = textOf(sample.sample.result).split("\n")[0] ?? "";
  return {
    ...sample.sample.result,
    content: [
      {
        type: "text",
        text: `${state === "partial" ? "Partial result" : "Cancelled result"}: ${firstLine}`,
      },
    ],
  };
}

function oppositeSettled(
  sample: Sample,
  descriptor: T7ToolDescriptor,
  call: NormalizeToolCallInput,
): T7LifecycleFixture {
  const success = !sample.sample.isError;
  return {
    name: `${success ? "error" : "success"}: [scripted opposite] ${sample.sample.name}`,
    descriptor: descriptor.id,
    basis: "scripted",
    size: isLargeResult(sample) ? "large" : "normal",
    shows: [],
    input: {
      ...call,
      toolCallId: `${call.toolCallId}-opposite`,
      isError: success,
      result: sample.sample.result,
      status: { type: "complete" },
    },
    expect: {
      phase: success ? "error" : "success",
      isError: success,
      result: sample.sample.result,
    },
  };
}

function lifecycleOf(sample: Sample, index: number): T7LifecycleFixture[] {
  const descriptor = descriptorFor(sample.sample.toolName);
  const call = {
    toolCallId: `t7-${index}-${descriptor.id.replaceAll(".", "-")}`,
    toolName: sample.sample.toolName,
    args: sample.sample.args,
    argsText: JSON.stringify(sample.sample.args),
  };
  const size = isLargeResult(sample) ? "large" : "normal";
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
    shows: readonly string[] = [],
    basis: T7FixtureBasis = sample.basis,
  ): T7LifecycleFixture => ({
    name: `${state}: ${sample.sample.name}`,
    descriptor: descriptor.id,
    basis,
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
  const partialResult = scriptedStateResult(sample, "partial");
  const cancelledResult = scriptedStateResult(sample, "cancelled");
  return [
    fixture(
      "running",
      { ...call, status: { type: "running" } },
      { phase: "running" },
      [],
      "scripted",
    ),
    fixture(
      "partial",
      { ...call, result: partialResult, status: { type: "requires-action", reason: "interrupt" } },
      { phase: "partial", partialResult },
      [],
      "scripted",
    ),
    fixture(
      "cancelled",
      { ...call, result: cancelledResult, status: { type: "incomplete", reason: "cancelled" } },
      { phase: "cancelled", cancelled: true, result: cancelledResult },
      [],
      "scripted",
    ),
    settled,
    oppositeSettled(sample, descriptor, call),
  ];
}

export const T7_LIFECYCLE_FIXTURES: readonly T7LifecycleFixture[] = SAMPLES.flatMap(lifecycleOf);

import type { NormalizeToolCallInput, ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T5_TOOL_DESCRIPTORS, type T5ToolDescriptor } from "../descriptor";
import { YIELD_FIXTURES } from "../yield-fixtures";
import { T5_REAL_RESULTS } from "./real-results";
import { T5_VIBE_REAL_RESULTS } from "./vibe-real-results";
import { T5_VIBE_SOURCE_RESULTS } from "./vibe-source-results";
import { T5_VIBE_SPAWN_SOURCE_RESULTS } from "./vibe-spawn-source-results";
export type T5FixtureBasis = "recorded" | "omp-source" | "scripted";

export interface T5LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T5ToolDescriptor["id"];
  readonly basis: T5FixtureBasis;
  readonly size: "normal" | "large";
  readonly shows: readonly string[];
}

interface Sample {
  readonly sample: RealToolResult;
  readonly basis: T5FixtureBasis;
}

function envelopeOf(value: unknown): RealToolResult["result"] {
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    return "details" in value
      ? { content: value.content, details: value.details }
      : { content: value.content };
  }
  return { content: [] };
}

function textOf(result: unknown): string {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    return "";
  return result.content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

function resultSample(
  name: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
  isError: boolean,
  basis: T5FixtureBasis,
  shows: readonly string[] = [],
): Sample {
  return {
    basis,
    sample: { name, toolName, args, result: envelopeOf(result), isError, shows },
  };
}

function yieldIsError(result: unknown, fixtureError: boolean): boolean {
  if (fixtureError || textOf(result).startsWith("Task aborted:")) return true;
  if (result && typeof result === "object" && "details" in result) {
    const details = result.details;
    if (details !== null && typeof details === "object" && "status" in details) {
      return details.status !== "success" && details.status !== "aborted";
    }
  }
  return false;
}

const yieldSamples: readonly Sample[] = YIELD_FIXTURES.filter(
  (fixture) =>
    fixture.result !== undefined &&
    !/steering message skipped|steering message interrupted|person stopped/i.test(fixture.title),
).map((fixture) =>
  resultSample(
    `yield: ${fixture.title}`,
    "yield",
    fixture.args,
    fixture.result,
    yieldIsError(fixture.result, fixture.isError === true),
    "recorded",
    textOf(fixture.result).split("\n").filter(Boolean).slice(0, 2),
  ),
);

const scriptedEmptySamples: readonly Sample[] = [
  resultSample(
    "empty: task has no agents reported (scripted shape)",
    "task",
    { tasks: [] },
    { content: [{ type: "text", text: "" }], details: { progress: [], results: [] } },
    false,
    "scripted",
    ["No agents reported"],
  ),
  resultSample(
    "empty: hub has no log lines yet (scripted shape)",
    "hub",
    { op: "logs" },
    { content: [{ type: "text", text: "" }], details: { op: "logs", terminalRows: [] } },
    false,
    "scripted",
    ["No log lines yet."],
  ),
  resultSample(
    "empty: hub has no details reported (scripted shape)",
    "hub",
    { op: "unknown" },
    { content: [{ type: "text", text: "" }], details: {} },
    false,
    "scripted",
    ["No details reported"],
  ),
  resultSample(
    "empty: yield has no submitted output (scripted shape)",
    "yield",
    { type: "result" },
    {
      content: [{ type: "text", text: "Result submitted." }],
      details: { status: "success" },
    },
    false,
    "scripted",
    ["No submitted output"],
  ),
  resultSample(
    "empty: yield has an empty text result (scripted shape)",
    "yield",
    { data: "" },
    { content: [{ type: "text", text: "" }], details: { status: "success", data: "" } },
    false,
    "scripted",
    ["An empty text result was submitted."],
  ),
];

const scriptedRoster = resultSample(
  "hub: 25-agent roster (scripted large shape)",
  "hub",
  { op: "list" },
  {
    content: [{ type: "text", text: "25 agents listed." }],
    details: {
      op: "list",
      peers: Array.from({ length: 25 }, (_, index) => ({
        id: `peer-${index + 1}`,
        displayName: `worker-${index + 1}`,
        kind: "sub",
        status: "idle",
      })),
      counts: { idle: 25 },
    },
  },
  false,
  "scripted",
  ["Showing 20 of 25", "+5 more"],
);

const largeText = Array.from({ length: 24 }, (_, index) => `Result line ${index + 1}`).join("\n");
const scriptedLargeInputs: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ["hub", { op: "logs" }],
  ["task", { tasks: [] }],
  ["vibe_kill", { session: "fast-1" }],
  ["vibe_list", {}],
  ["vibe_send", { session: "fast-1", message: "Large output" }],
  ["vibe_spawn", { cli: "fast", prompt: "Large output" }],
  ["vibe_wait", { sessions: ["fast-1"] }],
  ["yield", { data: "Large output" }],
  ["wait", { i: "Large output" }],
];
const scriptedLargeSamples: readonly Sample[] = scriptedLargeInputs.map(([toolName, args]) =>
  resultSample(
    `large: ${toolName} has 24 output lines (scripted shape)`,
    toolName,
    args,
    { content: [{ type: "text", text: largeText }], details: {} },
    false,
    "scripted",
    ["Result line 1"],
  ),
);

const scriptedErrorSamples: readonly Sample[] = T5_TOOL_DESCRIPTORS.map((descriptor) => {
  const match = descriptor.match;
  const toolName = match.by === "name" ? match.name : "unknown";
  const args: Readonly<Record<string, unknown>> =
    toolName === "vibe_spawn"
      ? { cli: "fast", prompt: "Retry" }
      : toolName === "vibe_send"
        ? { session: "fast-1", message: "Retry" }
        : toolName === "vibe_wait"
          ? { sessions: ["fast-1"] }
          : toolName === "vibe_kill"
            ? { session: "fast-1" }
            : {};
  return resultSample(
    `error: ${descriptor.id} reports a typed failure (scripted)`,
    toolName,
    args,
    { content: [{ type: "text", text: "The tool reported an error." }], details: {} },
    true,
    "scripted",
    ["The tool reported an error."],
  );
});

const SAMPLES: readonly Sample[] = [
  ...T5_REAL_RESULTS.map((sample) => ({ sample, basis: "recorded" as const })),
  ...T5_VIBE_REAL_RESULTS.map((sample) => ({ sample, basis: "recorded" as const })),
  ...T5_VIBE_SOURCE_RESULTS.map((sample) => ({ sample, basis: "omp-source" as const })),
  ...T5_VIBE_SPAWN_SOURCE_RESULTS.map((sample) => ({ sample, basis: "omp-source" as const })),
  ...yieldSamples,
  ...scriptedEmptySamples,
  scriptedRoster,
  ...scriptedLargeSamples,
  ...scriptedErrorSamples,
];

function descriptorFor(toolName: string): T5ToolDescriptor {
  const descriptor = T5_TOOL_DESCRIPTORS.find(
    (item) => item.match.by === "name" && item.match.name === toolName,
  );
  if (descriptor === undefined) throw new Error(`No T5 descriptor matches ${toolName}`);
  return descriptor;
}

function isLargeResult(result: RealToolResult["result"]): boolean {
  const text = textOf(result);
  const details =
    result && typeof result === "object" && "details" in result ? result.details : undefined;
  const rows =
    details && typeof details === "object"
      ? Object.values(details).find((value) => Array.isArray(value) && value.length > 20)
      : undefined;
  return (
    text.split("\n").length > 16 || JSON.stringify(result).length > 1_000 || Array.isArray(rows)
  );
}

function lifecycleOf(sample: Sample, index: number): T5LifecycleFixture[] {
  const descriptor = descriptorFor(sample.sample.toolName);
  const size = isLargeResult(sample.sample.result) ? "large" : "normal";
  const call = {
    toolCallId: `t5-${index}-${descriptor.id.replaceAll(".", "-")}`,
    toolName: sample.sample.toolName,
    args: sample.sample.args,
    argsText: JSON.stringify(sample.sample.args),
  };
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
    shows: readonly string[] = sample.sample.shows,
  ): T5LifecycleFixture => ({
    name: `${state}: ${sample.sample.name}`,
    descriptor: descriptor.id,
    basis: sample.basis,
    size,
    shows,
    input,
    expect: expected,
  });
  const partialResult = sample.sample.isError ? undefined : sample.sample.result;
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
  );
  const phaseResult =
    sample.sample.isError && sample.sample.toolName === "yield" ? undefined : partialResult;
  const partialExpected: Partial<ToolCardState> = sample.sample.isError
    ? { phase: "error", isError: true }
    : partialResult === undefined
      ? { phase: "partial" }
      : { phase: "partial", partialResult };
  const cancelledExpected: Partial<ToolCardState> = sample.sample.isError
    ? { phase: "error", isError: true }
    : partialResult === undefined
      ? { phase: "cancelled", cancelled: true }
      : { phase: "cancelled", cancelled: true, result: partialResult };
  return [
    fixture("running", { ...call, status: { type: "running" } }, { phase: "running" }),
    fixture(
      "partial",
      {
        ...call,
        result: phaseResult,
        isError: sample.sample.isError,
        status: sample.sample.isError
          ? { type: "complete" }
          : { type: "requires-action", reason: "interrupt" },
      },
      partialExpected,
      sample.sample.isError ? [] : sample.sample.shows,
    ),
    fixture(
      "cancelled",
      {
        ...call,
        result: phaseResult,
        isError: sample.sample.isError,
        status: sample.sample.isError
          ? { type: "complete" }
          : { type: "incomplete", reason: "cancelled" },
      },
      cancelledExpected,
      sample.sample.isError ? [] : sample.sample.shows,
    ),
    settled,
  ];
}

export const T5_LIFECYCLE_FIXTURES: readonly T5LifecycleFixture[] = SAMPLES.flatMap(lifecycleOf);

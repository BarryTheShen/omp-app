import type { NormalizeToolCallInput, ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T3_TOOL_DESCRIPTORS, type T3ToolDescriptor } from "../descriptor";
import { T3_REAL_RESULTS } from "./real-results";
import { T3_SCRIPTED_LARGE_RESULTS } from "./scripted";

/** Every fixture is either a captured result or explicitly scripted from an omp v18.9.1 builder. */
export type T3FixtureBasis = "recorded" | "scripted";

export interface T3LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T3ToolDescriptor["id"];
  readonly basis: T3FixtureBasis;
  readonly size: "normal" | "large";
  readonly shows: readonly string[];
}

function descriptorFor(toolName: string): T3ToolDescriptor {
  const descriptor = T3_TOOL_DESCRIPTORS.find(
    (candidate) => candidate.match.by === "name" && candidate.match.name === toolName,
  );
  if (!descriptor) throw new Error(`No T3 descriptor matches ${toolName}`);
  return descriptor;
}

function isLargeResult(sample: RealToolResult, basis: T3FixtureBasis): boolean {
  if (basis !== "scripted" || sample.toolName !== "eval") return false;
  const details =
    sample.result && typeof sample.result === "object"
      ? Reflect.get(sample.result, "details")
      : undefined;
  const outputs =
    details && typeof details === "object" ? Reflect.get(details, "jsonOutputs") : undefined;
  return (
    Array.isArray(outputs) &&
    outputs.some((output) => output && Reflect.get(output, "truncated") === true)
  );
}

function lifecycleOf(
  sample: RealToolResult,
  index: number,
  basis: T3FixtureBasis = "recorded",
): T3LifecycleFixture[] {
  const descriptor = descriptorFor(sample.toolName).id;
  const size = isLargeResult(sample, basis) ? "large" : "normal";
  const call = {
    toolCallId: `t3-${index}-${sample.toolName}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
  };
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
    fixtureBasis: T3FixtureBasis = basis,
  ): T3LifecycleFixture => ({
    name: `${state}: ${sample.name}`,
    descriptor,
    basis: fixtureBasis,
    size,
    shows: state === "success" || state === "error" ? sample.shows : [],
    input,
    expect: expected,
  });
  const partialInput = sample.isError
    ? { ...call, status: { type: "requires-action" as const, reason: "interrupt" as const } }
    : {
        ...call,
        result: sample.result,
        status: { type: "requires-action" as const, reason: "interrupt" as const },
      };
  const partialExpect = sample.isError
    ? { phase: "partial" as const }
    : { phase: "partial" as const, partialResult: sample.result };
  return [
    fixture("running", { ...call, status: { type: "running" } }, { phase: "running" }),
    fixture("partial", partialInput, partialExpect, "scripted"),
    fixture(
      "cancelled",
      { ...call, result: sample.result, status: { type: "incomplete", reason: "cancelled" } },
      { phase: "cancelled", cancelled: true, result: sample.result },
      "scripted",
    ),
    sample.isError
      ? fixture(
          "error",
          { ...call, result: sample.result, isError: true, status: { type: "complete" } },
          { phase: "error", isError: true, result: sample.result },
        )
      : fixture(
          "success",
          { ...call, result: sample.result, isError: false, status: { type: "complete" } },
          { phase: "success", isError: false, result: sample.result },
        ),
  ];
}

const DEBUG_SESSIONS = Array.from({ length: 10 }, (_, index) => ({
  id: `debug-session-${index + 1}`,
  adapter: "node",
  status: "stopped",
  cwd: "<WORKSPACE>",
  program: "app.js",
  launchedAt: "2026-10-18T00:00:00.000Z",
  lastUsedAt: "2026-10-18T00:05:00.000Z",
  breakpointFiles: 0,
  breakpointCount: 0,
  functionBreakpointCount: 0,
  outputBytes: 0,
  outputTruncated: false,
  needsConfigurationDone: false,
}));
const DEBUG_SESSIONS_TEXT = DEBUG_SESSIONS.map((session) =>
  [
    `${session.id}: ${session.status}`,
    `  adapter=${session.adapter}`,
    `  cwd=${session.cwd}`,
    `  program=${session.program}`,
  ].join("\n"),
).join("\n\n");
const DEBUG_SESSIONS_RESULT = {
  content: [{ type: "text", text: DEBUG_SESSIONS_TEXT }],
  details: { action: "sessions", success: true, sessions: DEBUG_SESSIONS },
};
const DEBUG_EMPTY_RESULT = {
  content: [{ type: "text", text: "No debug sessions." }],
  details: { action: "sessions", success: true, sessions: [] },
};
const DEBUG_ERROR_RESULT = {
  content: [{ type: "text", text: "Debug details unavailable." }],
  details: {
    action: "sessions",
    success: false,
    sessions: [],
    error: "Debug details unavailable.",
  },
};
const EMPTY_EVAL_RESULT: RealToolResult = {
  name: "eval: scripted no cells executed",
  toolName: "eval",
  args: { language: "js", code: "" },
  result: {
    content: [{ type: "text", text: "No cells were executed." }],
    details: { language: "js", languages: ["js"], cells: [] },
  },
  isError: false,
  shows: [],
};

function debugLifecycle(index: number): T3LifecycleFixture[] {
  const descriptor = descriptorFor("debug").id;
  const args = { action: "sessions" };
  const call = {
    toolCallId: `t3-scripted-${index}-debug`,
    toolName: "debug",
    args,
    argsText: JSON.stringify(args),
  };
  const fixture = (
    name: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
    shows: readonly string[] = [],
  ): T3LifecycleFixture => ({
    name,
    descriptor,
    basis: "scripted",
    size: "normal",
    shows,
    input,
    expect: expected,
  });
  return [
    fixture(
      "running: scripted debug sessions result",
      { ...call, status: { type: "running" } },
      { phase: "running" },
    ),
    fixture(
      "partial: scripted debug sessions request",
      { ...call, status: { type: "requires-action", reason: "interrupt" } },
      { phase: "partial" },
    ),
    fixture(
      "cancelled: scripted debug sessions request",
      { ...call, status: { type: "incomplete", reason: "cancelled" } },
      { phase: "cancelled", cancelled: true },
    ),
    fixture(
      "success: scripted v18.9.1 debug sessions result",
      { ...call, result: DEBUG_SESSIONS_RESULT, status: { type: "complete" } },
      { phase: "success", isError: false, result: DEBUG_SESSIONS_RESULT },
    ),
    fixture(
      "success: scripted v18.9.1 no debug sessions result",
      { ...call, result: DEBUG_EMPTY_RESULT, status: { type: "complete" } },
      { phase: "success", isError: false, result: DEBUG_EMPTY_RESULT },
    ),
    fixture(
      "error: scripted debug details unavailable result",
      { ...call, result: DEBUG_ERROR_RESULT, isError: true, status: { type: "complete" } },
      { phase: "error", isError: true, result: DEBUG_ERROR_RESULT },
    ),
  ];
}

export const T3_LIFECYCLE_FIXTURES: readonly T3LifecycleFixture[] = [
  ...T3_REAL_RESULTS.flatMap((sample, index) => lifecycleOf(sample, index)),
  ...T3_SCRIPTED_LARGE_RESULTS.flatMap((sample, index) =>
    lifecycleOf(sample, index + T3_REAL_RESULTS.length, "scripted"),
  ),
  ...lifecycleOf(
    EMPTY_EVAL_RESULT,
    T3_REAL_RESULTS.length + T3_SCRIPTED_LARGE_RESULTS.length + 1,
    "scripted",
  ),
  ...debugLifecycle(T3_REAL_RESULTS.length + T3_SCRIPTED_LARGE_RESULTS.length + 2),
];

import type { NormalizeToolCallInput, ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T2_TOOL_DESCRIPTORS, type T2ToolDescriptor } from "../descriptor";
import { T2_GLOB_LIMIT_RESULTS } from "./glob-limit";
import { T2_REAL_RESULTS } from "./real-results";
import recordedGrep69Text from "./recorded-grep-69.json?raw";
import { T2_SCRIPTED_LARGE_FIND_RESULTS } from "./scripted";
export type T2FixtureBasis = "recorded" | "lifecycle";

export interface T2LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T2ToolDescriptor["id"];
  readonly basis: T2FixtureBasis;
  readonly size: "normal" | "large";
  readonly shows: readonly string[];
}

export interface T2LateDiagnosticFixture {
  readonly name: string;
  readonly identity: string;
  readonly snapshot: unknown;
  readonly shows: readonly string[];
}

const LARGE_RESULTS: Record<string, true> = {
  "find: twenty-one scored hits, showing the first twenty": true,
  "glob: the result limit was reached": true,
  "grep: a recorded search of omp docs, 69 matches in 17 files, long lines cut": true,
};

function descriptorFor(toolName: string): T2ToolDescriptor {
  const descriptor = T2_TOOL_DESCRIPTORS.find(
    (candidate) => candidate.match.by === "name" && candidate.match.name === toolName,
  );
  if (!descriptor) throw new Error(`No T2 descriptor matches ${toolName}`);
  return descriptor;
}

function lifecycleOf(
  sample: RealToolResult,
  index: number,
  basis: T2FixtureBasis = "recorded",
): T2LifecycleFixture[] {
  const descriptor = descriptorFor(sample.toolName).id;
  const size = LARGE_RESULTS[sample.name] === true ? "large" : "normal";
  const call = {
    toolCallId: `t2-${index}-${sample.toolName}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
  };
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
  ): T2LifecycleFixture => ({
    name: `${state}: ${sample.name}`,
    descriptor,
    basis,
    size,
    shows: state === "success" || state === "error" ? sample.shows : [],
    input,
    expect: expected,
  });
  return [
    fixture("running", { ...call, status: { type: "running" } }, { phase: "running" }),
    fixture(
      "partial",
      { ...call, result: sample.result, status: { type: "requires-action", reason: "interrupt" } },
      { phase: "partial", partialResult: sample.result },
    ),
    fixture(
      "cancelled",
      { ...call, result: sample.result, status: { type: "incomplete", reason: "cancelled" } },
      { phase: "cancelled", cancelled: true, result: sample.result },
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

function emptyLifecycle(toolName: string, index: number): T2LifecycleFixture[] {
  const recordedResult = T2_REAL_RESULTS.find(
    (sample) => sample.name === "glob: a path that does not exist",
  )?.result;
  if (recordedResult === undefined) throw new Error("Missing recorded empty-details result");
  const descriptor = descriptorFor(toolName).id;
  const args =
    toolName === "ast_grep"
      ? { pat: "console.log($$$ARGS)", path: "src" }
      : { action: "diagnostics", file: "src/app.ts" };
  const call = {
    toolCallId: `t2-lifecycle-${index}-${toolName}`,
    toolName,
    args,
    argsText: JSON.stringify(args),
  };
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expected: Partial<ToolCardState>,
  ): T2LifecycleFixture => ({
    name: `${state}: ${toolName} lifecycle with a recorded empty-details result`,
    descriptor,
    basis: "lifecycle",
    size: state === "success" ? "large" : "normal",
    shows: [],
    input,
    expect: expected,
  });
  return [
    fixture("running", { ...call, status: { type: "running" } }, { phase: "running" }),
    fixture(
      "partial",
      { ...call, result: recordedResult, status: { type: "requires-action", reason: "interrupt" } },
      { phase: "partial", partialResult: recordedResult },
    ),
    fixture(
      "cancelled",
      { ...call, result: recordedResult, status: { type: "incomplete", reason: "cancelled" } },
      { phase: "cancelled", cancelled: true, result: recordedResult },
    ),
    fixture(
      "success",
      { ...call, result: recordedResult, status: { type: "complete" } },
      { phase: "success", isError: false, result: recordedResult },
    ),
    fixture(
      "error",
      { ...call, result: recordedResult, isError: true, status: { type: "complete" } },
      { phase: "error", isError: true, result: recordedResult },
    ),
  ];
}

const T2_RECORDED_GREP_69 = {
  ...(JSON.parse(recordedGrep69Text) as RealToolResult),
  shows: ["69 matches", "Some matches were omitted"],
};

export const T2_LIFECYCLE_FIXTURES: readonly T2LifecycleFixture[] = [
  ...T2_GLOB_LIMIT_RESULTS.flatMap((sample, index) => lifecycleOf(sample, index)),
  ...T2_REAL_RESULTS.flatMap((sample, index) =>
    lifecycleOf(sample, index + T2_GLOB_LIMIT_RESULTS.length),
  ),
  ...lifecycleOf(T2_RECORDED_GREP_69, T2_GLOB_LIMIT_RESULTS.length + T2_REAL_RESULTS.length),
  ...T2_SCRIPTED_LARGE_FIND_RESULTS.flatMap((sample, index) =>
    lifecycleOf(sample, index + T2_GLOB_LIMIT_RESULTS.length + T2_REAL_RESULTS.length + 1),
  ),
  ...emptyLifecycle(
    "ast_grep",
    T2_GLOB_LIMIT_RESULTS.length +
      T2_REAL_RESULTS.length +
      T2_SCRIPTED_LARGE_FIND_RESULTS.length +
      1,
  ),
  ...emptyLifecycle(
    "lsp",
    T2_GLOB_LIMIT_RESULTS.length +
      T2_REAL_RESULTS.length +
      T2_SCRIPTED_LARGE_FIND_RESULTS.length +
      2,
  ),
];

export const T2_LATE_DIAGNOSTIC_FIXTURES: readonly T2LateDiagnosticFixture[] = [
  {
    name: "late diagnostics after an edit, grouped by file and severity",
    identity: "t2-late-1",
    snapshot: {
      customType: "lsp-late-diagnostic",
      details: {
        source: "lsp",
        files: [
          {
            path: "src/app.ts",
            summary: "1 error(s)",
            errored: true,
            messages: ["error TS2322: Type 'string' is not assignable to type 'number'."],
          },
          { path: "src/clean.ts", summary: "no issues", errored: false, messages: [] },
        ],
      },
    },
    shows: ["Reported after the edit or write finished.", "src/app.ts", "1 error(s)"],
  },
  {
    name: "late diagnostics with no changed-file findings",
    identity: "t2-late-2",
    snapshot: { customType: "lsp-late-diagnostic", details: { files: [] } },
    shows: ["No diagnostics were reported for the changed files."],
  },
];

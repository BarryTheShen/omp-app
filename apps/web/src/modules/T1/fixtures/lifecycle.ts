import type { NormalizeToolCallInput, ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T1_TOOL_DESCRIPTORS, type T1ToolDescriptor } from "../descriptor";
import { T1_REAL_RESULTS } from "./real-results";
import { T1_OMP_SOURCE_RESULTS } from "./source-results";
import { T1_URL_RESULTS } from "./url-results";
import { T1_WRITE_TARGET_RESULTS } from "./write-targets";

/** Where a fixture's result shape comes from: recorded, omp source, or a deliberately synthetic concurrency input. */
export type T1FixtureBasis = "recorded" | "omp-source" | "synthetic";

/** One call of a T1 descriptor, as the chat delivers it, and the normalized state it must produce. */
export interface T1LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T1ToolDescriptor["id"];
  readonly basis: T1FixtureBasis;
  /** A large result: long, cut at omp's limit, several files, or many rows (the large-result state). */
  readonly size: "normal" | "large";
  /** The facts a person needs from this result, once its card is open (the settled states show them). */
  readonly shows: readonly string[];
  /** T4 draws URL reads, so the gate renders this fixture through a stub renderer that it injects. */
  readonly renderer?: "url-stub";
}

/** Names of known large results; this marks fixture metadata, not the rendered card's visual size. */
const LARGE_RESULTS: Readonly<Record<string, true>> = {
  "read: a long file, cut at omp's limit": true,
  "edit: several files in one call": true,
  "write: a device call that returns many rows": true,
  "apply_patch: two files, both updated in one patch": true,
  "ast_edit: a large preview, with many replacements in five files": true,
};

interface Sample {
  readonly sample: RealToolResult;
  readonly basis: T1FixtureBasis;
  readonly renderer?: "url-stub";
}

const SAMPLES: readonly Sample[] = [
  ...T1_REAL_RESULTS.map((sample) => ({ sample, basis: "recorded" as const })),
  ...T1_WRITE_TARGET_RESULTS.map((sample) => ({ sample, basis: "recorded" as const })),
  ...T1_URL_RESULTS.map((sample) => ({
    sample,
    basis: "recorded" as const,
    renderer: "url-stub" as const,
  })),
  ...T1_OMP_SOURCE_RESULTS.map((sample) => ({
    sample,
    basis: "omp-source" as const,
  })),
];

/** The descriptor that matches an omp tool name. Each T1 tool name is claimed once (see the gate test). */
function descriptorFor(toolName: string): T1ToolDescriptor {
  const found = T1_TOOL_DESCRIPTORS.find(
    (descriptor) => descriptor.match.by === "name" && descriptor.match.name === toolName,
  );
  if (found === undefined) throw new Error(`No T1 descriptor matches the tool ${toolName}`);
  return found;
}

/**
 * The lifecycle of one result: the call while it runs, while it streams its partial output, when it is cancelled, and
 * when it settles (success, or error for a result omp marked as failed). Each carries the state the normalizer must give it.
 */
function lifecycleOf({ sample, basis, renderer }: Sample, index: number): T1LifecycleFixture[] {
  const descriptor = descriptorFor(sample.toolName).id;
  const size = LARGE_RESULTS[sample.name] === true ? "large" : "normal";
  const call = {
    toolCallId: `t1-${basis}-${index}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
  };
  const fixture = (
    state: string,
    input: NormalizeToolCallInput,
    expect: Partial<ToolCardState>,
  ): T1LifecycleFixture => ({
    name: `${state}: ${sample.name}`,
    descriptor,
    basis,
    size,
    shows: state === "success" || state === "error" ? sample.shows : [],
    input,
    expect,
    ...(renderer === undefined ? {} : { renderer }),
  });
  const settled = sample.isError
    ? fixture(
        "error",
        { ...call, result: sample.result, isError: true, status: { type: "complete" } },
        { phase: "error", isError: true, result: sample.result },
      )
    : fixture(
        "success",
        { ...call, result: sample.result, isError: false, status: { type: "complete" } },
        { phase: "success", isError: false, result: sample.result },
      );
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
    settled,
  ];
}

/** Two read calls that run at once, each with its own arguments: a normalizer that mixes them up fails the gate. */
function concurrentReads(): T1LifecycleFixture[] {
  const descriptor = descriptorFor("read").id;
  return [
    { which: "first", args: { path: "src/first.ts" } },
    { which: "second", args: { path: "src/second.ts" } },
  ].map(({ which, args }) => ({
    name: `concurrent: two read calls run at once, the ${which} keeps its own id and arguments`,
    descriptor,
    size: "normal",
    basis: "synthetic",
    shows: [],
    input: {
      toolCallId: `t1-concurrent-${which}`,
      toolName: "read",
      args,
      argsText: JSON.stringify(args),
      status: { type: "running" },
    },
    expect: { phase: "running" },
  }));
}

export const T1_LIFECYCLE_FIXTURES: readonly T1LifecycleFixture[] = [
  ...SAMPLES.flatMap((entry, index) => lifecycleOf(entry, index)),
  ...concurrentReads(),
];

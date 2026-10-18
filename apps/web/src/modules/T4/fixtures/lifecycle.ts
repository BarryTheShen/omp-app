import type { ToolCardState } from "../../U3/tool-card";
import type { ToolCardFixture } from "../../U3/tool-card/fixtures/lifecycle";
import type { RealToolResult } from "../../U3/tool-card/real-result";
import { T4_TOOL_DESCRIPTORS, type T4ToolDescriptor } from "../descriptor";
import { WEB_FETCH_DESCRIPTOR } from "../web-fetch";
import { T4_BROWSER_RESULTS } from "./browser-results";
import { T4_REAL_RESULTS } from "./real-results";
import { T4_SCRIPTED_RESULTS } from "./scripted";
import { T4_WEB_FETCH_REAL_RESULTS } from "./web-fetch-real-results";

/** Historical browser recordings remain identified as older-omp; other scripts match cited v18.9.1 builders. */
export type T4FixtureBasis = "recorded" | "recorded-older-omp" | "scripted";
export type T4DescriptorId = T4ToolDescriptor["id"] | "T4.webFetch";

export interface T4LifecycleFixture extends ToolCardFixture {
  readonly descriptor: T4DescriptorId;
  readonly basis: T4FixtureBasis;
  readonly size: "normal" | "large";
  readonly shows: readonly string[];
  readonly renderedPhase?: ToolCardState["phase"];
}

export interface T4UrlFixture {
  readonly name: string;
  readonly basis: T4FixtureBasis;
  readonly sample: RealToolResult;
  readonly shows: readonly string[];
}

const ALL_TOOL_DESCRIPTORS = [...T4_TOOL_DESCRIPTORS, WEB_FETCH_DESCRIPTOR] as const;
const LARGE_RESULTS: Record<string, true> = {
  "browser: scripted long console display folded by shared text output": true,
  "web_search: scripted 33-source result, showing the first 32": true,
  "github: scripted long text-file result through the contents API": true,
};

function descriptorFor(toolName: string): T4DescriptorId {
  const descriptor = ALL_TOOL_DESCRIPTORS.find(
    (candidate) => candidate.match.by === "name" && candidate.match.name === toolName,
  );
  if (!descriptor) throw new Error(`No T4 descriptor matches ${toolName}`);
  return descriptor.id as T4DescriptorId;
}

function hasProviderError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const details = Reflect.get(result, "details");
  return (
    typeof details === "object" &&
    details !== null &&
    typeof Reflect.get(details, "error") === "string"
  );
}

function lifecycleOf(
  sample: RealToolResult,
  index: number,
  basis: T4FixtureBasis,
): T4LifecycleFixture[] {
  const descriptor = descriptorFor(sample.toolName);
  const sourceName =
    basis === "recorded-older-omp" ? `older-omp recording: ${sample.name}` : sample.name;
  const size = LARGE_RESULTS[sample.name] === true ? "large" : "normal";
  const call = {
    toolCallId: `t4-${index}-${sample.toolName}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
  };
  const fixtures: T4LifecycleFixture[] = [
    {
      name: `running: ${sourceName}`,
      descriptor,
      basis,
      size,
      shows: sample.toolName === "web_search" ? ["Waiting for search results…"] : [],
      input: { ...call, status: { type: "running" } },
      expect: { phase: "running" },
    },
  ];
  const normalizedPhase = sample.isError ? "error" : "success";
  const renderPhase = hasProviderError(sample.result) ? "error" : normalizedPhase;
  fixtures.push({
    name: `${normalizedPhase}: ${sourceName}`,
    descriptor,
    basis,
    size,
    shows: sample.shows,
    input: {
      ...call,
      result: sample.result,
      isError: sample.isError,
      status: { type: "complete" },
    },
    expect: { phase: normalizedPhase, isError: sample.isError, result: sample.result },
    ...(renderPhase === normalizedPhase ? {} : { renderedPhase: renderPhase }),
  });
  return fixtures;
}

// Scripted from omp v18.9.1's URL-read builder (tools/fetch.ts): valid empty-body result envelope.
const SCRIPTED_URL_EMPTY: RealToolResult = {
  name: "read: scripted URL response with no body",
  toolName: "read",
  args: { path: "https://example.test/empty" },
  result: {
    content: [{ type: "text", text: "" }],
    details: {
      kind: "url",
      url: "https://example.test/empty",
      finalUrl: "https://example.test/empty",
      contentType: "text/html",
      method: "native",
      truncated: false,
      notes: [],
      meta: { source: { type: "url", value: "https://example.test/empty" } },
    },
  },
  isError: false,
  shows: ["No page content was returned."],
};

export const T4_URL_FIXTURES: readonly T4UrlFixture[] = [
  ...T4_REAL_RESULTS.filter((sample) => sample.toolName === "read").map((sample) => ({
    name: sample.name,
    basis: "recorded" as const,
    sample,
    shows: sample.shows,
  })),
  {
    name: "scripted URL read: valid empty page response",
    basis: "scripted",
    sample: SCRIPTED_URL_EMPTY,
    shows: SCRIPTED_URL_EMPTY.shows,
  },
];

export const T4_LIFECYCLE_FIXTURES: readonly T4LifecycleFixture[] = [
  ...T4_BROWSER_RESULTS.flatMap((sample, index) =>
    lifecycleOf(sample, index, "recorded-older-omp"),
  ),
  ...T4_REAL_RESULTS.filter((sample) => sample.toolName === "web_search").flatMap((sample, index) =>
    lifecycleOf(sample, index + T4_BROWSER_RESULTS.length, "recorded"),
  ),
  ...T4_WEB_FETCH_REAL_RESULTS.flatMap((sample, index) =>
    lifecycleOf(sample, index + T4_BROWSER_RESULTS.length + T4_REAL_RESULTS.length, "recorded"),
  ),
  ...T4_SCRIPTED_RESULTS.flatMap((sample, index) =>
    lifecycleOf(
      sample,
      index + T4_BROWSER_RESULTS.length + T4_REAL_RESULTS.length + T4_WEB_FETCH_REAL_RESULTS.length,
      "scripted",
    ),
  ),
];

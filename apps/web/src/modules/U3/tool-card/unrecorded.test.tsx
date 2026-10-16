import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TOOL_RENDERERS } from "@/registry";
import { REAL_TOOL_RESULTS } from "@/registry/real-results";
import type { ToolRendererProps } from "./contract";
import type { RealToolResult } from "./real-result";
import { createToolRegistry } from "./registry";

afterEach(() => cleanup());

const toolRegistry = createToolRegistry(TOOL_RENDERERS);

/**
 * The props of one tool call as the chat hands them to its card. The result is absent unless the caller gives one:
 * an unrecorded call has none, a running call has its status instead.
 */
function callProps(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  status: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
): ToolRendererProps {
  // The card reads only the fields a chat call carries; this builds those and no others.
  return {
    type: "tool-call",
    toolCallId: `${toolName}-call`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result: undefined,
    status,
    ...extra,
  } as unknown as ToolRendererProps;
}

/**
 * The 23 registry families that no recorded real result covers, each with the arguments its playground or its own
 * test uses. Each is rendered the way a recorded sample is, with no result.
 */
const FAMILIES_WITHOUT_A_SAMPLE: readonly {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}[] = [
  {
    toolName: "apply_patch",
    args: { patch: "*** Add File: src/pending.ts\n+export const pending = true;" },
  },
  {
    toolName: "ast_edit",
    args: { ops: [{ pat: "console.log($A)", out: "logger.info($A)" }], paths: ["src", "tests"] },
  },
  { toolName: "ast_grep", args: { pat: "console.log($$$)", path: "src" } },
  {
    toolName: "lsp",
    args: { action: "hover", file: "src/app.ts", line: 12, symbol: "retryBudget" },
  },
  { toolName: "computer", args: { action: "screenshot" } },
  { toolName: "debug", args: { action: "step_over" } },
  { toolName: "github", args: { op: "repo_view", repo: "owner/repo" } },
  { toolName: "vibe_kill", args: { id: "vibe-1" } },
  { toolName: "vibe_list", args: {} },
  { toolName: "vibe_send", args: { id: "vibe-1", message: "status?" } },
  { toolName: "vibe_wait", args: { id: "vibe-1" } },
  { toolName: "yield", args: {} },
  { toolName: "memory_edit", args: { op: "forget", id: "memory-1" } },
  { toolName: "xd__recall", args: { query: "textbook for the statistics course" } },
  { toolName: "reflect", args: { query: "What changed?", context: "release" } },
  { toolName: "checkpoint", args: { goal: "Ship the fix" } },
  { toolName: "mcp__notion_search", args: { query: "fixture" } },
  { toolName: "reject", args: { action: "discard", reason: "Operator rejected the request" } },
  { toolName: "resolve", args: { action: "apply", reason: "Approved by policy" } },
  { toolName: "rewind", args: { report: "Rewound to the checkpoint" } },
  {
    toolName: "security_scan",
    args: {
      action: "preflight",
      target_kind: "scoped_path",
      include_paths: ["src/", "packages/server/"],
    },
  },
  { toolName: "think", args: { thoughts: "private note" } },
];

/** What a call with no result reads as: No result recorded, never malformed, failed, a success or Complete. */
function expectNoResultRecorded(container: HTMLElement): void {
  expect(container.querySelector('[data-phase="unrecorded"]')).not.toBeNull();
  expect(screen.getAllByText("No result recorded").length).toBeGreaterThan(0);
  expect(container.querySelector('[data-phase="error"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent?.toLowerCase() ?? "").not.toContain("malformed");
  expect(container.querySelector('[class*="success"]')).toBeNull();
  expect(screen.queryByText("Complete")).toBeNull();
}

describe("a call with no recorded result, for every recorded real tool result", () => {
  test.each(REAL_TOOL_RESULTS)(
    "$name reads No result recorded: never malformed, failed, a success or Complete",
    (sample: RealToolResult) => {
      const Renderer = toolRegistry.resolve(sample.toolName).renderer;
      const { container } = render(
        <Renderer {...callProps(sample.toolName, sample.args, { type: "complete" })} />,
      );
      expectNoResultRecorded(container);
    },
  );
});

describe("a call with no recorded result, for each family no recorded result covers", () => {
  test.each(FAMILIES_WITHOUT_A_SAMPLE)(
    "$toolName reads No result recorded: never malformed, failed, a success or Complete",
    ({ toolName, args }) => {
      const Renderer = toolRegistry.resolve(toolName).renderer;
      const { container } = render(
        <Renderer {...callProps(toolName, args, { type: "complete" })} />,
      );
      expectNoResultRecorded(container);
    },
  );
});

describe("a call still waiting or running is not read as finished", () => {
  test("a running bash call reads as running, never as No result recorded", () => {
    const Bash = toolRegistry.resolve("bash").renderer;
    const { container } = render(
      <Bash {...callProps("bash", { command: "sleep 9" }, { type: "running" })} />,
    );
    expect(screen.queryByText("No result recorded")).toBeNull();
    expect(container.querySelector('[data-phase="unrecorded"]')).toBeNull();
  });

  test("a write whose message is complete while its run is active is waiting, not finished", () => {
    const Write = toolRegistry.resolve("write").renderer;
    const { container } = render(
      <Write
        {...callProps(
          "write",
          { path: "x.txt", content: "y" },
          { type: "complete" },
          { runActive: true },
        )}
      />,
    );
    expect(screen.queryByText("No result recorded")).toBeNull();
    expect(container.querySelector('[data-phase="unrecorded"]')).toBeNull();
  });
});

import type { RealToolResult } from "../../U3/tool-card/real-result";

/**
 * Scripted source-shape fixtures; none is a recording. Values copy omp v18.9.1 builder envelopes
 * (tools/checkpoint.ts:83-84,127-128; tools/think.ts:61-70; tools/resolve.ts:265-268;
 * tools/security-scan.ts:154-190; mcp/tool-bridge.ts:279-287; goals/tools/goal-tool.ts:107-130),
 * except the `host_tool`, `host_uri` and `custom_tool*` entries: no omp builder produces those; they
 * exercise the fallback card's own unavailable and large-output branches and carry no claim about omp.
 */
const LARGE_FALLBACK_TEXT = Array.from(
  { length: 24 },
  (_, index) => `Result line ${index + 1}`,
).join("\n");

export const T7_SOURCE_RESULTS: readonly RealToolResult[] = [
  {
    name: "[scripted] checkpoint: builder result envelope",
    toolName: "checkpoint",
    args: { goal: "Scrubbed checkpoint goal" },
    result: {
      content: [
        {
          type: "text",
          text: "Checkpoint: Scrubbed checkpoint goal\nFinish exploration and formulate findings.",
        },
      ],
      details: { goal: "Scrubbed checkpoint goal", startedAt: "2026-10-18T00:00:00.000Z" },
    },
    isError: false,
    shows: ["Scrubbed checkpoint goal"],
  },
  {
    name: "[scripted] rewind: builder result envelope",
    toolName: "rewind",
    args: { report: "Scrubbed rewind report" },
    result: {
      content: [
        {
          type: "text",
          text: "Rewind requested.\nReport captured for context replacement.",
        },
      ],
      details: { report: "Scrubbed rewind report", rewound: true },
    },
    isError: false,
    shows: ["Scrubbed rewind report"],
  },
  {
    name: "[scripted] resolve: legacy discard envelope",
    toolName: "resolve",
    args: { reason: "Scrubbed discard reason" },
    result: {
      content: [
        { type: "text", text: "Discarded: Scrubbed action. Reason: Scrubbed discard reason" },
      ],
      details: {
        action: "discard",
        reason: "Scrubbed discard reason",
        sourceToolName: "ast_edit",
        label: "Scrubbed action",
        sourceResultDetails: {},
      },
    },
    isError: false,
    shows: [],
  },
  {
    name: "[scripted] reject: legacy discard envelope",
    toolName: "reject",
    args: { reason: "Scrubbed discard reason" },
    result: {
      content: [
        { type: "text", text: "Discarded: Scrubbed action. Reason: Scrubbed discard reason" },
      ],
      details: {
        action: "discard",
        reason: "Scrubbed discard reason",
        sourceToolName: "ast_edit",
        label: "Scrubbed action",
        sourceResultDetails: {},
      },
    },
    isError: false,
    shows: [],
  },
  {
    name: "[scripted] resolve: no reason empty state",
    toolName: "resolve",
    args: {},
    result: {
      content: [{ type: "text", text: "Discarded: Scrubbed action. Reason: " }],
      details: { action: "discard", sourceToolName: "ast_edit", label: "Scrubbed action" },
    },
    isError: false,
    shows: [],
  },
  {
    name: "[scripted] security_scan: completed operation",
    toolName: "security_scan",
    args: { action: "status", operation_id: "operation-scrubbed" },
    result: {
      content: [{ type: "text", text: "Security scan scrubbed-scan: completed; 0 finding(s)." }],
      details: {
        action: "status",
        operation: {
          operationId: "operation-scrubbed",
          planId: "plan-scrubbed",
          scanId: "scrubbed-scan",
          phase: "completed",
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:00:01.000Z",
          findingCount: 0,
        },
      },
    },
    isError: false,
    shows: ["Completed", "0 findings"],
  },
  {
    name: "[scripted] security_scan: no cloud configurations empty state",
    toolName: "security_scan",
    args: { action: "cloud_scans" },
    result: {
      content: [
        { type: "text", text: "No Codex Security cloud scan configurations are available." },
      ],
      details: { action: "cloud_scans", cloudConfigurations: [] },
    },
    isError: false,
    shows: ["No cloud scans are set up."],
  },
  {
    name: "[scripted] think: private acknowledgment",
    toolName: "think",
    args: { thoughts: "Scrubbed private thought" },
    result: {
      content: [{ type: "text", text: "------" }],
      details: { recorded: true },
    },
    isError: false,
    shows: ["Private note recorded", "The content stays private."],
  },
  {
    name: "[scripted] goal: active goal with builder text",
    toolName: "goal",
    args: { op: "create", objective: "Scrubbed active goal" },
    result: {
      content: [
        { type: "text", text: "Goal: Scrubbed active goal\nStatus: active\nTokens: 0 used" },
      ],
      details: {
        op: "create",
        goal: {
          id: "goal-scrubbed",
          objective: "Scrubbed active goal",
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1789145365652,
          updatedAt: 1789145365652,
        },
        remainingTokens: null,
        completionBudgetReport: null,
      },
    },
    isError: false,
    shows: ["Active", "0 tokens used"],
  },
  {
    name: "[scripted] goal: no active goal empty state",
    toolName: "goal",
    args: { op: "get" },
    result: {
      content: [{ type: "text", text: "No active goal." }],
      details: { op: "get", goal: null, remainingTokens: null, completionBudgetReport: null },
    },
    isError: false,
    shows: ["No active goal."],
  },
  {
    name: "[scripted] mcp fallback result envelope",
    toolName: "mcp__sample_server_sample_tool",
    args: { query: "Scrubbed query" },
    result: {
      content: [{ type: "text", text: "MCP tool completed." }],
      details: {
        serverName: "sample_server",
        mcpToolName: "sample_tool",
        isError: false,
        rawContent: [{ type: "text", text: "MCP tool completed." }],
        mcpMeta: {},
        provider: "sample",
        providerName: "sample server",
      },
    },
    isError: false,
    shows: ["MCP tool completed."],
  },
  {
    name: "[scripted] xd MCP fallback result envelope",
    toolName: "xd__mcp__sample_server_sample_tool",
    args: { query: "Scrubbed query" },
    result: {
      content: [{ type: "text", text: "MCP tool completed." }],
      details: {
        serverName: "sample_server",
        mcpToolName: "sample_tool",
        isError: false,
        rawContent: [{ type: "text", text: "MCP tool completed." }],
        mcpMeta: {},
        provider: "sample",
        providerName: "sample server",
      },
    },
    isError: false,
    shows: ["MCP tool completed."],
  },
  {
    name: "[scripted] host tool unavailable empty result",
    toolName: "host_tool",
    args: { toolName: "Scrubbed host tool" },
    result: {
      content: [{ type: "text", text: "This tool is not available in the app." }],
      details: { status: "unavailable", toolName: "Scrubbed host tool" },
    },
    isError: false,
    shows: ["This tool is not available in the app."],
  },
  {
    name: "[scripted] host URI unavailable empty result",
    toolName: "host_uri",
    args: { operation: "read", url: "local://scrubbed" },
    result: {
      content: [{ type: "text", text: "This tool is not available in the app." }],
      details: { status: "unavailable", operation: "read", url: "local://scrubbed" },
    },
    isError: false,
    shows: ["This tool is not available in the app."],
  },
  {
    name: "[scripted] custom fallback empty result",
    toolName: "custom_tool",
    args: {},
    result: { content: [{ type: "text", text: "" }], details: {} },
    isError: false,
    shows: [],
  },
  {
    name: "[scripted] custom fallback large result",
    toolName: "custom_tool_large",
    args: { value: "Scrubbed value" },
    result: {
      content: [{ type: "text", text: LARGE_FALLBACK_TEXT }],
      details: {},
    },
    isError: false,
    shows: ["Result line 1", "Show all 24 lines"],
  },
];

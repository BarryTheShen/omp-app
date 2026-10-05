import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { T7ToolFallback } from "./fallback";
import { ResolveToolRenderer } from "./resolve";

/** T7 owns exactly eight miscellaneous/host/domain renderer claims; the main agent composes them. */
export const T7_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T7.checkpoint",
    owner: "T7",
    title: "Checkpoint",
    covers: ["T7.checkpoint"],
    requires: [],
    match: { by: "name", name: "checkpoint" },
    renderer: T7ToolFallback,
  },
  {
    kind: "tool",
    id: "T7.goal",
    owner: "T7",
    title: "Goal",
    covers: ["T7.goal"],
    requires: ["upstream.goal"],
    match: { by: "name", name: "goal" },
    renderer: T7ToolFallback,
  },
  {
    kind: "tool",
    id: "T7.host-custom-mcp-tool-fallback",
    owner: "T7",
    title: "Host, custom, or MCP tool",
    covers: ["T7.host-custom-mcp-tool-fallback"],
    requires: [],
    match: { by: "fallback" },
    renderer: T7ToolFallback,
  },
  {
    kind: "tool",
    id: "T7.reject",
    owner: "T7",
    title: "Reject",
    covers: ["T7.reject"],
    requires: [],
    match: { by: "name", name: "reject" },
    renderer: ResolveToolRenderer,
  },
  {
    kind: "tool",
    id: "T7.resolve",
    owner: "T7",
    title: "Resolve",
    covers: ["T7.resolve"],
    requires: [],
    match: { by: "name", name: "resolve" },
    renderer: ResolveToolRenderer,
  },
  {
    kind: "tool",
    id: "T7.rewind",
    owner: "T7",
    title: "Rewind",
    covers: ["T7.rewind"],
    requires: ["host.checkpoints"],
    match: { by: "name", name: "rewind" },
    renderer: T7ToolFallback,
  },
  {
    kind: "tool",
    id: "T7.securityScan",
    owner: "T7",
    title: "Security scan",
    covers: ["T7.security-scan"],
    requires: ["upstream.security-scan"],
    match: { by: "name", name: "security_scan" },
    renderer: T7ToolFallback,
  },
  {
    kind: "tool",
    id: "T7.think",
    owner: "T7",
    title: "Private thought",
    covers: ["T7.think"],
    requires: [],
    match: { by: "name", name: "think" },
    renderer: T7ToolFallback,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export type T7ToolDescriptor = (typeof T7_TOOL_DESCRIPTORS)[number];

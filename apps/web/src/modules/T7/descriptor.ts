import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { CheckpointToolRenderer, RewindToolRenderer } from "./checkpoint";
import { T7ToolFallback } from "./fallback";
import { GoalToolRenderer } from "./goal";
import { ResolveToolRenderer } from "./resolve";
import { SecurityScanToolRenderer } from "./security";
import { ThinkToolRenderer } from "./think";

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
    renderer: CheckpointToolRenderer,
  },
  {
    kind: "tool",
    id: "T7.goal",
    owner: "T7",
    title: "Goal",
    covers: ["T7.goal"],
    requires: ["upstream.goal"],
    match: { by: "name", name: "goal" },
    renderer: GoalToolRenderer,
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
    renderer: RewindToolRenderer,
  },
  {
    kind: "tool",
    id: "T7.securityScan",
    owner: "T7",
    title: "Security scan",
    covers: ["T7.security-scan"],
    requires: ["upstream.security-scan"],
    match: { by: "name", name: "security_scan" },
    renderer: SecurityScanToolRenderer,
  },
  {
    kind: "tool",
    id: "T7.think",
    owner: "T7",
    title: "Private thought",
    covers: ["T7.think"],
    requires: [],
    match: { by: "name", name: "think" },
    renderer: ThinkToolRenderer,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export type T7ToolDescriptor = (typeof T7_TOOL_DESCRIPTORS)[number];

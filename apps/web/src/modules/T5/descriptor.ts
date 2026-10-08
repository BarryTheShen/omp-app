import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { ToolFallback } from "../U3/tool-card/fallback";
import { HubToolRenderer } from "./hub";
import { TaskToolRenderer } from "./task";
import { VIBE_SPAWN_DESCRIPTOR } from "./vibe-spawn";
import { WaitToolRenderer } from "./wait";
/** T5 claims nine exact tool names; task also owns P1's compact read-only task row. */
export const T5_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T5.hub",
    owner: "T5",
    title: "Hub coordination",
    covers: ["T5.hub"],
    requires: [],
    match: { by: "name", name: "hub" },
    renderer: HubToolRenderer,
  },
  {
    kind: "tool",
    id: "T5.task",
    owner: "T5",
    title: "Task and subagent",
    covers: ["T5.task", "P1.task-subagent-card"],
    requires: [],
    match: { by: "name", name: "task" },
    renderer: TaskToolRenderer,
  },
  {
    kind: "tool",
    id: "T5.vibeKill",
    owner: "T5",
    title: "Kill vibe worker",
    covers: ["T5.vibe-kill"],
    requires: [],
    match: { by: "name", name: "vibe_kill" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T5.vibeList",
    owner: "T5",
    title: "List vibe workers",
    covers: ["T5.vibe-list"],
    requires: [],
    match: { by: "name", name: "vibe_list" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T5.vibeSend",
    owner: "T5",
    title: "Send to vibe worker",
    covers: ["T5.vibe-send"],
    requires: [],
    match: { by: "name", name: "vibe_send" },
    renderer: ToolFallback,
  },
  VIBE_SPAWN_DESCRIPTOR,
  {
    kind: "tool",
    id: "T5.vibeWait",
    owner: "T5",
    title: "Wait for vibe workers",
    covers: ["T5.vibe-wait"],
    requires: [],
    match: { by: "name", name: "vibe_wait" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T5.yield",
    owner: "T5",
    title: "Yield submission",
    covers: ["T5.yield"],
    requires: [],
    match: { by: "name", name: "yield" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T5.wait",
    owner: "T5",
    title: "Coordination wait",
    covers: ["T5.wait"],
    requires: [],
    match: { by: "name", name: "wait" },
    renderer: WaitToolRenderer,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export type T5ToolDescriptor = (typeof T5_TOOL_DESCRIPTORS)[number];

import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { ToolFallback } from "../U3/tool-card/fallback";
import { RecallRenderer } from "./recall";
import { ReflectRenderer } from "./reflect";
/** Exactly the six T6 memory/learning rows; no descriptor claims a checkpoint or memory backend row. */
export const T6_INVENTORY_COVERS = [
  "T6.learn",
  "T6.manage-skill",
  "T6.memory-edit",
  "T6.recall",
  "T6.reflect",
  "T6.retain",
] as const;
export type T6InventoryId = (typeof T6_INVENTORY_COVERS)[number];

export const T6_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T6.learn",
    owner: "T6",
    title: "Learn",
    covers: ["T6.learn"],
    requires: [],
    match: { by: "name", name: "learn" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T6.manage-skill",
    owner: "T6",
    title: "Manage skill",
    covers: ["T6.manage-skill"],
    requires: [],
    match: { by: "name", name: "manage_skill" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T6.memory-edit",
    owner: "T6",
    title: "Memory edit",
    covers: ["T6.memory-edit"],
    requires: [],
    match: { by: "name", name: "memory_edit" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T6.recall",
    owner: "T6",
    title: "Recall memory",
    covers: ["T6.recall"],
    requires: [],
    match: { by: "name", name: "recall" },
    renderer: RecallRenderer,
  },
  {
    kind: "tool",
    id: "T6.reflect",
    owner: "T6",
    title: "Reflect on memory",
    covers: ["T6.reflect"],
    requires: [],
    match: { by: "name", name: "reflect" },
    renderer: ReflectRenderer,
  },
  {
    kind: "tool",
    id: "T6.retain",
    owner: "T6",
    title: "Retain memory",
    covers: ["T6.retain"],
    requires: [],
    match: { by: "name", name: "retain" },
    renderer: ToolFallback,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

/** memory_edit has no browser mutation control at the release floor. */
export const T6_MEMORY_EDIT_CAPABILITY = "upstream.memory-edit" as const;

export type T6ToolDescriptor = (typeof T6_TOOL_DESCRIPTORS)[number];

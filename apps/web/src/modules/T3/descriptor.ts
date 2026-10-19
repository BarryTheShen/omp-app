import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { ToolFallback } from "../U3/tool-card/fallback";
import { DebugToolRenderer } from "./debug";
import { EvalToolRenderer } from "./eval";

/** Exactly the three execution/computer inventory rows owned by T3. */
export const T3_INVENTORY_COVERS = ["T3.computer", "T3.debug", "T3.eval"] as const;
export type T3InventoryId = (typeof T3_INVENTORY_COVERS)[number];

export const T3_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T3.computer",
    owner: "T3",
    title: "Computer",
    covers: ["T3.computer"],
    requires: [],
    match: { by: "name", name: "computer" },
    renderer: ToolFallback,
  },
  {
    kind: "tool",
    id: "T3.debug",
    owner: "T3",
    title: "Debug",
    covers: ["T3.debug"],
    requires: [],
    match: { by: "name", name: "debug" },
    renderer: DebugToolRenderer,
  },
  {
    kind: "tool",
    id: "T3.eval",
    owner: "T3",
    title: "Evaluate code",
    covers: ["T3.eval"],
    requires: [],
    match: { by: "name", name: "eval" },
    renderer: EvalToolRenderer,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export type T3ToolDescriptor = (typeof T3_TOOL_DESCRIPTORS)[number];

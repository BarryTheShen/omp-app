import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { ToolFallback } from "../U3/tool-card/fallback";
import { DebugToolRenderer } from "./debug";
import { EvalToolRenderer } from "./eval";

/** Exactly the four execution/computer inventory rows owned by T3. */
export const T3_INVENTORY_COVERS = [
  "T3.computer",
  "T3.debug",
  "T3.eval",
  "T3.inspect-image",
] as const;
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
  {
    kind: "tool",
    id: "T3.inspect-image",
    owner: "T3",
    title: "Inspect image",
    covers: ["T3.inspect-image"],
    requires: [],
    match: { by: "name", name: "inspect_image" },
    renderer: ToolFallback,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export const T3_LIVE_CAPABILITIES = {
  computer: "upstream.computer" as const,
  debug: "upstream.debug" as const,
  eval: "upstream.eval" as const,
  inspectImage: "upstream.inspect-image" as const,
};

export type T3ToolDescriptor = (typeof T3_TOOL_DESCRIPTORS)[number];

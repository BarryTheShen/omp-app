/**
 * The app's composition index: every module's descriptors and renderers, merged into one
 * registry. U0.5 ships it empty; from here on only the main agent edits it, adding one import and
 * one spread per module as that module's descriptors and renderers merge
 * (`AGENTS.md`, "Who may change what"; `apps/web/src/registry/` ownership in
 * `packages/contracts/README.md`).
 */
import type { Descriptor } from "@omp-app/contracts";
import { D2_TRIGGER_DESCRIPTORS } from "../modules/D2/contract";
import { N1_DESCRIPTORS } from "../modules/N1/descriptors";
import { P4_DESCRIPTORS } from "../modules/P4/contract";
import { R1_DESCRIPTORS } from "../modules/R1/descriptors";
import { T1_TOOL_DESCRIPTORS } from "../modules/T1/descriptor";
import { U1MessageDescriptors } from "../modules/U1/registry/messages";
import { U2Descriptors } from "../modules/U2/descriptors";
import { U3_BASH_DESCRIPTOR } from "../modules/U3/tool-card/bash";
import type { ToolRegistryDescriptor } from "../modules/U3/tool-card/contract";
import { U4Descriptors } from "../modules/U4/descriptors";
import { todoToolDescriptor } from "../modules/U5/todo/tool-card/tool-card";
import { createRegistry, type RendererMap } from "../registry-core";

/** Tool renderers by omp tool name, for U3.3's createToolRegistry (U3's fallback covers the rest). */
export const TOOL_RENDERERS: readonly ToolRegistryDescriptor[] = [
  U3_BASH_DESCRIPTOR,
  todoToolDescriptor,
  ...T1_TOOL_DESCRIPTORS,
];

/** A tool descriptor carries its renderer for U3.3's resolver; the registry holds the C0 part. */
function withoutRenderer(descriptor: ToolRegistryDescriptor): Descriptor {
  const { renderer: _renderer, ...rest } = descriptor;
  return rest;
}

export const DESCRIPTORS: readonly Descriptor[] = [
  ...U1MessageDescriptors,
  ...U2Descriptors,
  ...R1_DESCRIPTORS,
  ...N1_DESCRIPTORS,
  ...P4_DESCRIPTORS,
  ...D2_TRIGGER_DESCRIPTORS,
  ...U4Descriptors,
  ...TOOL_RENDERERS.map(withoutRenderer),
];

export const RENDERERS: RendererMap = {};

/** Built once at module load, so a registry conflict fails immediately rather than on first render. */
export const registry = createRegistry(DESCRIPTORS);

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
import { P6_SHORTCUT_DESCRIPTORS } from "../modules/P6/shortcuts/descriptors";
import { R1_DESCRIPTORS } from "../modules/R1/descriptors";
import { T1_TOOL_DESCRIPTORS } from "../modules/T1/descriptor";
import { createReadToolRenderer } from "../modules/T1/read";
import { T2_MESSAGE_DESCRIPTORS, T2_TOOL_DESCRIPTORS } from "../modules/T2/descriptor";
import { T3_TOOL_DESCRIPTORS } from "../modules/T3/descriptor";
import { T4_TOOL_DESCRIPTORS } from "../modules/T4/descriptor";
import { T4ReadUrlRenderer } from "../modules/T4/url-read";
import { T5_TOOL_DESCRIPTORS } from "../modules/T5/descriptor";
import { T6_TOOL_DESCRIPTORS } from "../modules/T6/descriptor";
import { T7_TOOL_DESCRIPTORS } from "../modules/T7/descriptor";
import { THINKING_VISIBILITY_SHORTCUT_DESCRIPTOR } from "../modules/U1/policy/policy";
import { U1MessageDescriptors } from "../modules/U1/registry/messages";
import { U2Descriptors } from "../modules/U2/descriptors";
import { U2_EXTERNAL_EDITOR_SHORTCUT } from "../modules/U2/shortcuts/shortcuts";
import { U3_BASH_DESCRIPTOR } from "../modules/U3/tool-card/bash";
import type { ToolRegistryDescriptor } from "../modules/U3/tool-card/contract";
import { U4Descriptors } from "../modules/U4/descriptors";
import { todoToolDescriptor } from "../modules/U5/todo/tool-card/tool-card";
import { createRegistry, type RendererMap } from "../registry-core";

/** T1's read card renders URL reads through T4's renderer; the seam keeps T1 from importing T4. */
const READ_WITH_URLS = createReadToolRenderer(T4ReadUrlRenderer);

/** Tool renderers by omp tool name, for U3.3's createToolRegistry (T7 owns the one fallback). */
export const TOOL_RENDERERS: readonly ToolRegistryDescriptor[] = [
  U3_BASH_DESCRIPTOR,
  todoToolDescriptor,
  ...T1_TOOL_DESCRIPTORS.map((descriptor) =>
    descriptor.id === "T1.read" ? { ...descriptor, renderer: READ_WITH_URLS } : descriptor,
  ),
  ...T2_TOOL_DESCRIPTORS,
  ...T3_TOOL_DESCRIPTORS,
  ...T4_TOOL_DESCRIPTORS,
  ...T5_TOOL_DESCRIPTORS,
  ...T6_TOOL_DESCRIPTORS,
  ...T7_TOOL_DESCRIPTORS,
];

/** A tool descriptor carries its renderer for U3.3's resolver; the registry holds the C0 part. */
function withoutRenderer(descriptor: ToolRegistryDescriptor): Descriptor {
  const { renderer: _renderer, ...rest } = descriptor;
  return rest;
}

export const DESCRIPTORS: readonly Descriptor[] = [
  ...U1MessageDescriptors,
  THINKING_VISIBILITY_SHORTCUT_DESCRIPTOR,
  ...U2Descriptors,
  U2_EXTERNAL_EDITOR_SHORTCUT,
  ...R1_DESCRIPTORS,
  ...N1_DESCRIPTORS,
  ...P4_DESCRIPTORS,
  ...P6_SHORTCUT_DESCRIPTORS,
  ...D2_TRIGGER_DESCRIPTORS,
  ...U4Descriptors,
  ...T2_MESSAGE_DESCRIPTORS,
  ...TOOL_RENDERERS.map(withoutRenderer),
];

export const RENDERERS: RendererMap = {};

/** Built once at module load, so a registry conflict fails immediately rather than on first render. */
export const registry = createRegistry(DESCRIPTORS);

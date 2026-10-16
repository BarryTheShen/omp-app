/**
 * The app's composition index: every module's descriptors and renderers, merged into one
 * registry. U0.5 ships it empty; from here on only the main agent edits it, adding one import and
 * one spread per module as that module's descriptors and renderers merge
 * (`AGENTS.md`, "Who may change what"; `apps/web/src/registry/` ownership in
 * `packages/contracts/README.md`).
 */
import type { Descriptor } from "@omp-app/contracts";
import { D1_DESCRIPTORS } from "../modules/D1/descriptors";
import { modelSettingsSections } from "../modules/D1/settings/descriptors";
import { D2_DESCRIPTORS } from "../modules/D2";
import { D3_LOGIN_DESCRIPTORS } from "../modules/D3/descriptors";
import { D4_DESCRIPTORS } from "../modules/D4/descriptors";
import { D5_LIFECYCLE_COMMAND_DESCRIPTORS } from "../modules/D5/descriptors";
import { D6_REPORT_PALETTE_COMMANDS } from "../modules/D6/reports";
import { D7_EXECUTION_MODES_COMMAND } from "../modules/D7/modes/descriptors";
import { I1_MCP_SERVER_DESCRIPTORS } from "../modules/I1/servers/descriptors";
import { I1_SETTINGS_SECTIONS } from "../modules/I1/settings/descriptors";
import { I5_SETTINGS_SECTIONS } from "../modules/I5/settings";
import { N1_DESCRIPTORS } from "../modules/N1/descriptors";
import { P1_AGENT_HUB_DESCRIPTORS } from "../modules/P1/hub/descriptors";
import { P3_MESSAGE_DESCRIPTORS } from "../modules/P3/descriptors";
import { P3_SHORTCUT_DESCRIPTORS } from "../modules/P3/shortcuts/descriptors";
import { P4_DESCRIPTORS } from "../modules/P4/contract";
import { P6_DESCRIPTORS } from "../modules/P6";
import { R1_DESCRIPTORS } from "../modules/R1/descriptors";
import { S1_DESCRIPTORS, S1_SETTINGS_SECTIONS } from "../modules/S1/descriptors";
import type { SettingsSectionDescriptor } from "../modules/S1/settings-kit";
import { S2_SETTINGS_SECTIONS } from "../modules/S2/sections";
import { S3_SETTINGS_SECTIONS } from "../modules/S3/sections";
import { T1_TOOL_DESCRIPTORS } from "../modules/T1/descriptor";
import { createReadToolRenderer } from "../modules/T1/read";
import { T2_MESSAGE_DESCRIPTORS, T2_TOOL_DESCRIPTORS } from "../modules/T2/descriptor";
import { T3_TOOL_DESCRIPTORS } from "../modules/T3/descriptor";
import { T4_TOOL_DESCRIPTORS } from "../modules/T4/descriptor";
import { T4ReadUrlRenderer } from "../modules/T4/url-read";
import { WEB_FETCH_DESCRIPTOR } from "../modules/T4/web-fetch";
import { T5_TOOL_DESCRIPTORS } from "../modules/T5/descriptor";
import { T6_TOOL_DESCRIPTORS } from "../modules/T6/descriptor";
import { T7_TOOL_DESCRIPTORS } from "../modules/T7/descriptor";
import { U1MessageDescriptors } from "../modules/U1/registry/messages";
import { U1ShortcutDescriptors } from "../modules/U1/registry/shortcuts";
import { U2Descriptors } from "../modules/U2/descriptors";
import { U2_EXTERNAL_EDITOR_SHORTCUT } from "../modules/U2/shortcuts/shortcuts";
import { U3_BASH_DESCRIPTOR } from "../modules/U3/tool-card/bash";
import type { ToolRegistryDescriptor } from "../modules/U3/tool-card/contract";
import { U4Descriptors } from "../modules/U4/descriptors";
import { ASK_TOOL_DESCRIPTOR } from "../modules/U4/dialogs/ask-result";
import { U5Descriptors } from "../modules/U5/descriptors";
import { todoToolDescriptor } from "../modules/U5/todo/tool-card/tool-card";
import {
  U0_COMMAND_PALETTE_SHORTCUT,
  U0_PALETTE_COMMANDS,
  U0_SAVE_DEBUG_LOG_COMMAND,
} from "../palette/descriptor";
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
  WEB_FETCH_DESCRIPTOR,
  ...T5_TOOL_DESCRIPTORS,
  ...T6_TOOL_DESCRIPTORS,
  ...T7_TOOL_DESCRIPTORS,
  ASK_TOOL_DESCRIPTOR,
];

/**
 * Every settings section the app offers, once each: S1 (appearance, interaction), S2 (files, LSP,
 * shell), S3 (tools, tasks), I5 (speech, providers), I1 (MCP) and D1 (model). The Settings screen
 * reads this one list; no screen or module concatenates section lists of its own. The order is not
 * presentation: the screen decides its own grouping and order. A section belongs here when its
 * module merges (one import, one spread), and the ownership test fails when two sections claim one
 * omp key.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  ...S1_SETTINGS_SECTIONS,
  ...S2_SETTINGS_SECTIONS,
  ...S3_SETTINGS_SECTIONS,
  ...I5_SETTINGS_SECTIONS,
  ...I1_SETTINGS_SECTIONS,
  ...modelSettingsSections,
];

/** A tool descriptor carries its renderer for U3.3's resolver; the registry holds the C0 part. */
function withoutRenderer(descriptor: ToolRegistryDescriptor): Descriptor {
  const { renderer: _renderer, ...rest } = descriptor;
  return rest;
}

export const DESCRIPTORS: readonly Descriptor[] = [
  ...U1MessageDescriptors,
  ...U1ShortcutDescriptors,
  ...U2Descriptors,
  ...D1_DESCRIPTORS,
  U2_EXTERNAL_EDITOR_SHORTCUT,
  U0_COMMAND_PALETTE_SHORTCUT,
  U0_SAVE_DEBUG_LOG_COMMAND,
  ...D3_LOGIN_DESCRIPTORS,
  ...P1_AGENT_HUB_DESCRIPTORS,
  ...P3_SHORTCUT_DESCRIPTORS,
  ...U0_PALETTE_COMMANDS,
  D7_EXECUTION_MODES_COMMAND,
  // S1's Settings command, so the palette can offer it; its handler is mounted with the open thread.
  ...S1_DESCRIPTORS.filter((descriptor) => descriptor.kind === "command"),
  ...D4_DESCRIPTORS,
  ...R1_DESCRIPTORS,
  ...D5_LIFECYCLE_COMMAND_DESCRIPTORS,
  ...D6_REPORT_PALETTE_COMMANDS,
  ...N1_DESCRIPTORS,
  ...P3_MESSAGE_DESCRIPTORS,
  ...P4_DESCRIPTORS,
  ...P6_DESCRIPTORS,
  ...I1_MCP_SERVER_DESCRIPTORS,
  ...D2_DESCRIPTORS,
  // ASK_TOOL_DESCRIPTOR (TOOL_RENDERERS above) carries U4.ask's row, so U4's copy is left out.
  ...U4Descriptors.filter((descriptor) => descriptor.id !== ASK_TOOL_DESCRIPTOR.id),
  ...U5Descriptors,
  ...T2_MESSAGE_DESCRIPTORS,
  ...TOOL_RENDERERS.map(withoutRenderer),
];

export const RENDERERS: RendererMap = {};

/** Built once at module load, so a registry conflict fails immediately rather than on first render. */
export const registry = createRegistry(DESCRIPTORS);

import type { Descriptor, SettingDescriptor } from "@omp-app/contracts";
import type { SettingsSectionDescriptor } from "../../S1/settings-kit";
import { MCP_AUTH_CAPABILITY } from "../auth/capabilities";
import { I1_MCP_SERVER_DESCRIPTORS } from "../servers/descriptors";
import { MCP_SETTING_KEYS, MCP_SETTINGS_SECTION_DESCRIPTOR } from "../settings";

const MCP_AUTH_DESCRIPTORS = [
  {
    kind: "command",
    id: "I1.authGatewayStdio",
    owner: "I1",
    title: "Provider credential gateway for terminal clients",
    covers: ["C4.auth-gateway-stdio"],
    requires: ["upstream.auth-gateway-stdio"],
  },
  {
    kind: "command",
    id: "I1.mcpReauth",
    owner: "I1",
    title: "Reauthorize MCP server",
    covers: ["C4.mcp-reauth"],
    requires: ["host.command-gateway", "host.mcp", MCP_AUTH_CAPABILITY],
  },
  {
    kind: "command",
    id: "I1.mcpSmitheryLogin",
    owner: "I1",
    title: "Sign in to Smithery",
    covers: ["C4.mcp-smithery-login"],
    requires: ["host.command-gateway", "host.mcp", MCP_AUTH_CAPABILITY],
  },
  {
    kind: "command",
    id: "I1.mcpSmitheryLogout",
    owner: "I1",
    title: "Sign out of Smithery",
    covers: ["C4.mcp-smithery-logout"],
    requires: ["host.command-gateway", "host.mcp", MCP_AUTH_CAPABILITY],
  },
  {
    kind: "command",
    id: "I1.mcpUnauth",
    owner: "I1",
    title: "Remove MCP authorization",
    covers: ["C4.mcp-unauth"],
    requires: ["host.command-gateway", "host.mcp", MCP_AUTH_CAPABILITY],
  },
] as const satisfies readonly Descriptor[];

const MCP_PROTOCOL_DESCRIPTORS = [
  {
    kind: "command",
    id: "I1.mcpNotifications",
    owner: "I1",
    title: "Show MCP notifications",
    covers: ["C4.mcp-notifications"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpPrompts",
    owner: "I1",
    title: "List MCP prompts",
    covers: ["C4.mcp-prompts"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpResources",
    owner: "I1",
    title: "List MCP resources",
    covers: ["C4.mcp-resources"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpSmitherySearch",
    owner: "I1",
    title: "Search Smithery",
    covers: ["C4.mcp-smithery-search"],
    requires: ["host.command-gateway", "host.mcp"],
  },
] as const satisfies readonly Descriptor[];

export const I1_MCP_AUTH_DESCRIPTORS = MCP_AUTH_DESCRIPTORS;
export const I1_MCP_PROTOCOL_DESCRIPTORS = MCP_PROTOCOL_DESCRIPTORS;

export const I1_WIZARD_DESCRIPTOR = {
  kind: "dialog",
  id: "I1.mcpAddWizard",
  owner: "I1",
  title: "Add MCP server",
  covers: ["C4.mcp-add-wizard"],
  requires: ["host.mcp", "host.command-gateway"],
} as const satisfies Descriptor;

/** C0 records one representative key per settings group; the section retains all real MCP keys. */
function settingDescriptor(section: SettingsSectionDescriptor): SettingDescriptor {
  const representative = section.controls[0];
  if (!representative) {
    throw new Error(`I1 settings section ${section.id} has no registered controls.`);
  }
  if (!MCP_SETTING_KEYS.includes(representative.key as (typeof MCP_SETTING_KEYS)[number])) {
    throw new Error(`I1 settings section ${section.id} uses an unknown MCP setting key.`);
  }
  return {
    id: section.id,
    owner: "I1",
    title: section.title,
    kind: "setting",
    covers: [...section.inventory],
    requires: [...section.requires],
    key: representative.key,
    section: section.section,
  };
}

export const I1_SETTINGS_DESCRIPTOR = settingDescriptor(MCP_SETTINGS_SECTION_DESCRIPTOR);

export const I1_DESCRIPTORS = [
  ...I1_MCP_SERVER_DESCRIPTORS,
  ...MCP_AUTH_DESCRIPTORS,
  ...MCP_PROTOCOL_DESCRIPTORS,
  I1_WIZARD_DESCRIPTOR,
  I1_SETTINGS_DESCRIPTOR,
] as const satisfies readonly Descriptor[];

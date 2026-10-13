import type { Descriptor } from "@omp-app/contracts";

/**
 * I1.3 owns the server lifecycle rows. Auth/Smithery rows belong to I1.4 and
 * resources/prompts/notifications belong to I1.5; the central registry composes
 * those later without duplicating the `/mcp` namespace claim.
 */
export const I1_MCP_SERVER_DESCRIPTORS = [
  {
    kind: "command",
    id: "I1.mcp",
    owner: "I1",
    title: "Manage MCP servers",
    covers: ["C4.mcp"],
    requires: ["host.command-gateway", "host.mcp"],
    slash: { name: "mcp", source: "builtin" },
  },
  {
    kind: "command",
    id: "I1.mcpAdd",
    owner: "I1",
    title: "Add MCP server",
    covers: ["C4.mcp-add"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpDisable",
    owner: "I1",
    title: "Disable MCP server",
    covers: ["C4.mcp-disable"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpEnable",
    owner: "I1",
    title: "Enable MCP server",
    covers: ["C4.mcp-enable"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpHelp",
    owner: "I1",
    title: "Show MCP help",
    covers: ["C4.mcp-help"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpList",
    owner: "I1",
    title: "List MCP servers",
    covers: ["C4.mcp-list"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpReconnect",
    owner: "I1",
    title: "Reconnect MCP server",
    covers: ["C4.mcp-reconnect"],
    requires: ["host.command-gateway", "host.mcp", "upstream.mcp-reconnect"],
  },
  {
    kind: "command",
    id: "I1.mcpReload",
    owner: "I1",
    title: "Refresh command list",
    covers: ["C4.mcp-reload"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpRemove",
    owner: "I1",
    title: "Remove MCP server",
    covers: ["C4.mcp-remove"],
    requires: ["host.command-gateway", "host.mcp"],
  },
  {
    kind: "command",
    id: "I1.mcpTest",
    owner: "I1",
    title: "Test MCP server",
    covers: ["C4.mcp-test"],
    requires: ["host.command-gateway", "host.mcp"],
  },
] as const satisfies readonly Descriptor[];

export type I1McpServerDescriptor = (typeof I1_MCP_SERVER_DESCRIPTORS)[number];

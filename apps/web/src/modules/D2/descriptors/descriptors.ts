import type { Descriptor } from "@omp-app/contracts";

/**
 * D2's command-source descriptors: the six D3 inventory rows that D2.1's composer triggers do not cover (D2.1 covers the
 * slash trigger and every D7 row). The five sources omp lists in get_available_commands claim their whole source:
 * `slash.name` is `*`, since no one command name stands for a source, and the ownership table gives each
 * `source:<name>` to D2. The prompt templates are not in omp's command list (fixtures/captures.ts records two
 * of them and their absence), so their descriptor claims no slash name; a typed prompt reaches omp's template handling
 * through the `prompt` command. No descriptor has a handler, so the command palette does not list these.
 */
export const D2_SOURCE_DESCRIPTORS = [
  {
    kind: "command",
    id: "D2.mcpPromptSource",
    owner: "D2",
    title: "MCP prompts",
    covers: ["D3.mcp-prompt"],
    requires: ["omp.cmd.get_available_commands", "host.mcp"],
    slash: { name: "*", source: "mcp_prompt" },
  },
  {
    kind: "command",
    id: "D2.customSource",
    owner: "D2",
    title: "Custom commands",
    covers: ["D3.custom-typescript"],
    requires: ["omp.cmd.get_available_commands"],
    slash: { name: "*", source: "custom" },
  },
  {
    kind: "command",
    id: "D2.extensionSource",
    owner: "D2",
    title: "Extension commands",
    covers: ["D3.extension-registered"],
    requires: ["omp.cmd.get_available_commands"],
    slash: { name: "*", source: "extension" },
  },
  {
    kind: "command",
    id: "D2.fileSource",
    owner: "D2",
    title: "File commands",
    covers: ["D3.file-slash-command"],
    requires: ["omp.cmd.get_available_commands"],
    slash: { name: "*", source: "file" },
  },
  {
    kind: "command",
    id: "D2.skillSource",
    owner: "D2",
    title: "Skill commands",
    covers: ["D3.skill-name"],
    requires: ["omp.cmd.get_available_commands"],
    slash: { name: "*", source: "skill" },
  },
  {
    kind: "command",
    id: "D2.promptTemplates",
    owner: "D2",
    title: "Prompt templates",
    covers: ["D3.prompt-template"],
    requires: ["omp.cmd.prompt"],
  },
] as const satisfies readonly Descriptor[];

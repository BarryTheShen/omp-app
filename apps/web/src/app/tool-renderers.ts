import type { ToolRendererResolver } from "@/modules/U1/tool-slots";
import { createToolRegistry } from "@/modules/U3/tool-card/registry";
import { TOOL_RENDERERS } from "@/registry";

/** The app's tool claims. The chat's exact-name map and the prefix resolver below both read it. */
export const toolRegistry = createToolRegistry(TOOL_RENDERERS);

/**
 * U1 asks this for a tool name its exact-name map lacks. A prefix claim (an MCP tool's name) gets its
 * card; a name nothing claims gets T7's fallback card, which shows its arguments and result text.
 */
export const resolveToolRenderer: ToolRendererResolver = (toolName) =>
  toolRegistry.resolve(toolName).renderer;

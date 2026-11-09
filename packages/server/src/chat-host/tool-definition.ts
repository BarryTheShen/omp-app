import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/**
 * The app's own tool as omp's SDK takes a tool definition. omp takes a `customTools` entry for one only when it is marked
 * `__isToolDefinition` (`isCustomTool`, `sdk.ts`; the mark omp's `defineTool` gives its own); an unmarked entry is taken
 * for an older custom tool and called with its arguments in another order, `(id, params, onUpdate, context, signal)`,
 * where the context has no `agent` and the abort signal comes last. Marked, `execute` gets `(id, params, signal,
 * onUpdate, ctx)` with `ctx.agent.kind`: "main" for the chat's own agent, "sub" for a subagent.
 */
export function appToolDefinition(definition: ToolDefinition): ToolDefinition {
  return Object.assign(definition, { __isToolDefinition: true });
}

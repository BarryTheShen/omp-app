import type { EnrichedPartState } from "@assistant-ui/react";
import { createContext, useContext } from "react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import type { ToolRenderer } from "@/modules/U3/tool-card/contract";
import { normalizeToolRendererProps } from "@/modules/U3/tool-card/normalize";

export type ToolRendererMap = Readonly<Record<string, ToolRenderer | undefined>>;

export interface ToolSlotProps {
  readonly part: Extract<EnrichedPartState, { type: "tool-call" }>;
  readonly renderers?: ToolRendererMap;
}

/**
 * Resolves a tool name the exact-name map lacks, such as a prefix claim (an MCP tool's name). The app
 * provides it from its tool registry; without a provider only the exact-name map is used.
 */
export type ToolRendererResolver = (toolName: string) => ToolRenderer | undefined;
export const ToolRendererResolverContext = createContext<ToolRendererResolver | undefined>(
  undefined,
);

/**
 * U1's tool boundary passes an assistant-ui tool part to U3 by tool name: the exact-name map first,
 * then the resolver the app provides. Without a resolver, a name the map lacks keeps the copied generic
 * fallback, which keeps the call visible and inert; U1 never invents a tool lifecycle or executes a call.
 */
export function ToolSlot({ part, renderers }: ToolSlotProps) {
  const state = normalizeToolRendererProps(part);
  const resolve = useContext(ToolRendererResolverContext);
  const Renderer = renderers?.[part.toolName] ?? resolve?.(part.toolName);
  if (Renderer !== undefined) return <Renderer {...part} />;

  return (
    <div
      data-phase={state.phase}
      data-tool-call-id={state.toolCallId}
      data-tool-name={state.toolName}
      data-slot="u1-tool-slot"
    >
      <ToolFallback {...part} />
    </div>
  );
}

import type { EnrichedPartState } from "@assistant-ui/react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import type { ToolRenderer } from "@/modules/U3/tool-card/contract";
import { normalizeToolRendererProps } from "@/modules/U3/tool-card/normalize";

export type ToolRendererMap = Readonly<Record<string, ToolRenderer | undefined>>;

export interface ToolSlotProps {
  readonly part: Extract<EnrichedPartState, { type: "tool-call" }>;
  readonly renderers?: ToolRendererMap;
}

/**
 * U1's tool boundary passes an assistant-ui tool part to U3 by tool name. Until a U3/T module
 * renderer is registered, the copied generic fallback keeps the call visible and inert; U1 never
 * invents a tool lifecycle or executes a call.
 */
export function ToolSlot({ part, renderers }: ToolSlotProps) {
  const state = normalizeToolRendererProps(part);
  const Renderer = renderers?.[part.toolName];
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

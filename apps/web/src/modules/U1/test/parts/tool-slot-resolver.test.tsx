import type { EnrichedPartState } from "@assistant-ui/react";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { ToolRenderer } from "@/modules/U3/tool-card/contract";
import { type ToolRendererResolver, ToolRendererResolverContext, ToolSlot } from "../../tool-slots";

const part = {
  type: "tool-call",
  toolCallId: "call-resolver-1",
  toolName: "mcp__notion_search",
  args: { query: "fixture" },
  argsText: '{"query":"fixture"}',
  status: { type: "complete" },
  result: { content: [{ type: "text", text: "Tool mcp__notion_search not found" }], details: {} },
} as unknown as Extract<EnrichedPartState, { type: "tool-call" }>;

const claimed: ToolRenderer = (props) => <div data-slot="u3-claimed-tool">{props.toolName}</div>;

describe("U1 tool slot resolver", () => {
  test("a name the exact-name map lacks gets the card the resolver returns", () => {
    const resolve: ToolRendererResolver = (toolName) =>
      toolName.startsWith("mcp__") ? claimed : undefined;
    const { container } = render(
      <ToolRendererResolverContext.Provider value={resolve}>
        <ToolSlot part={part} />
      </ToolRendererResolverContext.Provider>,
    );
    expect(container.querySelector('[data-slot="u3-claimed-tool"]')?.textContent).toBe(
      "mcp__notion_search",
    );
    expect(container.querySelector('[data-slot="u1-tool-slot"]')).toBeNull();
  });

  test("the exact-name map wins over the resolver", () => {
    const exact: ToolRenderer = () => <div data-slot="u3-exact-tool" />;
    const resolve: ToolRendererResolver = () => claimed;
    const { container } = render(
      <ToolRendererResolverContext.Provider value={resolve}>
        <ToolSlot part={part} renderers={{ [part.toolName]: exact }} />
      </ToolRendererResolverContext.Provider>,
    );
    expect(container.querySelector('[data-slot="u3-exact-tool"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="u3-claimed-tool"]')).toBeNull();
  });
});

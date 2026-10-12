import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../modules/U3/tool-card/contract";
import { createToolRegistry } from "../modules/U3/tool-card/registry";
import { TOOL_RENDERERS } from "./index";

afterEach(cleanup);

const registry = createToolRegistry(TOOL_RENDERERS);

/** Each tool name issue #717 names resolves to its card; a name nothing claims resolves to T7's fallback. */
describe("tool names resolve to their cards", () => {
  test.each([
    ["ask", "U4.ask"],
    ["web_fetch", "T4.webFetch"],
    ["vibe_spawn", "T5.vibeSpawn"],
    ["recall", "T6.recall"],
    ["xd__recall", "T6.xdRecall"],
    ["retain", "T6.retain"],
    ["xd__retain", "T6.xdRetain"],
    ["mcp__notion_search", "T7.mcp"],
    ["xd__mcp__notion_search", "T7.xdMcp"],
    ["some_unlisted_tool", "T7.host-custom-mcp-tool-fallback"],
  ])("%s resolves to %s", (toolName, id) => {
    expect(registry.resolve(toolName).descriptor?.id).toBe(id);
  });

  test("a name nothing claims renders T7's fallback card with its result text", () => {
    const Renderer = registry.resolve("some_unlisted_tool").renderer;
    const props = {
      type: "tool-call",
      toolCallId: "unclaimed-1",
      toolName: "some_unlisted_tool",
      args: { query: "fixture" },
      argsText: '{"query":"fixture"}',
      result: { content: [{ type: "text", text: "custom result text" }], details: {} },
      isError: false,
      status: { type: "complete" },
    } as unknown as ToolRendererProps;
    const { container } = render(<Renderer {...props} />);
    expandToolCards();
    expect(container.querySelector('[data-testid="t7-fallback-unclaimed-1"]')).toBeTruthy();
    expect(container.textContent).toContain("custom result text");
  });
});

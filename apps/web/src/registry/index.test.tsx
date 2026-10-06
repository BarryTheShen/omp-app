import type { DescriptorId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../modules/U3/tool-card/contract";
import { DESCRIPTORS, RENDERERS, registry, TOOL_RENDERERS } from "./index";

afterEach(cleanup);

describe("the composition index", () => {
  test("registers every composed descriptor exactly once", () => {
    // createRegistry throws at module load on a duplicate id or a double inventory claim, so
    // importing the index already proves the composition is valid; this pins that nothing is dropped.
    expect(registry.byId.size).toBe(DESCRIPTORS.length);
    for (const descriptor of DESCRIPTORS) expect(registry.byId.get(descriptor.id)).toBe(descriptor);
  });

  test("every renderer is keyed by a registered descriptor id", () => {
    // Object.keys widens RendererMap's DescriptorId keys back to string.
    for (const id of Object.keys(RENDERERS))
      expect(registry.byId.has(id as DescriptorId)).toBe(true);
  });

  test("the composed read card renders URL reads through T4's renderer", () => {
    const read = TOOL_RENDERERS.find((descriptor) => descriptor.id === "T1.read");
    if (!read) throw new Error("T1.read is not composed");
    const Read = read.renderer;
    const props = {
      type: "tool-call",
      toolCallId: "read-url-1",
      toolName: "read",
      args: { path: "https://example.com/docs" },
      argsText: '{"path":"https://example.com/docs"}',
      result: { kind: "url", url: "https://example.com/docs", displayContent: { text: "# Docs" } },
      status: { type: "complete" },
    } as unknown as ToolRendererProps;
    render(<Read {...props} />);
    expect(screen.getByTestId("t4-url-read")).toBeTruthy();
    expect(screen.queryByText("URL renderer unavailable")).toBeNull();
  });
});

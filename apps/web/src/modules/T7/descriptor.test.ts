import { ToolDescriptor } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T7_TOOL_DESCRIPTORS } from "./descriptor";

afterEach(cleanup);

describe("T7 descriptors", () => {
  test("claims eight inventory rows, one fallback, and two MCP name prefixes", () => {
    expect(T7_TOOL_DESCRIPTORS).toHaveLength(10);
    expect(
      T7_TOOL_DESCRIPTORS.filter((descriptor) => descriptor.match.by === "fallback"),
    ).toHaveLength(1);
    expect(new Set(T7_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).size).toBe(8);
    expect(
      T7_TOOL_DESCRIPTORS.every((descriptor) => ToolDescriptor.safeParse(descriptor).success),
    ).toBe(true);
  });

  test("keeps exact tool names, MCP prefixes and owner-prefixed ids stable", () => {
    expect(T7_TOOL_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "T7.checkpoint",
      "T7.goal",
      "T7.host-custom-mcp-tool-fallback",
      "T7.mcp",
      "T7.xdMcp",
      "T7.reject",
      "T7.resolve",
      "T7.rewind",
      "T7.securityScan",
      "T7.think",
    ]);
    expect(
      T7_TOOL_DESCRIPTORS.filter((descriptor) => descriptor.match.by === "prefix").map(
        (descriptor) => descriptor.match,
      ),
    ).toEqual([
      { by: "prefix", prefix: "mcp__" },
      { by: "prefix", prefix: "xd__mcp__" },
    ]);
    expect(
      T7_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T7.securityScan")?.match,
    ).toEqual({
      by: "name",
      name: "security_scan",
    });
  });
  test("renders reject calls through the resolve renderer owned by its descriptor", () => {
    const descriptor = T7_TOOL_DESCRIPTORS.find((item) => item.id === "T7.reject");
    if (descriptor === undefined) throw new Error("Reject descriptor is missing");
    const Renderer = descriptor.renderer;
    const args = { action: "discard", reason: "Operator rejected the request" };
    render(
      createElement(Renderer, {
        type: "tool-call",
        toolCallId: "reject-through-descriptor",
        toolName: "reject",
        args,
        argsText: JSON.stringify(args),
        result: {
          content: [
            { type: "text", text: "Discarded: Edit. Reason: Operator rejected the request" },
          ],
          details: {
            action: "discard",
            reason: "Operator rejected the request",
            sourceToolName: "ast_edit",
            label: "Edit",
          },
        },
        status: { type: "complete" },
      } as unknown as ToolRendererProps),
    );
    expandToolCards();
    expect(screen.getByTestId("t7-resolve-status-reject-through-descriptor").textContent).toContain(
      "Rejected",
    );
  });
});

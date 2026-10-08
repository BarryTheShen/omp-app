import { ToolDescriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T7_TOOL_DESCRIPTORS } from "./descriptor";

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
});

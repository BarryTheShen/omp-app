import { describe, expect, test } from "vitest";
import { T3_INVENTORY_COVERS, T3_TOOL_DESCRIPTORS } from "./descriptor";

describe("T3 execution descriptors", () => {
  test("claims exactly the three T3 inventory rows once", () => {
    expect(T3_INVENTORY_COVERS).toEqual(["T3.computer", "T3.debug", "T3.eval"]);
    expect(T3_TOOL_DESCRIPTORS).toHaveLength(3);
    expect(T3_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual(
      T3_INVENTORY_COVERS,
    );
    expect(new Set(T3_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).size).toBe(3);
  });

  test("matches exact tool names and leaves runtime capabilities out of descriptors", () => {
    expect(T3_TOOL_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "name", name: "computer" },
      { by: "name", name: "debug" },
      { by: "name", name: "eval" },
    ]);
    expect(T3_TOOL_DESCRIPTORS.every((descriptor) => descriptor.requires.length === 0)).toBe(true);
    expect(T3_TOOL_DESCRIPTORS.every((descriptor) => descriptor.renderer)).toBe(true);
  });
});

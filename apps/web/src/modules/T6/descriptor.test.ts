import { describe, expect, test } from "vitest";
import { T6_INVENTORY_COVERS, T6_MEMORY_EDIT_CAPABILITY, T6_TOOL_DESCRIPTORS } from "./descriptor";

describe("T6 tool descriptors", () => {
  test("claims exactly the six memory/learning inventory rows once", () => {
    expect(T6_INVENTORY_COVERS).toEqual([
      "T6.learn",
      "T6.manage-skill",
      "T6.memory-edit",
      "T6.recall",
      "T6.reflect",
      "T6.retain",
    ]);
    expect(T6_TOOL_DESCRIPTORS).toHaveLength(6);
    expect(T6_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual(
      T6_INVENTORY_COVERS,
    );
    expect(new Set(T6_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).size).toBe(6);
  });

  test("matches exact omp v18.6.1 tool names and uses U3 fallback renderers", () => {
    expect(T6_TOOL_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "name", name: "learn" },
      { by: "name", name: "manage_skill" },
      { by: "name", name: "memory_edit" },
      { by: "name", name: "recall" },
      { by: "name", name: "reflect" },
      { by: "name", name: "retain" },
    ]);
    expect(T6_TOOL_DESCRIPTORS.every((descriptor) => descriptor.renderer)).toBe(true);
    expect(T6_MEMORY_EDIT_CAPABILITY).toBe("upstream.memory-edit");
  });
});

import type { DescriptorId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS, RENDERERS, registry } from "./index";

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
});

import type { CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ToolRegistryDescriptor, ToolRenderer } from "./contract";
import { createToolRegistry } from "./registry";

const Renderer: ToolRenderer = () => null;

function descriptor(
  id: string,
  match: ToolRegistryDescriptor["match"],
  requires: ToolRegistryDescriptor["requires"] = [],
): ToolRegistryDescriptor {
  return {
    kind: "tool",
    id: id as ToolRegistryDescriptor["id"],
    owner: "U3",
    title: id,
    covers: [],
    requires,
    match,
    renderer: Renderer,
  };
}

describe("createToolRegistry", () => {
  test("resolves exact names before the longest matching prefix, then fallback", () => {
    const exact = descriptor("U3.exact", { by: "name", name: "mcp.search" });
    const shortPrefix = descriptor("U3.short", { by: "prefix", prefix: "mcp." });
    const longPrefix = descriptor("U3.long", { by: "prefix", prefix: "mcp.search." });
    const fallback = descriptor("U3.fallback", { by: "fallback" });
    const registry = createToolRegistry([shortPrefix, fallback, longPrefix, exact]);

    expect(registry.resolve("mcp.search").descriptor?.id).toBe("U3.exact");
    expect(registry.resolve("mcp.search.files").descriptor?.id).toBe("U3.long");
    expect(registry.resolve("mcp.other").descriptor?.id).toBe("U3.short");
    expect(registry.resolve("unknown").descriptor?.id).toBe("U3.fallback");
    expect(registry.resolve("unknown").fallback).toBe(true);
  });

  test("rejects duplicate claims through C0 registry validation", () => {
    expect(() =>
      createToolRegistry([
        descriptor("U3.one", { by: "name", name: "same" }),
        descriptor("U3.two", { by: "name", name: "same" }),
      ]),
    ).toThrow(AppFailure);
  });

  test("reports capability availability without hiding historical renderer resolution", () => {
    const gated = descriptor("U3.gated", { by: "name", name: "gated" }, ["host.test-tool"]);
    const registry = createToolRegistry([gated]);
    const unavailable = registry.resolve("gated");
    const capabilities: CapabilityMap = {
      "host.test-tool": { state: "available", via: "host" },
    };

    expect(unavailable.descriptor?.id).toBe("U3.gated");
    expect(unavailable.available).toBe(false);
    expect(registry.resolve("gated", capabilities).available).toBe(true);
  });
});

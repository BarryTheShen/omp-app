import { describe, expect, test } from "vitest";
import type { ModelCatalogPort, ModelCatalogSnapshot } from "@/modules/D1/contract";
import { executionTierModel } from "./model";

function catalog(snapshot: ModelCatalogSnapshot): ModelCatalogPort {
  return {
    getSnapshot: () => snapshot,
    refresh: async () => ({}) as never,
    apply: async () => ({}) as never,
    subscribe: () => () => undefined,
  };
}
function snapshot(
  efforts: readonly ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")[] = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ],
): ModelCatalogSnapshot {
  return {
    loadState: "ready",
    models: [
      {
        provider: "fake",
        id: "reasoning",
        name: "Reasoning",
        api: "chat-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        thinkingEfforts: [...efforts],
        availability: "available",
      },
    ],
    current: { provider: "fake", modelId: "reasoning" },
    capabilities: {},
    error: null,
  };
}
describe("execution tier model", () => {
  test("projects levels and D1 labels", () => {
    expect(executionTierModel(catalog(snapshot()))?.options).toContainEqual({
      value: "xhigh",
      label: "Extra high",
    });
  });
  test("is absent when loading, no current model, current model missing, or fewer than two efforts", () => {
    expect(executionTierModel(catalog({ ...snapshot(), loadState: "loading" }))).toBeNull();
    expect(executionTierModel(catalog({ ...snapshot(), current: null }))).toBeNull();
    expect(executionTierModel(catalog({ ...snapshot(), models: [] }))).toBeNull();
    expect(executionTierModel(catalog(snapshot(["high"])))).toBeNull();
    expect(executionTierModel(catalog(snapshot([])))).toBeNull();
  });
});

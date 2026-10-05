import type { OmpWire } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ModelCatalogSource } from "../model/catalog";
import { ModelCatalogModel } from "../model/catalog";
import { ModelPicker } from "../model/picker";

function model(provider: string, id: string): OmpWire.ModelInfo {
  return {
    provider,
    id,
    name: id,
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 4_096,
  };
}

function source(): ModelCatalogSource {
  return {
    getAvailableModels: async () => [model("alpha", "one")],
    setModel: async (selected) => model(selected.provider, selected.modelId),
  };
}

afterEach(cleanup);

describe("D1 model picker", () => {
  test("shows the AP6 reason and keeps this-reply controls disabled", async () => {
    const catalog = new ModelCatalogModel({
      source: source(),
      capabilities: {
        "omp.cmd.get_available_models": { state: "available", via: "rpc" },
        "omp.cmd.set_model": { state: "available", via: "rpc" },
      },
    });
    await catalog.refresh();
    render(<ModelPicker catalog={catalog} scope="reply" />);
    expect(screen.getByRole("button", { name: "This reply: not available" })).toBeTruthy();
    expect(screen.getByText("omp has no per-reply model override.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Search this reply" })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "This reply models" })).toBeNull();
    catalog.dispose();
  });
});

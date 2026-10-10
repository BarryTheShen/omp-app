import { CapabilityStatus, type OmpWire } from "@omp-app/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ProviderSignIn } from "@/modules/D3/contract";
import { ModelCatalogModel } from "./catalog";
import { ModelPicker } from "./picker";

afterEach(() => cleanup());

function rawModel(provider: string, id: string): OmpWire.ModelInfo {
  return {
    provider,
    id,
    name: id,
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/** A loaded catalog whose sign-ins are the given map (a provider missing from it has none). */
async function loadedCatalog(
  models: readonly OmpWire.ModelInfo[],
  signIns: ReadonlyMap<string, ProviderSignIn>,
): Promise<ModelCatalogModel> {
  const catalog = new ModelCatalogModel({
    source: {
      getAvailableModels: async () => models,
      setModel: async (model) => rawModel(model.provider, model.modelId),
      readSignIns: async () => signIns,
    },
    capabilities: {
      "omp.cmd.get_available_models": CapabilityStatus.parse({ state: "available", via: "rpc" }),
      "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    },
  });
  await catalog.refresh();
  return catalog;
}

describe("ModelPicker sign-in", () => {
  test("signed-in providers are listed first, and each row says how its provider is signed in", async () => {
    const catalog = await loadedCatalog(
      [
        rawModel("fake", "fake-model"),
        rawModel("anthropic", "claude"),
        rawModel("openai-codex", "codex"),
      ],
      new Map<string, ProviderSignIn>([
        ["anthropic", "api-key"],
        ["openai-codex", "login"],
      ]),
    );
    render(<ModelPicker catalog={catalog} scope="session" />);

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.querySelector("legend")?.textContent)).toEqual([
      "openai-codex",
      "anthropic",
      "fake",
    ]);
    expect(within(groups[0] as HTMLElement).getByText("Signed in with your login")).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText("Uses an API key")).toBeTruthy();
  });

  test("a provider the app cannot tell is listed without any sign-in label", async () => {
    const catalog = await loadedCatalog([rawModel("fake", "fake-model")], new Map());
    render(<ModelPicker catalog={catalog} scope="session" />);
    const group = screen.getByRole("group", { name: "fake" });
    expect(
      within(group).queryByText(/Uses an API key|Signed in with your login|Not signed in/),
    ).toBeNull();
    expect(within(group).getByRole("option", { name: /fake-model/ })).toBeTruthy();
  });
});

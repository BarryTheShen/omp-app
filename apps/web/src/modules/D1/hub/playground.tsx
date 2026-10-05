import type { OmpWire } from "@omp-app/contracts";
import { useEffect, useMemo, useState } from "react";
import type { ModelSettings, ModelSettingsPort, ModelSettingsSnapshot } from "../contract";
import { type LiveModelState, ModelCatalogModel, type ModelCatalogSource } from "../model/catalog";
import { ModelPicker } from "../model/picker";
import { ModelRoleStore } from "../model/roles";
import { ModelHub } from "./model-hub";

const fixtureModels: readonly OmpWire.ModelInfo[] = [
  {
    provider: "alpha",
    id: "reasoner-large",
    name: "Reasoner Large",
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
  },
  {
    provider: "alpha",
    id: "fast-chat",
    name: "Fast Chat",
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    provider: "beta",
    id: "vision-pro",
    name: "Vision Pro",
    api: "responses",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinking: { mode: "effort", efforts: ["medium", "high"] },
  },
];

const fixtureSettings: ModelSettings = {
  enabledModels: ["alpha/reasoner-large", "alpha/fast-chat"],
  enabledProviders: ["alpha"],
  disabledProviders: [],
  modelRoleStorage: "global",
  modelRoles: {
    default: "alpha/reasoner-large",
    smol: "alpha/fast-chat",
  },
  modelPresets: {},
  modelTags: {},
  modelProviderOrder: ["alpha", "beta"],
  cycleOrder: ["smol", "default"],
  defaultThinkingLevel: "auto",
};

function createFixtureSettingsPort(): ModelSettingsPort {
  let snapshot: ModelSettingsSnapshot = {
    settings: fixtureSettings,
    layer: "global",
    revision: "playground-settings-1",
    error: null,
  };
  const listeners = new Set<(next: ModelSettingsSnapshot) => void>();
  return {
    getSnapshot: () => snapshot,
    read: async () => snapshot,
    write: async (settings, expectedRevision) => {
      snapshot = {
        settings,
        layer: "global",
        revision: `${expectedRevision}-next`,
        error: null,
      };
      for (const listener of listeners) listener(snapshot);
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function firstFixtureModel(): OmpWire.ModelInfo {
  const first = fixtureModels[0];
  if (!first) throw new Error("D1 model fixture is empty.");
  return first;
}
function createFixtureSource(): ModelCatalogSource {
  let active = { provider: "alpha", modelId: "reasoner-large" };
  return {
    getAvailableModels: async () => fixtureModels,
    setModel: async (model) => {
      active = model;
      return (
        fixtureModels.find(
          (item) => item.provider === model.provider && item.id === model.modelId,
        ) ?? firstFixtureModel()
      );
    },
    cycleModel: async () => {
      const next =
        fixtureModels.find(
          (model) => model.provider === active.provider && model.id !== active.modelId,
        ) ?? firstFixtureModel();
      active = { provider: next.provider, modelId: next.id };
      return { model: next, isScoped: false };
    },
  };
}

const fixtureLiveState: LiveModelState = {
  getSnapshot: () => ({ model: { provider: "alpha", modelId: "reasoner-large" } }),
  subscribe: () => () => undefined,
};

export function ModelHubPlayground() {
  const [notice, setNotice] = useState("Fixture catalog ready");
  const { catalog, roles } = useMemo(() => {
    const settings = createFixtureSettingsPort();
    const catalog = new ModelCatalogModel({
      source: createFixtureSource(),
      liveState: fixtureLiveState,
      settings,
      mapping: { lockedProviders: new Set(["beta"]) },
      capabilities: {
        "omp.cmd.get_available_models": { state: "available", via: "rpc" },
        "omp.cmd.set_model": { state: "available", via: "rpc" },
        "omp.cmd.cycle_model": { state: "available", via: "rpc" },
      },
    });
    return { catalog, roles: new ModelRoleStore(settings) };
  }, []);
  useEffect(() => {
    return () => {
      catalog.dispose();
      roles.dispose();
    };
  }, [catalog, roles]);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">D1 model controls</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Choose a model for the session or inspect the unavailable one-reply override.
        </p>
        <ModelHub
          catalog={catalog}
          roles={roles}
          onProviderLogin={(provider) => setNotice(`Login flow requested for ${provider}`)}
          onProviderReopen={(provider) => setNotice(`Reopen flow requested for ${provider}`)}
        />
        <section aria-labelledby="d1-session-picker-heading" className="mt-6">
          <h2 id="d1-session-picker-heading" className="mb-2 text-base font-semibold">
            Session picker
          </h2>
          <ModelPicker catalog={catalog} scope="session" title="Session model" />
        </section>
        <section aria-labelledby="d1-reply-picker-heading" className="mt-6">
          <h2 id="d1-reply-picker-heading" className="mb-2 text-base font-semibold">
            This reply picker
          </h2>
          <ModelPicker catalog={catalog} scope="reply" title="This reply" />
        </section>
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {notice}
        </p>
      </div>
    </main>
  );
}

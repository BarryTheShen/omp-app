import type { AppClient } from "@omp-app/client";
import {
  CapabilityStatus,
  type ChatSessionClient,
  type Omp,
  type ThreadId,
} from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import type { LiveModelState, ModelCatalogSource } from ".";
import {
  createR0LiveModelState,
  createRpcModelCatalogSource,
  filterModels,
  ModelCatalogModel,
  modelKey,
  toModelDescriptor,
} from ".";

const threadId = "d1-model-thread" as ThreadId;

function rawModel(
  provider: string,
  id: string,
  options: Partial<Pick<Omp.ModelInfo, "name" | "reasoning" | "thinking">> = {},
): Omp.ModelInfo {
  return {
    provider,
    id,
    name: options.name ?? id,
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: options.reasoning ?? true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...(options.thinking ? { thinking: options.thinking } : {}),
  };
}

function capabilities() {
  return {
    "omp.cmd.get_available_models": CapabilityStatus.parse({ state: "available", via: "omp" }),
    "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "omp" }),
  };
}

function source(overrides: Partial<ModelCatalogSource> = {}): ModelCatalogSource {
  return {
    getAvailableModels: async () => [rawModel("alpha", "one"), rawModel("beta", "two")],
    setModel: async (model) => rawModel(model.provider, model.modelId),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("D1 model catalog projection", () => {
  test("filters models by their details and marks locked providers", () => {
    const models = [
      toModelDescriptor(rawModel("beta", "slow", { name: "Slow" })),
      toModelDescriptor(rawModel("alpha", "fast", { name: "Fast" })),
      toModelDescriptor(rawModel("alpha", "vision", { name: "Vision" })),
    ];
    expect(filterModels(models, "vision").map((model) => model.id)).toEqual(["vision"]);
    expect(
      toModelDescriptor(rawModel("locked", "one"), { lockedProviders: new Set(["locked"]) }),
    ).toMatchObject({
      availability: "locked",
      loginProvider: "locked",
    });
    expect(modelKey({ provider: "alpha", modelId: "fast" })).toBe("alpha/fast");
  });

  test("session picker calls set_model exactly once and follows R0 live updates", async () => {
    const calls: string[] = [];
    let current: {
      readonly model: { readonly provider: string; readonly modelId: string } | null;
    } = {
      model: { provider: "alpha", modelId: "one" },
    };
    const listeners = new Set<(snapshot: typeof current) => void>();
    const live: LiveModelState = {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const modelSource = source({
      setModel: async (model) => {
        calls.push(`${model.provider}/${model.modelId}`);
        return rawModel(model.provider, model.modelId);
      },
    });
    const model = new ModelCatalogModel({
      source: modelSource,
      capabilities: capabilities(),
      liveState: live,
    });
    await model.refresh();
    await model.apply({ model: { provider: "beta", modelId: "two" }, scope: "session" });
    expect(calls).toEqual(["beta/two"]);
    current = { model: { provider: "alpha", modelId: "one" } };
    for (const listener of listeners) listener(current);
    expect(model.getSnapshot().current).toEqual(current.model);
    model.dispose();
  });
  test("adapts R0 snapshot subscriptions without polling get_state", () => {
    let state: { readonly model: Omp.ModelInfo | null } = {
      model: rawModel("alpha", "one"),
    };
    const listeners = new Set<() => void>();
    const live = createR0LiveModelState({
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    expect(live.getSnapshot()).toEqual({ model: { provider: "alpha", modelId: "one" } });
    let update: { readonly provider: string; readonly modelId: string } | null = null;
    const remove = live.subscribe((snapshot) => {
      update = snapshot.model;
    });
    state = { model: rawModel("beta", "two") };
    for (const listener of listeners) listener();
    expect(update).toEqual({ provider: "beta", modelId: "two" });
    remove();
  });

  test("reply scope stays disabled with the AP6 reason and never calls set_model", async () => {
    const calls: string[] = [];
    const model = new ModelCatalogModel({
      source: source({
        setModel: async (selected) => {
          calls.push(modelKey(selected));
          return rawModel(selected.provider, selected.modelId);
        },
      }),
      capabilities: { "omp.cmd.set_model": capabilities()["omp.cmd.set_model"] },
    });
    await expect(
      model.apply({ model: { provider: "alpha", modelId: "one" }, scope: "reply" }),
    ).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        capability: "upstream.model-per-prompt",
        message: "omp has no per-reply model override.",
      },
    });
    expect(calls).toEqual([]);
    model.dispose();
  });
});

describe("D1 model source on the chat session port", () => {
  test("routes catalog and session selection through the chat session port", async () => {
    const calls: unknown[] = [];
    const session = {
      request: async (args: unknown) => {
        calls.push(args);
        const { method } = args as { readonly method: string };
        if (method === "get_available_models") return { models: [rawModel("alpha", "one")] };
        return rawModel("alpha", "one");
      },
    } as unknown as ChatSessionClient;
    const client = {
      port: () => session,
    } as unknown as AppClient;
    const source = createRpcModelCatalogSource(client, threadId);
    await source.getAvailableModels();
    await source.setModel({ provider: "alpha", modelId: "one" });
    expect(calls).toEqual([
      { threadId, method: "get_available_models", params: {} },
      { threadId, method: "set_model", params: { provider: "alpha", modelId: "one" } },
    ]);
  });
});

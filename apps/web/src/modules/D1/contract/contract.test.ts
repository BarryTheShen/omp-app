import { AppError, CapabilityStatus, Revision } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  ConfiguredThinkingLevel,
  D1_CAPABILITIES,
  DEFAULT_MODEL_SCOPE_AVAILABILITY,
  EffortLevel,
  ModelApplyRequest,
  ModelCatalogSnapshot,
  ModelDescriptor,
  ModelPresets,
  ModelRef,
  ModelRoles,
  ModelScopeAvailability,
  ModelSettings,
  modelScopeAvailability,
  ThinkingLevel,
  ThinkingLevelsResult,
} from ".";

const model = {
  provider: "provider-a",
  id: "model-a",
  name: "Model A",
  api: "chat-completions",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingEfforts: ["low", "high"],
  availability: "available" as const,
};

const settings = {
  enabledModels: ["provider-a/model-a"],
  enabledProviders: ["provider-a"],
  disabledProviders: [],
  modelRoleStorage: "global" as const,
  modelRoles: {
    default: "provider-a/model-a",
    slow: { provider: "provider-a", modelId: "model-a" },
  },
  modelPresets: {
    balanced: {
      modelRoles: { default: "provider-a/model-a" },
      defaultThinkingLevel: "medium" as const,
    },
  },
  modelTags: { fast: { name: "Fast", hidden: false } },
  modelProviderOrder: ["provider-a"],
  cycleOrder: ["smol", "default", "slow"],
  defaultThinkingLevel: "auto" as const,
};

describe("D1 model scope semantics", () => {
  test("reply scope is visibly unavailable without AP6 and never suggests set/restore", () => {
    const availability = modelScopeAvailability("reply", {});
    expect(availability).toEqual({
      state: "unavailable",
      scope: "reply",
      capability: "upstream.model-per-prompt",
      reason: "omp has no per-reply model override.",
    });
    expect(DEFAULT_MODEL_SCOPE_AVAILABILITY[0]).toEqual(availability);
    expect(ModelScopeAvailability.safeParse(availability).success).toBe(true);
  });

  test("session and default scopes use their typed capability gates", () => {
    const capabilities = {
      "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
      "host.config": CapabilityStatus.parse({ state: "available", via: "host" }),
    };
    expect(modelScopeAvailability("session", capabilities)).toMatchObject({
      state: "available",
      scope: "session",
      capability: "omp.cmd.set_model",
    });
    expect(modelScopeAvailability("default", capabilities)).toMatchObject({
      state: "available",
      scope: "default",
      capability: "host.config",
    });
  });
});

describe("D1 model and thinking DTOs", () => {
  test("accepts safe model metadata and rejects raw provider secrets/headers", () => {
    expect(ModelDescriptor.parse(model)).toMatchObject({ id: "model-a", provider: "provider-a" });
    expect(
      ModelDescriptor.safeParse({ ...model, headers: { Authorization: "not allowed" } }).success,
    ).toBe(false);
    expect(ModelRef.safeParse({ provider: "provider-a", modelId: "model-a" }).success).toBe(true);
  });

  test("keeps supported thinking levels separate from configured auto", () => {
    expect(ThinkingLevel.safeParse("inherit").success).toBe(true);
    expect(ThinkingLevel.safeParse("auto").success).toBe(false);
    expect(ConfiguredThinkingLevel.safeParse("auto").success).toBe(true);
    expect(EffortLevel.safeParse("max").success).toBe(true);
    expect(
      ThinkingLevelsResult.parse({
        levels: ["off", "low", "high"],
        current: "low",
        configured: "auto",
        reasoning: true,
        revision: null,
      }),
    ).toMatchObject({ levels: ["off", "low", "high"], configured: "auto" });
  });

  test("models loading/error states and capabilities are typed", () => {
    const snapshot = ModelCatalogSnapshot.parse({
      loadState: "loading",
      models: [],
      current: null,
      capabilities: {
        "omp.cmd.get_available_models": { state: "available", via: "rpc" },
      },
      error: null,
    });
    expect(snapshot.loadState).toBe("loading");
    expect(
      ModelCatalogSnapshot.safeParse({
        ...snapshot,
        error: AppError.parse({
          code: "timeout",
          message: "timed out",
          retryable: true,
        }),
      }).success,
    ).toBe(true);
    expect(D1_CAPABILITIES).toContain("upstream.model-per-prompt");
  });
});

describe("D1 persisted roles and presets", () => {
  test("preserves role assignments, preset snapshots and global/project storage", () => {
    expect(ModelRoles.parse(settings.modelRoles)).toMatchObject({ default: "provider-a/model-a" });
    expect(ModelPresets.parse(settings.modelPresets).balanced?.defaultThinkingLevel).toBe("medium");
    expect(ModelSettings.parse(settings).modelRoleStorage).toBe("global");
    expect(
      ModelApplyRequest.parse({
        model: { provider: "provider-a", modelId: "model-a" },
        scope: "default",
        thinkingLevel: "high",
      }),
    ).toMatchObject({ scope: "default" });
    expect(Revision.safeParse("revision-1").success).toBe(true);
  });
});

import type { CapabilityKey, OmpCommandMap } from "@omp-app/contracts";
import {
  AppError as AppErrorSchema,
  CapabilityStatus as CapabilityStatusSchema,
  Revision,
} from "@omp-app/contracts";
import { z } from "zod";

/** Product scopes from PLAN.md/D1: reply is AP6-gated, session is live omp state, default is config. */
export const ModelScope = z.enum(["reply", "session", "default"]);
export type ModelScope = z.infer<typeof ModelScope>;

export const ThinkingLevel = z.enum([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

export const EffortLevel = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ConfiguredThinkingLevel = z.enum([
  "auto",
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ConfiguredThinkingLevel = z.infer<typeof ConfiguredThinkingLevel>;
export const MODEL_SCOPE_AP6_CAPABILITY = "upstream.model-per-prompt" as const;
export const MODEL_SCOPE_AP6_REASON = "omp has no per-reply model override." as const;

export const ModelErrorCode = z.enum([
  "invalid-model",
  "unavailable",
  "loading",
  "conflict",
  "rpc",
  "config",
]);
export type ModelErrorCode = z.infer<typeof ModelErrorCode>;

export const ModelError = z.strictObject({
  code: ModelErrorCode,
  message: z.string().min(1),
  retryable: z.boolean(),
  scope: ModelScope.optional(),
  capability: z.string().min(1).optional(),
});
export type ModelError = z.infer<typeof ModelError>;

export const ModelScopeAvailability = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    scope: ModelScope,
    capability: z.string().min(1).optional(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    scope: ModelScope,
    capability: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type ModelScopeAvailability = z.infer<typeof ModelScopeAvailability>;

export const ModelRef = z.strictObject({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

/** Safe browser model metadata derived from A0.1 `OmpWire.ModelInfo` (rpc-wire.generated.ts:346-367);
 * headers/baseUrl/cost/compat never cross this boundary. */
export const ModelDescriptor = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(z.string().min(1)),
  contextWindow: z.number().int().nonnegative().nullable(),
  maxTokens: z.number().int().nonnegative().nullable(),
  thinkingEfforts: z.array(EffortLevel),
  availability: z.enum(["available", "locked", "unavailable"]),
  loginProvider: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

export const ModelCatalogLoadState = z.enum(["idle", "loading", "ready", "error"]);
export type ModelCatalogLoadState = z.infer<typeof ModelCatalogLoadState>;

export const D1_CAPABILITIES = [
  "omp.cmd.get_available_models",
  "omp.cmd.set_model",
  "omp.cmd.cycle_model",
  "omp.cmd.get_available_thinking_levels",
  "omp.cmd.set_thinking_level",
  "omp.cmd.cycle_thinking_level",
  "host.config",
  "host.command-gateway",
  MODEL_SCOPE_AP6_CAPABILITY,
] as const satisfies readonly CapabilityKey[];
export type D1ModelRpcCommand =
  | "get_available_models"
  | "set_model"
  | "cycle_model"
  | "get_available_thinking_levels"
  | "set_thinking_level"
  | "cycle_thinking_level";
export type D1ModelRpcResults = Pick<OmpCommandMap, D1ModelRpcCommand>;
export const ModelCapability = z.enum(D1_CAPABILITIES);
export type ModelCapability = z.infer<typeof ModelCapability>;
export const ModelCapabilities = z.partialRecord(ModelCapability, CapabilityStatusSchema);
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const ModelCatalogSnapshot = z.strictObject({
  loadState: ModelCatalogLoadState,
  models: z.array(ModelDescriptor),
  current: ModelRef.nullable(),
  capabilities: ModelCapabilities,
  error: AppErrorSchema.nullable(),
});
export type ModelCatalogSnapshot = z.infer<typeof ModelCatalogSnapshot>;

export const ModelCatalogResult = z.strictObject({
  models: z.array(ModelDescriptor),
  current: ModelRef.nullable(),
  capabilities: ModelCapabilities,
  revision: Revision,
});
export type ModelCatalogResult = z.infer<typeof ModelCatalogResult>;

export const ModelApplyRequest = z.strictObject({
  model: ModelRef,
  scope: ModelScope,
  thinkingLevel: ThinkingLevel.optional(),
});
export type ModelApplyRequest = z.infer<typeof ModelApplyRequest>;

export const ModelApplyResult = z.strictObject({
  model: ModelRef,
  scope: ModelScope,
  thinkingLevel: ThinkingLevel.optional(),
  revision: Revision.nullable(),
});
export type ModelApplyResult = z.infer<typeof ModelApplyResult>;

export const ThinkingLevelsSnapshot = z.strictObject({
  loadState: ModelCatalogLoadState,
  levels: z.array(ThinkingLevel),
  current: ThinkingLevel.nullable(),
  configured: ConfiguredThinkingLevel.nullable(),
  reasoning: z.boolean(),
  error: AppErrorSchema.nullable(),
});
export type ThinkingLevelsSnapshot = z.infer<typeof ThinkingLevelsSnapshot>;

export const ThinkingLevelsResult = z.strictObject({
  levels: z.array(ThinkingLevel),
  current: ThinkingLevel.nullable(),
  configured: ConfiguredThinkingLevel.nullable(),
  reasoning: z.boolean(),
  revision: Revision.nullable(),
});
export type ThinkingLevelsResult = z.infer<typeof ThinkingLevelsResult>;

export const ThinkingApplyRequest = z.strictObject({
  level: ThinkingLevel,
  scope: z.literal("session"),
});
export type ThinkingApplyRequest = z.infer<typeof ThinkingApplyRequest>;

export const ThinkingCycleDirection = z.enum(["forward", "backward"]);
export type ThinkingCycleDirection = z.infer<typeof ThinkingCycleDirection>;

export const ModelRoleSelector = z.union([z.string().min(1), ModelRef]);
export type ModelRoleSelector = z.infer<typeof ModelRoleSelector>;
export const ModelRoles = z.record(z.string().min(1), ModelRoleSelector);
export type ModelRoles = z.infer<typeof ModelRoles>;

export const ModelTag = z.strictObject({
  name: z.string().min(1),
  color: z.string().min(1).optional(),
  hidden: z.boolean().optional(),
});
export type ModelTag = z.infer<typeof ModelTag>;
export const ModelTags = z.record(z.string().min(1), ModelTag);
export type ModelTags = z.infer<typeof ModelTags>;

/** Matches omp v18.6.1 model-settings.ts:13-57 (`modelPresets` record values). */
export const ModelPreset = z.strictObject({
  modelRoles: z.record(z.string().min(1), z.string().min(1)),
  defaultThinkingLevel: ConfiguredThinkingLevel.optional(),
});
export type ModelPreset = z.infer<typeof ModelPreset>;
export const ModelPresets = z.record(z.string().min(1), ModelPreset);
export type ModelPresets = z.infer<typeof ModelPresets>;

export const ModelRoleStorage = z.enum(["global", "project"]);
export type ModelRoleStorage = z.infer<typeof ModelRoleStorage>;

/** Persisted model settings owned by the D1 S2 sections; A1 ConfigStore is the writer. */
export const ModelSettings = z.strictObject({
  enabledModels: z.array(z.string().min(1)),
  enabledProviders: z.array(z.string().min(1)),
  disabledProviders: z.array(z.string().min(1)),
  modelRoleStorage: ModelRoleStorage,
  modelRoles: ModelRoles,
  modelPresets: ModelPresets,
  modelTags: ModelTags,
  modelProviderOrder: z.array(z.string().min(1)),
  cycleOrder: z.array(z.string().min(1)),
  defaultThinkingLevel: ConfiguredThinkingLevel.optional(),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

export const ModelSettingsLayer = z.enum(["global", "project"]);
export type ModelSettingsLayer = z.infer<typeof ModelSettingsLayer>;

export const ModelSettingsSnapshot = z.strictObject({
  settings: ModelSettings,
  layer: ModelSettingsLayer,
  revision: Revision,
  error: AppErrorSchema.nullable(),
});
export type ModelSettingsSnapshot = z.infer<typeof ModelSettingsSnapshot>;
